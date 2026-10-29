// The backup job's invariants: the §7.5 bundle and nothing else, a verified
// copy rather than a successful exit code, retention that never deletes the
// newest archive, a passphrase file that cannot sit beside the archive, and a
// restore that refuses to run while a server is alive.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { dataPaths, dataStores } from "../src/server/config.ts";
import {
  ageCipher,
  backupArchiveName,
  backupDataDir,
  expiredArchives,
  failureStatus,
  normalizeRemote,
  parseArchiveTime,
  parseBackupStatus,
  readBackupStatus,
  readPassphrase,
  remotePath,
  restoreDataDir,
  rotatePassphrases,
  RotationError,
  runCommand,
  stageArchive,
  validatePassphrase,
  type ArchiveCipher,
  type CommandRunner,
} from "../src/server/backup.ts";
import { main as backupMain, parseBackupArgs } from "../scripts/backup.ts";
import { parseRestoreArgs } from "../scripts/restore.ts";
import { openHarness } from "../src/server/harness.ts";
import { acquireLock, SERVER_LOCK_FILE } from "../src/server/lock.ts";

const SnapshotDoc = defineDoc({
  kind: "app.test.backup",
  version: 1,
  scope: "session",
  initial: () => ({ marker: "" }),
  checkpointWhen: () => true,
});

const PASSPHRASE = "correct-horse-battery-staple";

const ageAvailable =
  spawnSync("age", ["--version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("expect", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Identity "encryption": the tar stays a tar, so the real tar/verify path runs. */
const identityCipher: ArchiveCipher = {
  encrypt: async (input, output) => {
    await copyFile(input, output);
  },
  decrypt: async (input, output) => {
    await copyFile(input, output);
  },
};

/**
 * A fake passphrase cipher that really checks the key, by prefixing the
 * plaintext with the passphrase (test-only; age does the real thing).
 */
const keyedCipher: ArchiveCipher = {
  encrypt: async (input, output, passphrase) => {
    const body = await readFile(input);
    const header = Buffer.from(`${passphrase}\n`, "utf8");
    await writeFile(output, Buffer.concat([header, body]), { mode: 0o600 });
  },
  decrypt: async (input, output, passphrase) => {
    const body = await readFile(input);
    const header = Buffer.from(`${passphrase}\n`, "utf8");
    if (body.length < header.length || !body.subarray(0, header.length).equals(header)) {
      throw new Error("wrong passphrase");
    }
    await writeFile(output, body.subarray(header.length), { mode: 0o600 });
  },
};

async function seedDataDir(marker: string): Promise<{
  dir: string;
  close: () => Promise<void>;
  database: string;
}> {
  const dir = await tempDir("pupkeep-backup-src-");
  const stores = dataStores(dir);
  await stores.config.ensure();
  await stores.push.update((push) => push);
  const opened = await openHarness({ path: dataPaths(dir).database });
  await opened.harness.commit(async (tx) => {
    const doc = await tx.doc(SnapshotDoc);
    doc.marker = marker;
  }, BACKGROUND_CONTEXT);
  return {
    dir,
    database: dataPaths(dir).database,
    close: () => opened.harness.close(BACKGROUND_CONTEXT),
  };
}

test("archive names round-trip and the newest archive is never retention's victim", () => {
  const names = [
    "pupkeep-20260901T000000Z.tar.gz.age",
    "pupkeep-20261020T000000Z.tar.gz.age",
    "pupkeep-20261028T000000Z.tar.gz.age",
  ];
  const now = new Date("2026-10-29T00:00:00Z");
  assert.deepEqual(expiredArchives(names, now, 14), ["pupkeep-20260901T000000Z.tar.gz.age"]);

  // A host that was off for a month must not wake up to a job that deletes its
  // only archive.
  assert.deepEqual(expiredArchives(["pupkeep-20260101T000000Z.tar.gz.age"], now, 14), []);
  // Exactly on the boundary is not "older than".
  assert.deepEqual(expiredArchives(["pupkeep-20261015T000000Z.tar.gz.age"], now, 14), []);
  // Foreign files are not retention candidates.
  assert.deepEqual(expiredArchives(["manual-copy.tar.gz.age"], now, 14), []);

  assert.equal(backupArchiveName(new Date("2026-01-02T03:04:05.000Z")), "pupkeep-20260102T030405Z.tar.gz.age");
  assert.equal(parseArchiveTime("pupkeep-20260102T030405Z.tar.gz.age"), Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(parseArchiveTime("pupkeep-20261302T030405.tar.gz.age"), undefined);
});

test("the passphrase has one source and may not live beside the archive", async () => {
  const dataDir = await tempDir("pupkeep-pass-data-");
  const backupDir = join(dataDir, "backups");
  const outside = await tempDir("pupkeep-pass-outside-");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(backupDir, { recursive: true });
  try {
    await writeFile(join(dataDir, "inside.txt"), `${PASSPHRASE}\n`, "utf8");
    await writeFile(join(outside, "outside.txt"), `${PASSPHRASE}\n`, "utf8");

    assert.equal(
      await readPassphrase({ dataDir, backupDir, env: { PUPKEEP_BACKUP_PASSPHRASE: PASSPHRASE } }),
      PASSPHRASE,
    );
    assert.equal(
      await readPassphrase({ dataDir, backupDir, file: join(outside, "outside.txt") }),
      PASSPHRASE,
    );
    await assert.rejects(
      readPassphrase({ dataDir, backupDir, file: join(dataDir, "inside.txt") }),
      /inside the data or backup directory/,
    );
    await assert.rejects(
      readPassphrase({
        dataDir,
        backupDir,
        env: { PUPKEEP_BACKUP_PASSPHRASE: PASSPHRASE },
        file: join(outside, "outside.txt"),
      }),
      /choose one passphrase source/,
    );
    await assert.rejects(
      readPassphrase({ dataDir, backupDir, env: {} }),
      /no backup passphrase/,
    );
    await assert.rejects(
      readPassphrase({ dataDir, backupDir, env: { PUPKEEP_BACKUP_PASSPHRASE: "short" } }),
      /at least 16/,
    );
    assert.throws(() => validatePassphrase(`${PASSPHRASE}\n${PASSPHRASE}`), /control characters/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("status records the last success and the scrubbed last failure", () => {
  const previous = parseBackupStatus({
    schemaVersion: 1,
    lastAttemptAt: "2026-10-28T00:00:00.000Z",
    lastSuccessAt: "2026-10-28T00:00:00.000Z",
    lastArchive: "pupkeep-20261028T000000Z.tar.gz.age",
    lastError: null,
  });
  assert.ok(previous);
  const failed = failureStatus(previous, new Error("a token-shaped value abcdefghijklmnopqrstuvwxyz012345"), new Date("2026-10-29T00:00:00.000Z"));
  assert.equal(failed.lastSuccessAt, previous.lastSuccessAt);
  assert.equal(failed.lastArchive, previous.lastArchive);
  assert.match(failed.lastError ?? "", /a token-shaped value \[redacted\]/, "an opaque token is scrubbed, the cause survives");
  assert.equal(parseBackupStatus({ schemaVersion: 2 }), undefined);
});

test("the CLI expands ~ for every path, including the passphrase file", () => {
  const backup = parseBackupArgs(
    ["--data", "~/d", "--passphrase-file", "~/secret", "--old-passphrase-file", "~/old"],
    "/home/owner",
  );
  assert.equal(backup.dataDir, "/home/owner/d");
  assert.equal(backup.backupDir, "/home/owner/d/backups");
  assert.equal(backup.passphraseFile, "/home/owner/secret");
  assert.equal(backup.oldPassphraseFile, "/home/owner/old");

  const restore = parseRestoreArgs(["--data", "~/d", "--passphrase-file", "~/secret"], "/home/owner");
  assert.equal(restore.dataDir, "/home/owner/d");
  assert.equal(restore.passphraseFile, "/home/owner/secret");
});

test("the CLI writes a failed attempt to the status file", { skip: !ageAvailable }, async () => {
  const dir = await tempDir("pupkeep-status-");
  const previous = process.env.PUPKEEP_BACKUP_PASSPHRASE;
  process.env.PUPKEEP_BACKUP_PASSPHRASE = PASSPHRASE;
  try {
    const code = await backupMain(["--data", dir]);
    assert.equal(code, 1);
    const status = await readBackupStatus(join(dir, "backups"));
    assert.ok(status);
    assert.equal(status.lastSuccessAt, null);
    assert.match(status.lastError ?? "", /pupkeep\.sqlite does not exist/);
  } finally {
    if (previous === undefined) delete process.env.PUPKEEP_BACKUP_PASSPHRASE;
    else process.env.PUPKEEP_BACKUP_PASSPHRASE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("rclone remotes are validated and joined without surprising the shell", () => {
  assert.equal(normalizeRemote("gdrive:pupkeep"), "gdrive:pupkeep");
  assert.equal(normalizeRemote("gdrive:pupkeep/"), "gdrive:pupkeep");
  assert.equal(normalizeRemote("gdrive:"), "gdrive:");
  assert.equal(remotePath("gdrive:pupkeep", "a.tar.gz.age"), "gdrive:pupkeep/a.tar.gz.age");
  assert.equal(remotePath("gdrive:", "a.tar.gz.age"), "gdrive:a.tar.gz.age");
  assert.throws(() => normalizeRemote("--dry-run"), /must not start/);
  assert.throws(() => normalizeRemote("no-remote"), /remote:path/);
  assert.throws(() => normalizeRemote("gdrive:two words"), /whitespace/);
});

test("a live backup contains the §7.5 set, verifies, and restores its commit", async () => {
  const source = await seedDataDir("committed-before-backup");
  const target = await tempDir("pupkeep-backup-dst-");
  try {
    // Files that must never ride along, even though they live in the same dir.
    await writeFile(join(source.dir, "secrets.json"), '{"schemaVersion":1,"providerKeys":{"x":"sk-secret"}}\n', "utf8");
    await writeFile(join(source.dir, "server.log"), "owner-link=secret\n", "utf8");

    const now = new Date("2026-10-29T12:00:00.000Z");
    const result = await backupDataDir(
      { dataDir: source.dir, passphrase: PASSPHRASE, now },
      { cipher: identityCipher },
    );
    assert.equal(result.archive, join(source.dir, "backups", "pupkeep-20261029T120000Z.tar.gz.age"));
    assert.equal(result.remoteConfigured, false);
    assert.equal(result.uploaded, false);
    assert.equal((await stat(result.archive)).mode & 0o777, 0o600);
    assert.ok(result.warnings.some((warning) => /no rclone remote/.test(warning)));

    // The archive lists exactly the three files, and neither the provider key
    // nor the log survived the copy.
    const staged = await stageArchive(result.archive, PASSPHRASE, { cipher: identityCipher });
    try {
      assert.equal(staged.seq, result.copiedSeq);
      const entries = await import("node:fs/promises").then((fs) => fs.readdir(staged.directory));
      assert.deepEqual(entries.sort(), ["config.json", "pupkeep.sqlite", "push.json"]);
    } finally {
      await staged.cleanup();
    }

    const restored = await restoreDataDir(
      { archive: result.archive, dataDir: target, passphrase: PASSPHRASE },
      { cipher: identityCipher },
    );
    assert.deepEqual(restored.restored, ["pupkeep.sqlite", "config.json", "push.json"]);
    assert.equal(restored.secretsPresent, false);

    const reopened = await openHarness({ path: dataPaths(target).database });
    try {
      assert.deepEqual(await reopened.harness.snapshot(SnapshotDoc, BACKGROUND_CONTEXT), {
        marker: "committed-before-backup",
      });
    } finally {
      await reopened.harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await source.close();
    await rm(source.dir, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("a live backup while the Harness stays open still contains the newest commit", async () => {
  const source = await seedDataDir("live");
  try {
    const result = await backupDataDir(
      { dataDir: source.dir, passphrase: PASSPHRASE, now: new Date("2026-10-29T12:01:00Z") },
      { cipher: identityCipher },
    );
    const staged = await stageArchive(result.archive, PASSPHRASE, { cipher: identityCipher });
    await staged.cleanup();
    assert.ok(result.copiedSeq >= result.expectedSeq);
    const check = spawnSync("tar", ["-tzf", result.archive], { encoding: "utf8" });
    // Identity cipher means the archive *is* the tar; no wal/shm or extra file.
    assert.equal(check.status, 0);
    assert.doesNotMatch(check.stdout, /secrets\.json|server\.log|-wal|-shm/);
  } finally {
    await source.close();
    await rm(source.dir, { recursive: true, force: true });
  }
});

test("a missing push.json is backed up as a valid empty shape without writing the live dir", async () => {
  const dir = await tempDir("pupkeep-backup-nopush-");
  try {
    await dataStores(dir).config.ensure();
    const opened = await openHarness({ path: dataPaths(dir).database });
    await opened.harness.close(BACKGROUND_CONTEXT);
    await rm(dataPaths(dir).push, { force: true });

    const result = await backupDataDir(
      { dataDir: dir, passphrase: PASSPHRASE, now: new Date("2026-10-29T12:02:00Z") },
      { cipher: identityCipher },
    );
    const staged = await stageArchive(result.archive, PASSPHRASE, { cipher: identityCipher });
    try {
      const push = JSON.parse(await readFile(join(staged.directory, "push.json"), "utf8"));
      assert.equal(push.schemaVersion, 1);
      assert.equal(push.vapid, null);
    } finally {
      await staged.cleanup();
    }
    await assert.rejects(stat(dataPaths(dir).push), /ENOENT/, "the backup job must not write push.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a configured remote receives the archive and retention deletes only old remote copies", async () => {
  const source = await seedDataDir("remote");
  try {
    const calls: string[] = [];
    const remoteRun: CommandRunner = async (command, args, options) => {
      if (command === "rclone") {
        calls.push(args.join(" "));
        if (args[0] === "lsf") {
          return {
            code: 0,
            stdout: "pupkeep-20200101T000000Z.tar.gz.age\npupkeep-20261028T000000Z.tar.gz.age\n",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      return runCommand(command, args, options);
    };

    await assert.rejects(
      backupDataDir(
        { dataDir: source.dir, passphrase: PASSPHRASE, requireRemote: true, now: new Date("2026-10-29T12:02:00Z") },
        { cipher: identityCipher },
      ),
      /no rclone remote/,
    );

    const result = await backupDataDir(
      {
        dataDir: source.dir,
        passphrase: PASSPHRASE,
        remote: "test:pupkeep",
        now: new Date("2026-10-29T12:02:00Z"),
      },
      { cipher: identityCipher, run: remoteRun },
    );
    assert.equal(result.remoteConfigured, true);
    assert.equal(result.uploaded, true);
    assert.equal(calls.some((call) => call.startsWith("copyto ")), true);
    assert.deepEqual(result.deletedRemote, ["pupkeep-20200101T000000Z.tar.gz.age"]);
    assert.equal(calls.some((call) => call.includes("pupkeep-20261028T000000Z")), false);
  } finally {
    await source.close();
    await rm(source.dir, { recursive: true, force: true });
  }
});

test("restore refuses while a launcher or server lock is live", async () => {
  const source = await seedDataDir("lock-source");
  const target = await tempDir("pupkeep-restore-locked-");
  try {
    const result = await backupDataDir(
      { dataDir: source.dir, passphrase: PASSPHRASE, now: new Date("2026-10-29T12:03:00Z") },
      { cipher: identityCipher },
    );
    const lock = await acquireLock(target, process.pid, new Date(), SERVER_LOCK_FILE);
    assert.ok(lock.ok);
    try {
      await assert.rejects(
        restoreDataDir({ archive: result.archive, dataDir: target, passphrase: PASSPHRASE }, { cipher: identityCipher }),
        /stop the server before restoring/,
      );
    } finally {
      await lock.lock.release();
    }
  } finally {
    await source.close();
    await rm(source.dir, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("restore --force moves the old state aside, drops stale wal/shm, and keeps secrets.json", async () => {
  const source = await seedDataDir("new-state");
  const target = await tempDir("pupkeep-restore-force-");
  try {
    const result = await backupDataDir(
      { dataDir: source.dir, passphrase: PASSPHRASE, now: new Date("2026-10-29T12:04:00Z") },
      { cipher: identityCipher },
    );

    // Old state in the target, including a secret that must survive and a stale
    // WAL that must not be attached to the restored database.
    await writeFile(join(target, "config.json"), '{"old":true}\n', "utf8");
    await writeFile(join(target, "push.json"), '{"old":true}\n', "utf8");
    await writeFile(join(target, "pupkeep.sqlite"), "not a database\n", "utf8");
    await writeFile(join(target, "pupkeep.sqlite-wal"), "stale\n", "utf8");
    await writeFile(join(target, "secrets.json"), '{"schemaVersion":1,"providerKeys":{}}\n', "utf8");

    await assert.rejects(
      restoreDataDir({ archive: result.archive, dataDir: target, passphrase: PASSPHRASE }, { cipher: identityCipher }),
      /pass --force/,
    );

    const now = new Date("2026-10-29T12:04:00Z");
    const restored = await restoreDataDir(
      { archive: result.archive, dataDir: target, passphrase: PASSPHRASE, force: true, now },
      { cipher: identityCipher },
    );
    assert.match(restored.movedAside ?? "", /restore-backup-20261029T120400Z-\d+$/);
    assert.equal(await readFile(join(restored.movedAside!, "config.json"), "utf8"), '{"old":true}\n');
    assert.equal(await readFile(join(restored.movedAside!, "pupkeep.sqlite-wal"), "utf8"), "stale\n");
    await assert.rejects(stat(join(target, "pupkeep.sqlite-wal")), /ENOENT/);
    assert.equal(restored.secretsPresent, true);
    assert.equal(await readFile(join(target, "secrets.json"), "utf8"), '{"schemaVersion":1,"providerKeys":{}}\n');
    await assert.rejects(stat(join(target, SERVER_LOCK_FILE)), /ENOENT/, "the restore must release its lock");
  } finally {
    await source.close();
    await rm(source.dir, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("rotation resumes after a partial failure instead of wedging on a new-key archive", async () => {
  const source = await seedDataDir("rotate-resume");
  try {
    const first = await backupDataDir(
      { dataDir: source.dir, passphrase: PASSPHRASE, now: new Date("2026-10-29T12:08:00Z") },
      { cipher: keyedCipher },
    );
    const second = await backupDataDir(
      { dataDir: source.dir, passphrase: PASSPHRASE, now: new Date("2026-10-29T12:09:00Z") },
      { cipher: keyedCipher },
    );
    const next = "another-correct-horse-battery";
    const backupDir = join(source.dir, "backups");

    let encrypts = 0;
    const flaky: ArchiveCipher = {
      encrypt: async (input, output, passphrase) => {
        encrypts += 1;
        if (encrypts === 2) throw new Error("disk full");
        return keyedCipher.encrypt(input, output, passphrase);
      },
      decrypt: keyedCipher.decrypt,
    };
    await assert.rejects(
      rotatePassphrases(
        { backupDir, oldPassphrase: PASSPHRASE, newPassphrase: next },
        { cipher: flaky },
      ),
      (error: unknown) => error instanceof RotationError && error.rotated.length === 1,
    );

    // The first archive is now under the new key; a rerun must skip it rather
    // than failing to decrypt it with the old passphrase.
    const resumed = await rotatePassphrases(
      { backupDir, oldPassphrase: PASSPHRASE, newPassphrase: next },
      { cipher: keyedCipher },
    );
    assert.equal(resumed.alreadyRotated.length, 1);
    assert.equal(resumed.rotated.length, 1);
    for (const path of [first.archive, second.archive]) {
      const staged = await stageArchive(path, next, { cipher: keyedCipher });
      await staged.cleanup();
    }
  } finally {
    await source.close();
    await rm(source.dir, { recursive: true, force: true });
  }
});

test("rotation re-encrypts every retained archive and refuses a remote-only archive", async () => {
  const source = await seedDataDir("rotate");
  try {
    const first = await backupDataDir(
      { dataDir: source.dir, passphrase: PASSPHRASE, now: new Date("2026-10-29T12:05:00Z") },
      { cipher: keyedCipher },
    );
    const second = await backupDataDir(
      { dataDir: source.dir, passphrase: PASSPHRASE, now: new Date("2026-10-29T12:06:00Z") },
      { cipher: keyedCipher },
    );
    const backupDir = join(source.dir, "backups");
    const next = "another-correct-horse-battery";

    // A remote-only archive makes a complete rotation impossible; refuse before
    // touching the local set.
    const remoteOnly: CommandRunner = async (command, args, options) => {
      if (command === "rclone") return { code: 0, stdout: "pupkeep-20200101T000000Z.tar.gz.age\n", stderr: "" };
      return runCommand(command, args, options);
    };
    await assert.rejects(
      rotatePassphrases(
        { backupDir, remote: "test:pupkeep", oldPassphrase: PASSPHRASE, newPassphrase: next },
        { cipher: keyedCipher, run: remoteOnly },
      ),
      /not local/,
    );

    const rotation = await rotatePassphrases(
      { backupDir, oldPassphrase: PASSPHRASE, newPassphrase: next },
      { cipher: keyedCipher },
    );
    assert.deepEqual(rotation.rotated.sort(), [first.archive, second.archive].map((path) => path.split("/").at(-1)!).sort());
    for (const path of [first.archive, second.archive]) {
      await assert.rejects(stageArchive(path, PASSPHRASE, { cipher: keyedCipher }), /wrong passphrase/);
      const staged = await stageArchive(path, next, { cipher: keyedCipher });
      await staged.cleanup();
    }
  } finally {
    await source.close();
    await rm(source.dir, { recursive: true, force: true });
  }
});

test("age + expect really round-trip a file under a passphrase", { skip: !ageAvailable }, async () => {
  const dir = await tempDir("pupkeep-age-");
  try {
    const input = join(dir, "plain.txt");
    const archive = join(dir, "bundle.age");
    const output = join(dir, "round.txt");
    await writeFile(input, "the bundle body\n", "utf8");
    const cipher = ageCipher(runCommand);
    await cipher.encrypt(input, archive, PASSPHRASE);
    assert.notEqual(await readFile(archive, "utf8"), "the bundle body\n");
    await cipher.decrypt(archive, output, PASSPHRASE);
    assert.equal(await readFile(output, "utf8"), "the bundle body\n");
    await assert.rejects(cipher.decrypt(archive, join(dir, "bad.txt"), "wrong-correct-horse"), /could not decrypt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
