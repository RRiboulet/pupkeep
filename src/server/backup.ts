// The backup job PLAN §7.5 assigns to P1-07: one encrypted bundle of
// `pupkeep.sqlite` + `config.json` + `push.json`, copied off-device, with
// 14-day retention and a passphrase that is deliberately not stored beside it.
//
// Three properties are worth stating because they are what makes this more than
// a tar wrapper:
//
//   * the SQLite copy is made by SQLite's own online backup API, never by
//     copying `-wal`/`-shm` by hand, and it is integrity-checked *after* the
//     copy (P0-07 measured a live `.backup` that passed its exit code while
//     missing the newest commit);
//   * the archive is decrypted and checked again after encryption, so a wrong
//     passphrase or a truncated upload is found now rather than at restore time;
//   * a restore refuses to run while either pid lock is live, and removes the
//     stale WAL/SHM files before installing the bundle.
//
// The passphrase is a parameter, not a file this module writes. The CLI reads
// it from an environment variable or an explicit file outside the data and
// backup directories; §7.5's "off the backup host" is an operational rule the
// job enforces where it can and documents where it cannot.

import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { emptyPush, parseConfig, parsePush, dataPaths } from "./config.ts";
import { atomicWrite } from "./json-file.ts";
import { acquireLock, inspectLock, LOCK_FILE, SERVER_LOCK_FILE, type LockHandle } from "./lock.ts";
import { TABLE_PREFIX } from "./harness.ts";
import { scrub } from "../shared/redact.ts";

/** PLAN §7.5's backup set, in the order the archive lists them. */
export const BACKUP_FILES = ["pupkeep.sqlite", "config.json", "push.json"] as const;
export const RETENTION_DAYS = 14;
export const DEFAULT_PASSPHRASE_ENV = "PUPKEEP_BACKUP_PASSPHRASE";
export const DEFAULT_OLD_PASSPHRASE_ENV = "PUPKEEP_OLD_BACKUP_PASSPHRASE";

const ARCHIVE = /^pupkeep-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tar\.gz\.age$/;
const SQLITE_WAL = "pupkeep.sqlite-wal";
const SQLITE_SHM = "pupkeep.sqlite-shm";

/** Operational status, not part of the backup bundle. */
export const BACKUP_STATUS_FILE = "status.json";

// --- command running -------------------------------------------------------

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Injected in tests so no test needs a real tarball, remote or encryption key. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

const OUTPUT_LIMIT = 256 * 1024;

/** Run a host helper without a shell, with bounded captured output. */
export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (captured >= OUTPUT_LIMIT) return;
      const room = OUTPUT_LIMIT - captured;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(slice);
      captured += slice.length;
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`could not run ${command}: ${error.message}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

export async function checkBackupTools(run: CommandRunner, needsRemote: boolean): Promise<void> {
  const tools: Array<[string, readonly string[]]> = [
    ["tar", ["--version"]],
    ["age", ["--version"]],
    ["expect", ["-c", "exit 0"]],
  ];
  if (needsRemote) tools.push(["rclone", ["version"]]);
  for (const [command, args] of tools) {
    const result = await run(command, args);
    if (result.code !== 0) {
      throw new Error(`${command} is not available (exit ${result.code}); install it before backing up`);
    }
  }
}

// --- encryption ------------------------------------------------------------

export interface ArchiveCipher {
  encrypt(input: string, output: string, passphrase: string): Promise<void>;
  decrypt(input: string, output: string, passphrase: string): Promise<void>;
}

/**
 * age's passphrase mode reads from the controlling terminal, not stdin, so a
 * pipe cannot answer it. `expect` supplies a PTY and answers both the "enter"
 * and "confirm" prompts; `log_user 0` keeps the echoed passphrase out of the
 * captured output, which is the one place it must never appear.
 */
export function ageCipher(run: CommandRunner = runCommand): ArchiveCipher {
  const script = (decrypt: boolean): string =>
    [
      "set timeout 120",
      "log_user 0",
      `spawn age ${decrypt ? "-d" : "-p"} -o $env(PUPKEEP_AGE_OUT) $env(PUPKEEP_AGE_IN)`,
      "expect {",
      '  -re "(?i)(enter|confirm) passphrase" { send -- "$env(PUPKEEP_AGE_PASS)\\r"; exp_continue }',
      "  eof",
      "}",
      "catch wait result",
      "exit [lindex $result 3]",
    ].join("\n");

  const runAge = async (
    mode: "encrypt" | "decrypt",
    input: string,
    output: string,
    passphrase: string,
  ): Promise<void> => {
    const result = await run("expect", ["-c", script(mode === "decrypt")], {
      env: {
        PUPKEEP_AGE_IN: resolve(input),
        PUPKEEP_AGE_OUT: resolve(output),
        PUPKEEP_AGE_PASS: passphrase,
      },
    });
    if (result.code !== 0) {
      // Deliberately no stderr: it is the one stream that could carry the
      // passphrase if expect's echo suppression ever changed.
      throw new Error(`age could not ${mode} ${basename(input)} (exit ${result.code})`);
    }
    const info = await stat(output).catch(() => undefined);
    if (!info?.isFile() || info.size === 0) {
      throw new Error(`age reported success but wrote no ${mode === "encrypt" ? "archive" : "plaintext"}`);
    }
  };

  return {
    encrypt: (input, output, passphrase) => runAge("encrypt", input, output, passphrase),
    decrypt: (input, output, passphrase) => runAge("decrypt", input, output, passphrase),
  };
}

// --- passphrase ------------------------------------------------------------

export interface PassphraseSource {
  dataDir: string;
  backupDir: string;
  envName?: string;
  file?: string;
  env?: NodeJS.ProcessEnv;
}

export function validatePassphrase(passphrase: string): void {
  if (passphrase.length < 16 || passphrase.trim().length < 16) {
    throw new Error("the backup passphrase must be at least 16 non-whitespace characters");
  }
  // age's prompt is answered over a PTY; a newline or NUL would end the answer
  // early and silently encrypt the rest of the archive with the wrong secret.
  if (/[\u0000-\u001f\u007f]/.test(passphrase)) {
    throw new Error("the backup passphrase must not contain control characters");
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realOrResolved(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/**
 * Read the passphrase from exactly one source. A passphrase file inside the
 * data or backup directory is refused: that is the archive sitting beside its
 * own key, which PLAN §7.5 names as the pattern not to copy from P0-07.
 */
export async function readPassphrase(source: PassphraseSource): Promise<string> {
  const envName = source.envName ?? DEFAULT_PASSPHRASE_ENV;
  const env = source.env ?? process.env;
  const fromEnv = env[envName];
  const file = source.file;

  if (fromEnv !== undefined && fromEnv !== "" && file !== undefined) {
    throw new Error(`choose one passphrase source: ${envName} or --passphrase-file, not both`);
  }

  let passphrase: string;
  if (file !== undefined) {
    const absolute = resolve(file);
    const realFile = await realOrResolved(absolute);
    const dataDir = await realOrResolved(source.dataDir);
    const backupDir = await realOrResolved(source.backupDir);
    if (isInside(realFile, dataDir) || isInside(realFile, backupDir)) {
      throw new Error("the passphrase file is inside the data or backup directory; keep it off the backup host");
    }
    const text = await readFile(realFile, "utf8").catch((error: unknown) => {
      throw new Error(`could not read the passphrase file: ${(error as Error).message}`);
    });
    passphrase = text.replace(/\r?\n$/, "");
    if (passphrase.includes("\n") || passphrase.includes("\r")) {
      throw new Error("the passphrase file must contain one line");
    }
  } else if (fromEnv !== undefined && fromEnv !== "") {
    passphrase = fromEnv;
  } else {
    throw new Error(
      `no backup passphrase: set ${envName} or pass --passphrase-file outside the data and backup directories`,
    );
  }

  validatePassphrase(passphrase);
  return passphrase;
}

// --- archive names and retention ------------------------------------------

export function backupArchiveName(now: Date): string {
  const iso = now.toISOString().replace(/[-:]/g, "");
  // 2026-10-29T16:30:00.000Z -> 20261029T163000Z
  return `pupkeep-${iso.slice(0, 15)}Z.tar.gz.age`;
}

export function isBackupArchive(name: string): boolean {
  return ARCHIVE.test(name);
}

export function parseArchiveTime(name: string): number | undefined {
  const match = ARCHIVE.exec(name);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const time = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const date = new Date(time);
  // Reject 20261301T000000Z and friends instead of silently rolling over.
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  ) {
    return undefined;
  }
  return time;
}

/**
 * Archives older than the retention window, newest excluded.
 *
 * "Never the newest" is deliberate: a host that was off for a month must not
 * wake up to a job that deletes its only backup. Retention is a cleanup, not a
 * reason to make the data less recoverable.
 */
export function expiredArchives(
  names: readonly string[],
  now: Date,
  retentionDays: number = RETENTION_DAYS,
): string[] {
  const dated = names
    .map((name) => ({ name, time: parseArchiveTime(name) }))
    .filter((entry): entry is { name: string; time: number } => entry.time !== undefined)
    .sort((a, b) => a.time - b.time);
  if (dated.length <= 1) return [];

  const keep = dated.at(-1)!;
  const cutoff = now.getTime() - Math.max(0, retentionDays) * 86_400_000;
  return dated
    .filter((entry) => entry !== keep && entry.time < cutoff)
    .map((entry) => entry.name);
}

// --- status ----------------------------------------------------------------

/**
 * The app needs to show a failed backup rather than leave it in a log
 * (PLAN §7.5). The job writes this small file through the same atomic JSON
 * write path as the rest of the data directory; the notification centre
 * (P4-05) is its reader. It is deliberately outside the backup set and holds no
 * passphrase, provider key or archive contents.
 */
export interface BackupStatus {
  schemaVersion: 1;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastArchive: string | null;
  lastError: string | null;
}

export function emptyBackupStatus(now: Date = new Date()): BackupStatus {
  return {
    schemaVersion: 1,
    lastAttemptAt: now.toISOString(),
    lastSuccessAt: null,
    lastArchive: null,
    lastError: null,
  };
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function parseBackupStatus(raw: unknown): BackupStatus | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) return undefined;
  if (!isIsoDate(record.lastAttemptAt)) return undefined;
  if (record.lastSuccessAt !== null && !isIsoDate(record.lastSuccessAt)) return undefined;
  if (record.lastArchive !== null && typeof record.lastArchive !== "string") return undefined;
  if (record.lastError !== null && typeof record.lastError !== "string") return undefined;
  return {
    schemaVersion: 1,
    lastAttemptAt: record.lastAttemptAt,
    lastSuccessAt: record.lastSuccessAt as string | null,
    lastArchive: record.lastArchive as string | null,
    lastError: record.lastError as string | null,
  };
}

export async function readBackupStatus(backupDir: string): Promise<BackupStatus | undefined> {
  try {
    return parseBackupStatus(JSON.parse(await readFile(join(backupDir, BACKUP_STATUS_FILE), "utf8")));
  } catch {
    // A missing or unreadable status is not a backup failure; the next run
    // replaces it.
    return undefined;
  }
}

export async function writeBackupStatus(backupDir: string, status: BackupStatus): Promise<void> {
  await ensurePrivateDirectory(backupDir);
  await atomicWrite(join(backupDir, BACKUP_STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function failureStatus(previous: BackupStatus | undefined, error: unknown, now: Date): BackupStatus {
  return {
    schemaVersion: 1,
    lastAttemptAt: now.toISOString(),
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastArchive: previous?.lastArchive ?? null,
    // Scrubbed for the same reason log lines are: this text is rendered in the
    // app, and an error can carry a path or an opaque token.
    lastError: scrub(error instanceof Error ? error.message : String(error)),
  };
}

// --- rclone ----------------------------------------------------------------

export function normalizeRemote(remote: string): string {
  const trimmed = remote.trim();
  if (trimmed === "") throw new Error("the rclone remote is empty");
  if (trimmed.startsWith("-")) throw new Error("the rclone remote must not start with '-'");
  if (!/^[A-Za-z0-9_.+-]+:/.test(trimmed)) {
    throw new Error("the rclone remote must look like remote:path");
  }
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error("the rclone remote contains whitespace or a control character");
  }
  return trimmed.endsWith(":") ? trimmed : trimmed.replace(/\/+$/, "");
}

export function remotePath(remote: string, name: string): string {
  return remote.endsWith(":") ? `${remote}${name}` : `${remote}/${name}`;
}

async function listRemoteArchives(run: CommandRunner, remote: string): Promise<string[]> {
  const result = await run("rclone", ["lsf", "--files-only", remote]);
  if (result.code !== 0) {
    throw new Error(`rclone could not list ${remote} (exit ${result.code})`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => basename(line.trim()))
    .filter((name) => isBackupArchive(name));
}

// --- filesystem helpers ----------------------------------------------------

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported on some filesystems; the file fsync still
    // happened, and failing the whole backup here would be worse than the gap.
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writePrivate(path: string, text: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function sweepStaging(backupDir: string, now: Date): Promise<void> {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(".staging-") && !name.startsWith("restore-staging-")) continue;
    const path = join(backupDir, name);
    const info = await stat(path).catch(() => undefined);
    if (info && now.getTime() - info.mtimeMs > 3_600_000) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// --- SQLite copy and verification ------------------------------------------

interface DatabaseCopy {
  expectedSeq: number;
  copiedSeq: number;
}

function readNextSeq(db: DatabaseSync): number {
  // `next_seq` is the storage's "every sequence below this is durable"
  // watermark; P0-07's caveat is that a live copy can lag it.
  const row = db
    .prepare(`SELECT next_seq FROM ${TABLE_PREFIX}durable_metadata WHERE singleton = 1`)
    .get() as { next_seq?: unknown } | undefined;
  const value = Number(row?.next_seq);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("the database has no Pi Durable metadata; is this a Pupkeep database?");
  }
  return value;
}

/** Copy one live SQLite database with SQLite's backup API and check the copy. */
export async function copyDatabase(source: string, destination: string): Promise<DatabaseCopy> {
  await rm(`${destination}-wal`, { force: true });
  await rm(`${destination}-shm`, { force: true });

  const sourceDb = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
  let expectedSeq: number;
  try {
    sourceDb.exec("PRAGMA busy_timeout = 5000");
    expectedSeq = readNextSeq(sourceDb);
    await backup(sourceDb, destination);
  } finally {
    sourceDb.close();
  }

  const copyDb = new DatabaseSync(destination, { readOnly: true });
  let copiedSeq: number;
  try {
    const check = copyDb.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    if (check?.integrity_check !== "ok") {
      throw new Error(`the database copy failed integrity_check: ${String(check?.integrity_check)}`);
    }
    copiedSeq = readNextSeq(copyDb);
  } finally {
    copyDb.close();
  }
  if (copiedSeq < expectedSeq) {
    // A live .backup can restart on concurrent writes; it must still contain
    // every commit that was already durable when the job started.
    throw new Error(
      `the database copy is behind the source (copied seq ${copiedSeq}, expected at least ${expectedSeq})`,
    );
  }
  return { expectedSeq, copiedSeq };
}

function verifyConfigText(text: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`config.json is not valid JSON (${(error as Error).message})`);
  }
  if (parseConfig(raw) === undefined) {
    throw new Error("config.json does not match the shape this build understands");
  }
}

function verifyPushText(text: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`push.json is not valid JSON (${(error as Error).message})`);
  }
  if (parsePush(raw) === undefined) {
    throw new Error("push.json does not match the shape this build understands");
  }
}

// --- tar -------------------------------------------------------------------

function expectedFiles(files: readonly string[]): string[] {
  return [...files].sort();
}

async function listTar(run: CommandRunner, tarPath: string): Promise<string[]> {
  const result = await run("tar", ["-tzf", tarPath]);
  if (result.code !== 0) throw new Error(`tar could not list the bundle (exit ${result.code})`);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/^\.\//, "").trim())
    .filter((line) => line !== "");
}

async function createTar(run: CommandRunner, directory: string, tarPath: string): Promise<void> {
  const result = await run("tar", ["-czf", tarPath, "-C", directory, ...BACKUP_FILES]);
  if (result.code !== 0) throw new Error(`tar could not create the bundle (exit ${result.code})`);
  await chmod(tarPath, 0o600);
  await fsyncFile(tarPath);
}

async function extractTar(run: CommandRunner, tarPath: string, directory: string): Promise<void> {
  const result = await run("tar", ["-xzf", tarPath, "-C", directory]);
  if (result.code !== 0) throw new Error(`tar could not extract the bundle (exit ${result.code})`);
}

// --- archive inspection ----------------------------------------------------

export interface StagedArchive {
  /** Owner of the extraction directory; cleanup removes it. */
  readonly root: string;
  readonly directory: string;
  readonly seq: number;
  cleanup(): Promise<void>;
}

export interface ArchiveDeps {
  run?: CommandRunner;
  cipher?: ArchiveCipher;
}

async function verifyExtracted(directory: string, expectedSeq?: number): Promise<number> {
  for (const name of BACKUP_FILES) {
    const info = await lstat(join(directory, name)).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error(`the bundle's ${name} is not a regular file`);
    }
  }

  const dbPath = join(directory, "pupkeep.sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let seq: number;
  try {
    const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    if (check?.integrity_check !== "ok") {
      throw new Error(`the restored database failed integrity_check: ${String(check?.integrity_check)}`);
    }
    seq = readNextSeq(db);
  } finally {
    db.close();
  }
  // Opening a WAL database creates these beside it; they are not bundle members
  // and must not be copied into a restored data directory.
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
  if (expectedSeq !== undefined && seq < expectedSeq) {
    throw new Error(`the archived database is behind the source (seq ${seq}, expected at least ${expectedSeq})`);
  }

  verifyConfigText(await readFile(join(directory, "config.json"), "utf8"));
  verifyPushText(await readFile(join(directory, "push.json"), "utf8"));
  return seq;
}

/**
 * Decrypt an archive into a private temporary directory and verify it:
 * exactly the three §7.5 files, a regular file for each, `integrity_check`,
 * the durable-sequence watermark, and both JSON schemas. The caller must
 * `cleanup()` the result.
 */
export async function stageArchive(
  archive: string,
  passphrase: string,
  deps: ArchiveDeps = {},
  expectedSeq?: number,
): Promise<StagedArchive> {
  validatePassphrase(passphrase);
  const run = deps.run ?? runCommand;
  const cipher = deps.cipher ?? ageCipher(run);
  const root = await mkdtemp(join(tmpdir(), "pupkeep-restore-"));
  try {
    const tarPath = join(root, "bundle.tar.gz");
    await cipher.decrypt(archive, tarPath, passphrase);

    const listed = await listTar(run, tarPath);
    if (JSON.stringify([...listed].sort()) !== JSON.stringify(expectedFiles(BACKUP_FILES))) {
      throw new Error(
        `the bundle does not contain exactly ${BACKUP_FILES.join(", ")} (found ${listed.join(", ") || "nothing"})`,
      );
    }

    const directory = join(root, "data");
    await mkdir(directory, { mode: 0o700 });
    await extractTar(run, tarPath, directory);
    const seq = await verifyExtracted(directory, expectedSeq);
    await rm(tarPath, { force: true });
    return {
      root,
      directory,
      seq,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

// --- backup ----------------------------------------------------------------

export interface BackupOptions {
  dataDir: string;
  backupDir?: string;
  /** rclone destination; unset means local-only with a warning. */
  remote?: string;
  passphrase: string;
  retentionDays?: number;
  now?: Date;
  /** Fail instead of warning when no remote is configured (for monitoring). */
  requireRemote?: boolean;
}

export interface BackupResult {
  archive: string;
  createdAt: string;
  bytes: number;
  expectedSeq: number;
  copiedSeq: number;
  remoteConfigured: boolean;
  uploaded: boolean;
  deletedLocal: string[];
  deletedRemote: string[];
  warnings: string[];
}

async function stageBundle(dataDir: string, stagingDir: string): Promise<DatabaseCopy> {
  const paths = dataPaths(dataDir);
  if (!(await exists(paths.database))) {
    throw new Error("pupkeep.sqlite does not exist yet; start Pupkeep once before backing it up");
  }
  if (!(await exists(paths.config))) {
    throw new Error("config.json is missing; refusing to make a backup without the auth authority");
  }

  const copy = await copyDatabase(paths.database, join(stagingDir, "pupkeep.sqlite"));
  const configText = await readFile(paths.config, "utf8");
  verifyConfigText(configText);
  await writePrivate(join(stagingDir, "config.json"), configText);

  // push.json is optional on a first run. Include a valid empty shape rather
  // than writing one into the live data directory: the backup job must not be a
  // second writer while the server runs.
  let pushText: string;
  if (await exists(paths.push)) {
    pushText = await readFile(paths.push, "utf8");
  } else {
    pushText = `${JSON.stringify(emptyPush(), null, 2)}\n`;
  }
  verifyPushText(pushText);
  await writePrivate(join(stagingDir, "push.json"), pushText);

  await fsyncDirectory(stagingDir);
  return copy;
}

async function enforceRetention(
  backupDir: string,
  remote: string | undefined,
  now: Date,
  retentionDays: number,
  run: CommandRunner,
): Promise<{ deletedLocal: string[]; deletedRemote: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const localNames = (await readdir(backupDir).catch(() => [])).filter(isBackupArchive);
  const localExpired = expiredArchives(localNames, now, retentionDays);
  const deletedLocal: string[] = [];
  for (const name of localExpired) {
    try {
      await rm(join(backupDir, name), { force: true });
      deletedLocal.push(name);
    } catch (error) {
      warnings.push(`could not delete the expired local archive ${name}: ${(error as Error).message}`);
    }
  }

  const deletedRemote: string[] = [];
  if (remote) {
    try {
      const remoteNames = await listRemoteArchives(run, remote);
      for (const name of expiredArchives(remoteNames, now, retentionDays)) {
        const result = await run("rclone", ["delete", remotePath(remote, name)]);
        if (result.code !== 0) {
          warnings.push(`rclone could not delete ${name} from the remote (exit ${result.code})`);
        } else {
          deletedRemote.push(name);
        }
      }
    } catch (error) {
      warnings.push(`could not enforce remote retention: ${(error as Error).message}`);
    }
  }
  return { deletedLocal, deletedRemote, warnings };
}

export async function backupDataDir(
  options: BackupOptions,
  deps: ArchiveDeps = {},
): Promise<BackupResult> {
  const run = deps.run ?? runCommand;
  const cipher = deps.cipher ?? ageCipher(run);
  validatePassphrase(options.passphrase);

  const dataDir = resolve(options.dataDir);
  const backupDir = resolve(options.backupDir ?? join(dataDir, "backups"));
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("the backup clock is invalid");
  const retentionDays = options.retentionDays ?? RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error("retentionDays must be a non-negative number");
  }

  let remote: string | undefined;
  if (options.remote !== undefined && options.remote.trim() !== "") {
    remote = normalizeRemote(options.remote);
  }
  if (options.requireRemote && !remote) {
    throw new Error("no rclone remote is configured (--remote) and --require-remote was given");
  }

  await ensurePrivateDirectory(backupDir);
  await sweepStaging(backupDir, now);

  const name = backupArchiveName(now);
  const archive = join(backupDir, name);
  if (await exists(archive)) {
    throw new Error(`the archive ${name} already exists; wait a second and retry`);
  }

  const warnings: string[] = [];
  if (!remote) warnings.push("no rclone remote configured; only the local encrypted archive was written");

  const staging = await mkdtemp(join(backupDir, ".staging-"));
  let copy: DatabaseCopy;
  let wroteArchive = false;
  let verified = false;
  try {
    copy = await stageBundle(dataDir, staging);
    const tarPath = join(staging, "bundle.tar.gz");
    await createTar(run, staging, tarPath);
    // age may create the output before failing; remember that so a partial file
    // is removed rather than left to look like a backup.
    wroteArchive = true;
    await cipher.encrypt(tarPath, archive, options.passphrase);
    await chmod(archive, 0o600);
    await fsyncFile(archive);

    // Verify the archive by decrypting it again. If this fails, the archive is
    // not a backup and must not be left where a later restore might pick it.
    let staged: StagedArchive | undefined;
    try {
      staged = await stageArchive(archive, options.passphrase, { run, cipher }, copy.expectedSeq);
      verified = true;
    } catch (error) {
      throw new Error(`the archive did not verify and was discarded: ${(error as Error).message}`);
    } finally {
      await staged?.cleanup();
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (wroteArchive && !verified) await rm(archive, { force: true });
  }

  let uploaded = false;
  if (remote) {
    const result = await run("rclone", ["copyto", archive, remotePath(remote, name)]);
    if (result.code !== 0) {
      throw new Error(`rclone could not copy the archive to ${remote} (exit ${result.code}); the local archive is intact`);
    }
    uploaded = true;
  }

  const retention = await enforceRetention(backupDir, remote, now, retentionDays, run);
  warnings.push(...retention.warnings);

  const info = await stat(archive);
  return {
    archive,
    createdAt: now.toISOString(),
    bytes: info.size,
    expectedSeq: copy.expectedSeq,
    copiedSeq: copy.copiedSeq,
    remoteConfigured: remote !== undefined,
    uploaded,
    deletedLocal: retention.deletedLocal,
    deletedRemote: retention.deletedRemote,
    warnings,
  };
}

// --- restore ---------------------------------------------------------------

export interface RestoreOptions {
  archive: string;
  dataDir: string;
  passphrase: string;
  /** Replace an existing database/config/push, moving them aside first. */
  force?: boolean;
  now?: Date;
}

export interface RestoreResult {
  restored: string[];
  movedAside?: string;
  seq: number;
  /** `secrets.json` is excluded by design; absent means keys must be re-entered. */
  secretsPresent: boolean;
}

async function assertServerStopped(dataDir: string): Promise<void> {
  for (const file of [LOCK_FILE, SERVER_LOCK_FILE]) {
    const state = await inspectLock(dataDir, file);
    if (state.state === "held") {
      throw new Error(
        `a process still owns ${dataDir} (pid ${state.pid}, ${file}); stop the server before restoring`,
      );
    }
    if (state.state === "error") {
      throw new Error(`could not inspect ${file} in ${dataDir}: ${state.message}; refusing to restore`);
    }
  }
}

export async function restoreDataDir(
  options: RestoreOptions,
  deps: ArchiveDeps = {},
): Promise<RestoreResult> {
  const run = deps.run ?? runCommand;
  const cipher = deps.cipher ?? ageCipher(run);
  validatePassphrase(options.passphrase);

  const dataDir = resolve(options.dataDir);
  const now = options.now ?? new Date();
  await assertServerStopped(dataDir);
  await ensurePrivateDirectory(dataDir);

  // The check above is a snapshot; take the server lock for the duration so a
  // server cannot start between the check and the file replacement. The lock is
  // the same `server.pid` the server itself takes, so a launcher that starts
  // mid-restore sees it and refuses before spawning.
  const acquired = await acquireLock(dataDir, process.pid, new Date(), SERVER_LOCK_FILE);
  if (!acquired.ok) {
    const message =
      acquired.reason === "held"
        ? `a process took the server lock in ${dataDir} (pid ${acquired.pid}) during the restore; nothing was changed`
        : `could not take the restore lock in ${dataDir}: ${acquired.reason}`;
    throw new Error(message);
  }
  const restoreLock: LockHandle = acquired.lock;

  let staged: StagedArchive | undefined;
  try {
    staged = await stageArchive(options.archive, options.passphrase, { run, cipher });
    const present: string[] = [];
    for (const name of [...BACKUP_FILES, SQLITE_WAL, SQLITE_SHM]) {
      if (await exists(join(dataDir, name))) present.push(name);
    }
    const hasData = BACKUP_FILES.some((name) => present.includes(name));
    if (hasData && !options.force) {
      throw new Error(
        `${dataDir} already has a database/config/push; stop the server and pass --force to move them aside`,
      );
    }

    let movedAside: string | undefined;
    if (hasData) {
      movedAside = join(dataDir, `restore-backup-${backupArchiveName(now).slice(9, 24)}`);
      await mkdir(movedAside, { mode: 0o700 });
      for (const name of present) {
        await rename(join(dataDir, name), join(movedAside, name));
      }
    } else {
      // A stale WAL/SHM from a database that is no longer here would be picked
      // up by the restored database; remove it before installing.
      for (const name of [SQLITE_WAL, SQLITE_SHM]) {
        await rm(join(dataDir, name), { force: true });
      }
    }

    try {
      for (const name of BACKUP_FILES) {
        const destination = join(dataDir, name);
        const temporary = `${destination}.restore-${process.pid}`;
        await copyFile(join(staged.directory, name), temporary);
        await chmod(temporary, 0o600);
        await fsyncFile(temporary);
        await rename(temporary, destination);
      }
    } finally {
      // A copy that failed before its rename must not leave a plausible-looking
      // `.restore-*` file in the data directory.
      for (const name of BACKUP_FILES) {
        await rm(join(dataDir, `${name}.restore-${process.pid}`), { force: true });
      }
    }
    await fsyncDirectory(dataDir);

    return {
      restored: [...BACKUP_FILES],
      ...(movedAside !== undefined ? { movedAside } : {}),
      seq: staged.seq,
      secretsPresent: await exists(join(dataDir, "secrets.json")),
    };
  } finally {
    await staged?.cleanup();
    await restoreLock.release();
  }
}

// --- passphrase rotation ---------------------------------------------------

export interface RotateOptions {
  backupDir: string;
  remote?: string;
  oldPassphrase: string;
  newPassphrase: string;
  retentionDays?: number;
}

export interface RotateResult {
  rotated: string[];
  warnings: string[];
}

export class RotationError extends Error {
  readonly rotated: readonly string[];
  constructor(message: string, rotated: readonly string[]) {
    super(message);
    this.name = "RotationError";
    this.rotated = rotated;
  }
}

/**
 * Re-encrypt every retained local archive under a new passphrase and upload the
 * result. The old passphrase remains necessary for any archive not rotated, so
 * this refuses to start when the remote holds archives the local set does not:
 * a "successful" rotation that silently leaves an old-key copy off-device is the
 * failure mode this check exists to prevent.
 */
export async function rotatePassphrases(
  options: RotateOptions,
  deps: ArchiveDeps = {},
): Promise<RotateResult> {
  const run = deps.run ?? runCommand;
  const cipher = deps.cipher ?? ageCipher(run);
  validatePassphrase(options.oldPassphrase);
  validatePassphrase(options.newPassphrase);
  if (options.oldPassphrase === options.newPassphrase) {
    throw new Error("the old and new passphrases are identical");
  }

  const backupDir = resolve(options.backupDir);
  await ensurePrivateDirectory(backupDir);
  const local = (await readdir(backupDir)).filter(isBackupArchive).sort();
  if (local.length === 0) throw new Error(`no backup archives in ${backupDir}`);

  const remote = options.remote ? normalizeRemote(options.remote) : undefined;
  if (remote) {
    const remoteNames = await listRemoteArchives(run, remote);
    const remoteOnly = remoteNames.filter((name) => !local.includes(name));
    if (remoteOnly.length > 0) {
      throw new Error(
        `the remote has archives that are not local (${remoteOnly.join(", ")}); download them into ${backupDir} before rotating`,
      );
    }
  }

  const rotated: string[] = [];
  const warnings: string[] = [];
  for (const name of local) {
    const archive = join(backupDir, name);
    let staged: StagedArchive | undefined;
    let work: string | undefined;
    try {
      staged = await stageArchive(archive, options.oldPassphrase, { run, cipher });
      work = await mkdtemp(join(backupDir, ".staging-"));
      const tarPath = join(work, "bundle.tar.gz");
      await createTar(run, staged.directory, tarPath);

      const tempArchive = `${archive}.rotate-${process.pid}`;
      await cipher.encrypt(tarPath, tempArchive, options.newPassphrase);
      await chmod(tempArchive, 0o600);
      await fsyncFile(tempArchive);

      const check = await stageArchive(tempArchive, options.newPassphrase, { run, cipher }, staged.seq);
      await check.cleanup();

      await rename(tempArchive, archive);
      await fsyncFile(archive);
      rotated.push(name);
    } catch (error) {
      throw new RotationError(
        `rotation stopped at ${name}: ${(error as Error).message}; archives already rotated: ${rotated.join(", ") || "none"}`,
        rotated,
      );
    } finally {
      await staged?.cleanup();
      if (work) await rm(work, { recursive: true, force: true });
      await rm(`${archive}.rotate-${process.pid}`, { force: true });
    }
  }

  if (remote) {
    for (const name of rotated) {
      const result = await run("rclone", ["copyto", join(backupDir, name), remotePath(remote, name)]);
      if (result.code !== 0) {
        throw new RotationError(
          `rclone could not upload the rotated ${name} (exit ${result.code}); the local archive is rotated, the remote copy is not`,
          rotated,
        );
      }
    }
  }

  return { rotated, warnings };
}
