import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireLock, lockPath } from "../src/server/lock.ts";

// Two servers against one SQLite file is the failure the durability story exists
// to avoid, so the lock gets the tests: taken once, refused when held, recovered
// when stale, and released only by its owner.

async function tempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pupkeep-lock-"));
}

test("the lock is taken, recorded at 0600, and released", async () => {
  const dir = await tempDataDir();
  const result = await acquireLock(dir);
  assert.ok(result.ok);

  const info = await stat(lockPath(dir));
  assert.equal(info.mode & 0o777, 0o600);
  const text = await readFile(lockPath(dir), "utf8");
  assert.match(text, new RegExp(`^${process.pid} `));

  await result.lock.release();
  await assert.rejects(stat(lockPath(dir)), /ENOENT/);
});

test("a second instance is refused and told who holds it", async () => {
  const dir = await tempDataDir();
  const first = await acquireLock(dir, process.pid);
  assert.ok(first.ok);

  // process.pid is demonstrably alive, so this reads as "held".
  const second = await acquireLock(dir, process.pid + 1);
  assert.ok(!second.ok);
  assert.equal(second.reason, "held");
  if (second.reason === "held") assert.equal(second.pid, process.pid);

  await first.lock.release();
});

test("a stale lock left by a dead process is replaced, not fatal", async () => {
  const dir = await tempDataDir();
  // A pid that cannot be running: above Linux's default pid_max.
  await writeFile(lockPath(dir), "4194304 2026-10-29T00:00:00.000Z\n", "utf8");
  const result = await acquireLock(dir, process.pid);
  assert.ok(result.ok, "a crash must not make the phone unbootable");
  await result.lock.release();
});

test("release only removes a lock this process still owns", async () => {
  const dir = await tempDataDir();
  const first = await acquireLock(dir, process.pid);
  assert.ok(first.ok);

  // Simulate a takeover by a newer launcher: the file now names another pid.
  await writeFile(lockPath(dir), `${process.pid + 1} 2026-10-29T00:00:00.000Z\n`, "utf8");
  await first.lock.release();

  const text = await readFile(lockPath(dir), "utf8");
  assert.match(text, new RegExp(`^${process.pid + 1} `), "a late shutdown must not free the new owner's lock");
});

test("a data directory that does not exist is an error, not a silent success", async () => {
  const result = await acquireLock(join(tmpdir(), "pupkeep-missing-dir-xyz"));
  assert.ok(!result.ok);
  assert.equal(result.reason, "error");
});
