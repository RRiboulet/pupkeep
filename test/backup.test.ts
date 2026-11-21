// The backup job's invariants: the §7.5 bundle and nothing else, a verified
// copy rather than a successful exit code, retention that never deletes the
// newest archive, a passphrase file that cannot sit beside the archive, and a
// restore that refuses to run while a server is alive.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { dataPaths, dataStores, parseConfig } from "../src/server/config.ts";
import { Auth, hashToken } from "../src/server/auth.ts";
import {
  ageCipher,
  archivedCredentials,
  backupArchiveName,
  backupDataDir,
  checkBackupTools,
  expiredArchives,
  failureStatus,
  isBackupArchive,
  newestArchive,
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

test("the archive name only exists once the bundle has been verified", async () => {
  // P5-02's reviewers killed a real run at 800 ms and found a truncated file under
  // the *newest* name, which then broke the default --verify and a default
  // restore while older archives waited for retention to delete them. The output
  // is a `.partial` now, renamed after the decrypt-and-seq check, so this asserts
  // the invariant at the moment of encryption: nothing that looks like an archive
  // exists yet.
  const source = await seedDataDir("partial-before-rename");
  try {
    const now = new Date("2026-10-29T12:00:00.000Z");
    const backupDir = join(source.dir, "backups");
    let seen: string[] = [];
    let outputName = "";
    const spyCipher: ArchiveCipher = {
      encrypt: async (input, output) => {
        outputName = output;
        seen = (await readdir(backupDir)).filter(isBackupArchive);
        await copyFile(input, output);
      },
      decrypt: async (input, output) => {
        await copyFile(input, output);
      },
    };
    const result = await backupDataDir({ dataDir: source.dir, passphrase: PASSPHRASE, now }, { cipher: spyCipher });

    assert.deepEqual(seen, [], "no file matches the archive pattern while encryption is running");
    assert.match(outputName, /\.partial$/, "age writes a .partial name");
    assert.equal(result.archive, join(backupDir, "pupkeep-20261029T120000Z.tar.gz.age"));
    const left = await readdir(backupDir);
    assert.deepEqual(left.filter((name) => name.endsWith(".partial")), [], "the rename consumed the partial");
    assert.deepEqual(left.filter(isBackupArchive), ["pupkeep-20261029T120000Z.tar.gz.age"]);
  } finally {
    await rm(source.dir, { recursive: true, force: true });
  }
});

test("a .partial left by a killed run is never the newest archive", async () => {
  // The residue a SIGKILL leaves. `newestArchive` drives `--verify`'s default and
  // a restore with no --archive, so a partial name must not be eligible at all.
  const dir = await tempDir("pupkeep-backup-partial-");
  try {
    await writeFile(join(dir, "pupkeep-20261029T120000Z.tar.gz.age"), "complete", { mode: 0o600 });
    await writeFile(join(dir, "pupkeep-20261029T130000Z.tar.gz.age.partial"), "truncated");
    assert.equal(await newestArchive(dir), "pupkeep-20261029T120000Z.tar.gz.age");
  } finally {
    await rm(dir, { recursive: true, force: true });
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
    let uploadedSize: number | undefined;
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
        if (args[0] === "copyto") {
          uploadedSize = (await stat(args[1]!)).size;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "lsjson") {
          return { code: 0, stdout: JSON.stringify({ Size: uploadedSize }), stderr: "" };
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
    // The object that landed off-device is stat-ed, not just assumed (P5-02 drill).
    assert.equal(calls.some((call) => call.startsWith("lsjson --stat ")), true);
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

test("the archived config carries no owner token, session or invite, and the live file is untouched", async () => {
  // R7: an archive must not become a credential. Its passphrase deliberately
  // leaves the backup host, so anyone who can open the archive can read every
  // hash in it — an owner hash or a session hash there is a working sign-in.
  const source = await seedDataDir("scrubbed");
  try {
    const stores = dataStores(source.dir);
    const auth = new Auth({ config: stores.config, push: stores.push });
    const { token: ownerToken } = await auth.mintOwner("http://127.0.0.1:8787");
    const owner = await auth.login(ownerToken);
    const partnerCode = await auth.createInvite(owner.session, "Partner");
    const partner = await auth.acceptInvite(partnerCode);

    // The household is at its cap once the invite is accepted, so the unused
    // invite and the member invite hash (an older build wrote one) are added the
    // way `createInvite`/`acceptInvite` would: valid, and live at backup time.
    const unusedInvite = hashToken("an-unused-invite-code-0123456789");
    const pendingInviteHash = hashToken("a-pending-member-invite-0123456789");
    await stores.config.update((config) => ({
      ...config,
      invites: [
        {
          codeHash: unusedInvite,
          role: "member",
          displayName: "Helper",
          createdAt: "2026-10-29T11:00:00.000Z",
          expiresAt: "2026-10-29T23:00:00.000Z",
        },
      ],
      members: config.members.map((member) =>
        member.id === partner.session.memberId ? { ...member, inviteHash: pendingInviteHash } : member,
      ),
    }));

    const liveConfig = await stores.config.read();
    // The detector names everything the live file carries; empty is the only
    // state a bundle may be in.
    const named = archivedCredentials(liveConfig).join(", ");
    assert.match(named, /an owner token hash/);
    assert.match(named, /2 session hashes/);
    assert.match(named, /1 invite/);
    assert.match(named, /1 member invite hash/);

    const liveBefore = await readFile(dataPaths(source.dir).config, "utf8");
    const result = await backupDataDir(
      { dataDir: source.dir, passphrase: PASSPHRASE, now: new Date("2026-10-29T12:10:00Z") },
      { cipher: identityCipher },
    );

    const staged = await stageArchive(result.archive, PASSPHRASE, { cipher: identityCipher });
    try {
      const archivedRaw = JSON.parse(await readFile(join(staged.directory, "config.json"), "utf8"));
      assert.equal(archivedRaw.ownerTokenHash, null);
      assert.deepEqual(archivedRaw.invites, []);
      for (const member of archivedRaw.members) {
        assert.deepEqual(member.sessions, []);
        assert.equal("inviteHash" in member, false, "a member invite hash is a credential too");
      }
      // Identities and roles stay: boot reconciliation, the member cap and the
      // invite flow read them, and a restore that forgot them would lose the
      // household's shape.
      assert.deepEqual(
        archivedRaw.members.map((member: { role: string; displayName: string }) => [member.role, member.displayName]).sort(),
        [["member", "Partner"], ["owner", "Owner"]],
      );
      assert.deepEqual(archivedCredentials(parseConfig(archivedRaw)!), [], "the archive is restorable as-is");

      // No hash that could authenticate survived, by value rather than by name.
      const archivedText = JSON.stringify(archivedRaw);
      for (const hash of [
        hashToken(ownerToken),
        hashToken(owner.token),
        hashToken(partner.token),
        hashToken(partnerCode),
        unusedInvite,
        pendingInviteHash,
      ]) {
        assert.equal(archivedText.includes(hash), false, `the archive leaked ${hash.slice(0, 8)}…`);
      }
    } finally {
      await staged.cleanup();
    }

    // The job reads the live config and never writes it: P5-02's drill property.
    assert.equal(await readFile(dataPaths(source.dir).config, "utf8"), liveBefore);
  } finally {
    await source.close();
    await rm(source.dir, { recursive: true, force: true });
  }
});

test("a restore refuses an archive that still carries a live credential", async () => {
  const source = await seedDataDir("tampered");
  const tamperedDir = await tempDir("pupkeep-tampered-");
  const target = await tempDir("pupkeep-tampered-target-");
  try {
    const stores = dataStores(source.dir);
    const { token } = await new Auth({ config: stores.config }).mintOwner("http://127.0.0.1:8787");
    const result = await backupDataDir(
      { dataDir: source.dir, passphrase: PASSPHRASE, now: new Date("2026-10-29T12:11:00Z") },
      { cipher: identityCipher },
    );

    // Put an owner hash back into the archive's config, then re-tar it: the shape a
    // pre-change archive (or a hand-edited one) has.
    const staged = await stageArchive(result.archive, PASSPHRASE, { cipher: identityCipher });
    let archive: string;
    try {
      const archived = JSON.parse(await readFile(join(staged.directory, "config.json"), "utf8"));
      archived.ownerTokenHash = hashToken(token);
      await writeFile(join(staged.directory, "config.json"), `${JSON.stringify(archived, null, 2)}\n`);
      archive = join(tamperedDir, "tampered.tar.gz.age");
      const tarred = await runCommand("tar", ["-czf", archive, "-C", staged.directory, "pupkeep.sqlite", "config.json", "push.json"]);
      assert.equal(tarred.code, 0, tarred.stderr);
    } finally {
      await staged.cleanup();
    }

    // The refusal is a restore-time policy, not an archive-level one: `--verify`
    // and `rotatePassphrases` still read an older, un-scrubbed archive, so an
    // operator rotating a passphrase across the retained set is not wedged by it.
    const readable = await stageArchive(archive, PASSPHRASE, { cipher: identityCipher });
    await readable.cleanup();

    // The target already holds state, so the refusal is also proven to come before
    // the move-aside: a refused archive must change nothing.
    await writeFile(join(target, "config.json"), '{"old":true}\n', "utf8");
    await assert.rejects(
      restoreDataDir({ archive, dataDir: target, passphrase: PASSPHRASE, force: true }, { cipher: identityCipher }),
      /still carries an owner token hash: restoring it would re-arm an old sign-in/,
    );
    assert.equal(await readFile(join(target, "config.json"), "utf8"), '{"old":true}\n');
    assert.deepEqual(
      (await readdir(target)).filter((name) => name.startsWith("restore-backup-")),
      [],
      "nothing was moved aside",
    );
  } finally {
    await source.close();
    await rm(source.dir, { recursive: true, force: true });
    await rm(tamperedDir, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("a restored household has no way in until an owner token is minted again", async () => {
  // The chosen shape for "restore requires a re-mint": the archive's null
  // `ownerTokenHash` *is* the state. The launcher already mints when the hash is
  // null, so no new CLI surface is needed — the operator is told in the restore's
  // own output that a fresh link will be minted (`--reissue-owner` mints one now).
  const source = await seedDataDir("remint");
  const target = await tempDir("pupkeep-remint-target-");
  try {
    const stores = dataStores(source.dir);
    const auth = new Auth({ config: stores.config });
    const { token: ownerToken } = await auth.mintOwner("http://127.0.0.1:8787");
    const owner = await auth.login(ownerToken);
    const partnerCode = await auth.createInvite(owner.session, "Partner");
    const partner = await auth.acceptInvite(partnerCode);

    const result = await backupDataDir(
      { dataDir: source.dir, passphrase: PASSPHRASE, now: new Date("2026-10-29T12:12:00Z") },
      { cipher: identityCipher },
    );
    const restored = await restoreDataDir(
      { archive: result.archive, dataDir: target, passphrase: PASSPHRASE },
      { cipher: identityCipher },
    );
    assert.equal(restored.requiresOwnerMint, true, "the restored config has no owner token");

    // Everything that authenticated before the backup now authenticates nothing.
    const restoredStores = dataStores(target);
    const restoredAuth = new Auth({ config: restoredStores.config, push: restoredStores.push });
    for (const dead of [ownerToken, owner.token, partner.token, partnerCode]) {
      await assert.rejects(restoredAuth.authenticate(dead), /not signed in/);
    }

    // The database itself restored, so "boots after a re-mint" is about auth only.
    const reopened = await openHarness({ path: dataPaths(target).database });
    try {
      assert.deepEqual(await reopened.harness.snapshot(SnapshotDoc, BACKGROUND_CONTEXT), { marker: "remint" });
    } finally {
      await reopened.harness.close(BACKGROUND_CONTEXT);
    }

    const minted = await restoredAuth.mintOwner("http://127.0.0.1:8787");
    assert.equal(minted.rotated, false, "there was no owner token to rotate");
    assert.equal((await restoredAuth.authenticate(minted.token)).role, "owner");
    const signedIn = await restoredAuth.login(minted.token);
    const config = await restoredStores.config.read();
    assert.equal(config.ownerTokenHash, hashToken(minted.token));

    // And the household is operable again: the partner's row survived the scrub
    // without sessions, so the owner frees the slot and invites them afresh.
    assert.equal(config.members.filter((member) => member.removedAt === undefined).length, 2);
    await restoredAuth.removeMember(signedIn.session, partner.session.memberId);
    const freshCode = await restoredAuth.createInvite(signedIn.session, "Partner");
    const returned = await restoredAuth.acceptInvite(freshCode);
    assert.equal((await restoredAuth.authenticate(returned.token)).role, "member");
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

test("a truncated upload is refused instead of being called uploaded", async () => {
  // P5-02's drill found the module header claiming this while nothing checked it:
  // the job decrypted its own local archive and never looked at the object.
  const source = await seedDataDir("truncated");
  try {
    const remoteRun: CommandRunner = async (command, args, options) => {
      if (command === "rclone") {
        if (args[0] === "lsf") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "lsjson") return { code: 0, stdout: JSON.stringify({ Size: 12 }), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }
      return runCommand(command, args, options);
    };
    await assert.rejects(
      backupDataDir(
        {
          dataDir: source.dir,
          passphrase: PASSPHRASE,
          remote: "test:pupkeep",
          now: new Date("2026-10-29T12:04:00Z"),
        },
        { cipher: identityCipher, run: remoteRun },
      ),
      /uploaded archive is 12 bytes but the local archive/,
    );
  } finally {
    await source.close();
    await rm(source.dir, { recursive: true, force: true });
  }
});

test("a missing helper names itself and says to install it", async () => {
  const run: CommandRunner = async (command) => {
    if (command === "expect") throw new Error("spawn expect ENOENT");
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(checkBackupTools(run, false), /expect is not available \(spawn expect ENOENT\); install it before backing up/);
});
