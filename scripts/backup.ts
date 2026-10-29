// `npm run backup -- [options]` — the job PLAN §7.5 puts in P1-07.
//
// The passphrase is read from an environment variable or an explicit file
// outside the data and backup directories. It is never written here, never
// logged, and never passed on a command line; the age prompt is answered over a
// PTY by the core module. An unattended nightly run therefore needs an external
// source for that variable (a vault read, a different host over SSH, or an
// operator); the job deliberately has no default that would put the key beside
// the archive.

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readdir } from "node:fs/promises";
import {
  backupDataDir,
  checkBackupTools,
  failureStatus,
  readBackupStatus,
  writeBackupStatus,
  DEFAULT_OLD_PASSPHRASE_ENV,
  DEFAULT_PASSPHRASE_ENV,
  isBackupArchive,
  normalizeRemote,
  parseArchiveTime,
  readPassphrase,
  RETENTION_DAYS,
  rotatePassphrases,
  runCommand,
  stageArchive,
} from "../src/server/backup.ts";
import { createLogger } from "../src/server/log.ts";

const USAGE = `pupkeep backup — one encrypted bundle, local and off-device

Usage: npm run backup -- [options]

  --data <dir>                 data directory (default: ~/.pupkeep)
  --backup-dir <dir>           local archive directory (default: <data>/backups)
  --remote <remote:path>       rclone destination; no default (local-only warning)
  --passphrase-env <name>      default ${DEFAULT_PASSPHRASE_ENV}
  --passphrase-file <path>     must be outside the data and backup directories
  --retention-days <n>         default ${RETENTION_DAYS}; the newest archive is always kept
  --require-remote             fail when --remote is not configured (for monitoring)
  --verify                     decrypt and verify the newest local archive
  --rotate                     re-encrypt retained archives under a new passphrase
  --old-passphrase-env <name>  default ${DEFAULT_OLD_PASSPHRASE_ENV} (with --rotate)
  --old-passphrase-file <path> (with --rotate)
  -h, --help                   show this help

The passphrase and provider keys are never printed. A failed backup exits
non-zero; a backup with no rclone remote still writes the local archive and
warns.
`;

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function absolute(path: string, home: string): string {
  const expanded = expandHome(path, home);
  return resolve(home, expanded);
}

function stringValue(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new Error(`${flag} may be given only once`);
  if (typeof value !== "string") throw new Error(`${flag} needs a value`);
  return value;
}

function numberValue(value: unknown, flag: string, fallback: number): number {
  const text = stringValue(value, flag);
  if (text === undefined) return fallback;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${flag} must be a non-negative number`);
  return number;
}

function booleanValue(value: unknown, flag: string): boolean {
  if (value === undefined) return false;
  if (value === true) return true;
  throw new Error(`${flag} does not take a value`);
}

export interface BackupCliOptions {
  dataDir: string;
  backupDir: string;
  remote?: string;
  passphraseEnv: string;
  passphraseFile?: string;
  retentionDays: number;
  requireRemote: boolean;
  verify: boolean;
  rotate: boolean;
  oldPassphraseEnv: string;
  oldPassphraseFile?: string;
  help: boolean;
}

export function parseBackupArgs(argv: readonly string[], home: string = homedir()): BackupCliOptions {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      data: { type: "string" },
      "backup-dir": { type: "string" },
      remote: { type: "string" },
      "passphrase-env": { type: "string" },
      "passphrase-file": { type: "string" },
      "retention-days": { type: "string" },
      "require-remote": { type: "boolean" },
      verify: { type: "boolean" },
      rotate: { type: "boolean" },
      "old-passphrase-env": { type: "string" },
      "old-passphrase-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const dataDir = absolute(stringValue(values.data, "--data") ?? "~/.pupkeep", home);
  const backupDir = absolute(stringValue(values["backup-dir"], "--backup-dir") ?? join(dataDir, "backups"), home);
  const remote = stringValue(values.remote, "--remote");
  const passphraseFile = stringValue(values["passphrase-file"], "--passphrase-file");
  const oldPassphraseFile = stringValue(values["old-passphrase-file"], "--old-passphrase-file");
  const verify = booleanValue(values.verify, "--verify");
  const rotate = booleanValue(values.rotate, "--rotate");
  if (verify && rotate) throw new Error("choose one of --verify and --rotate");

  return {
    dataDir,
    backupDir,
    ...(remote !== undefined ? { remote } : {}),
    passphraseEnv: stringValue(values["passphrase-env"], "--passphrase-env") ?? DEFAULT_PASSPHRASE_ENV,
    ...(passphraseFile !== undefined ? { passphraseFile } : {}),
    retentionDays: numberValue(values["retention-days"], "--retention-days", RETENTION_DAYS),
    requireRemote: booleanValue(values["require-remote"], "--require-remote"),
    verify,
    rotate,
    oldPassphraseEnv:
      stringValue(values["old-passphrase-env"], "--old-passphrase-env") ?? DEFAULT_OLD_PASSPHRASE_ENV,
    ...(oldPassphraseFile !== undefined ? { oldPassphraseFile } : {}),
    help: booleanValue(values.help, "--help"),
  };
}

async function newestArchive(backupDir: string): Promise<string | undefined> {
  const names = (await readdir(backupDir).catch(() => [])).filter(isBackupArchive);
  const dated = names
    .map((name) => ({ name, time: parseArchiveTime(name) }))
    .filter((entry): entry is { name: string; time: number } => entry.time !== undefined)
    .sort((a, b) => a.time - b.time);
  return dated.at(-1)?.name;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  // 0700/0600 for anything this job creates; the data directory is private, and
  // the archive staging area should not need it to be.
  process.umask(0o077);
  const logger = createLogger({ scope: "backup" });
  let options: BackupCliOptions;
  try {
    options = parseBackupArgs(argv);
  } catch (error) {
    logger.error(`backup: ${(error as Error).message}`);
    process.stderr.write(USAGE);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const isBackupRun = !options.verify && !options.rotate;
  const previousStatus = isBackupRun ? await readBackupStatus(options.backupDir) : undefined;
  try {
    const remote = options.remote !== undefined ? normalizeRemote(options.remote) : undefined;
    if (options.requireRemote && !remote) {
      throw new Error("--require-remote was given but --remote is not configured");
    }
    if (options.verify) {
      const name = await newestArchive(options.backupDir);
      if (!name) throw new Error(`no backup archives in ${options.backupDir}`);
      const passphrase = await readPassphrase({
        dataDir: options.dataDir,
        backupDir: options.backupDir,
        envName: options.passphraseEnv,
        ...(options.passphraseFile !== undefined ? { file: options.passphraseFile } : {}),
      });
      await checkBackupTools(runCommand, false);
      const staged = await stageArchive(join(options.backupDir, name), passphrase);
      try {
        process.stdout.write(`verified ${name} (durable seq ${staged.seq})\n`);
      } finally {
        await staged.cleanup();
      }
      return 0;
    }

    if (options.rotate) {
      const oldPassphrase = await readPassphrase({
        dataDir: options.dataDir,
        backupDir: options.backupDir,
        envName: options.oldPassphraseEnv,
        ...(options.oldPassphraseFile !== undefined ? { file: options.oldPassphraseFile } : {}),
      });
      const newPassphrase = await readPassphrase({
        dataDir: options.dataDir,
        backupDir: options.backupDir,
        envName: options.passphraseEnv,
        ...(options.passphraseFile !== undefined ? { file: options.passphraseFile } : {}),
      });
      await checkBackupTools(runCommand, remote !== undefined);
      const result = await rotatePassphrases({
        backupDir: options.backupDir,
        ...(remote !== undefined ? { remote } : {}),
        oldPassphrase,
        newPassphrase,
      });
      for (const warning of result.warnings) logger.warn(warning);
      process.stdout.write(`rotated ${result.rotated.length} archive(s) to the new passphrase\n`);
      process.stdout.write(
        "Store the new passphrase off the backup host and destroy the old copy; " +
          "the old passphrase no longer decrypts these archives.\n",
      );
      return 0;
    }

    const passphrase = await readPassphrase({
      dataDir: options.dataDir,
      backupDir: options.backupDir,
      envName: options.passphraseEnv,
      ...(options.passphraseFile !== undefined ? { file: options.passphraseFile } : {}),
    });
    await checkBackupTools(runCommand, remote !== undefined);
    const result = await backupDataDir({
      dataDir: options.dataDir,
      backupDir: options.backupDir,
      ...(remote !== undefined ? { remote } : {}),
      passphrase,
      retentionDays: options.retentionDays,
      requireRemote: options.requireRemote,
    });
    for (const warning of result.warnings) logger.warn(warning);
    try {
      await writeBackupStatus(options.backupDir, {
        schemaVersion: 1,
        lastAttemptAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        lastArchive: basename(result.archive),
        lastError: null,
      });
    } catch (error) {
      logger.warn(`the backup succeeded but its status file could not be written: ${(error as Error).message}`);
    }
    process.stdout.write(
      `backup ${result.archive} (${result.bytes} bytes, seq ${result.expectedSeq}->${result.copiedSeq}, ` +
        `${result.uploaded ? "uploaded" : "local only"})\n`,
    );
    if (result.deletedLocal.length > 0) {
      process.stdout.write(`retention removed locally: ${result.deletedLocal.join(", ")}\n`);
    }
    if (result.deletedRemote.length > 0) {
      process.stdout.write(`retention removed remotely: ${result.deletedRemote.join(", ")}\n`);
    }
    return 0;
  } catch (error) {
    if (isBackupRun) {
      try {
        await writeBackupStatus(options.backupDir, failureStatus(previousStatus, error, new Date()));
      } catch (statusError) {
        logger.warn(`could not record the failed backup: ${(statusError as Error).message}`);
      }
    }
    logger.error((error as Error).message);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
