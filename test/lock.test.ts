import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireLock, inspectLock, lockPath, SERVER_LOCK_FILE } from "../src/server/lock.ts";

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

test("a foreign live pid with different start ticks is stale, not a live holder", async () => {
  const dir = await tempDataDir();
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    assert.ok(child.pid);
    // The pid is alive, but its start ticks cannot be this value. This is what
    // a recycled pid looks like; inspectLock and acquireLock must agree.
    await writeFile(lockPath(dir), `${child.pid} 999999999999 2026-10-29T00:00:00.000Z\n`, "utf8");
    assert.deepEqual(await inspectLock(dir), { state: "free" });
    const result = await acquireLock(dir, process.pid);
    assert.ok(result.ok, "a recycled foreign pid must not block startup");
    await result.lock.release();
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
});

test("a stale lock left by a dead process is replaced, not fatal", async () => {
  const dir = await tempDataDir();
  // A pid that cannot be running: above Linux's default pid_max.
  await writeFile(lockPath(dir), "4194304 - 2026-10-29T00:00:00.000Z\n", "utf8");
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

test("the server lock is separate from the launcher lock", async () => {
  const dir = await tempDataDir();
  const launcher = await acquireLock(dir);
  const server = await acquireLock(dir, process.pid, new Date(), SERVER_LOCK_FILE);
  assert.ok(launcher.ok);
  assert.ok(server.ok);
  try {
    const launcherState = await inspectLock(dir);
    const serverState = await inspectLock(dir, SERVER_LOCK_FILE);
    assert.equal(launcherState.state, "held");
    assert.equal(serverState.state, "held");
    if (launcherState.state === "held") assert.equal(launcherState.pid, process.pid);
  } finally {
    await server.lock.release();
    await launcher.lock.release();
  }
});

test("acquiring the same lock twice in one process is refused, not mistaken for stale", async () => {
  const dir = await tempDataDir();
  const first = await acquireLock(dir, process.pid);
  assert.ok(first.ok);
  const second = await acquireLock(dir, process.pid);
  assert.ok(!second.ok);
  assert.equal(second.reason, "held");
  await first.lock.release();
});

test("inspectLock reads without taking the lock and treats a dead pid as free", async () => {
  const dir = await tempDataDir();
  assert.deepEqual(await inspectLock(dir), { state: "free" });

  const held = await acquireLock(dir, process.pid);
  assert.ok(held.ok);
  const state = await inspectLock(dir);
  assert.equal(state.state, "held");
  if (state.state === "held") assert.equal(state.pid, process.pid);
  // Inspecting must not remove or replace the file.
  assert.match(await readFile(lockPath(dir), "utf8"), new RegExp(`^${process.pid} `));
  await held.lock.release();

  await writeFile(lockPath(dir), "4194304 - 2026-10-29T00:00:00.000Z\n", "utf8");
  assert.deepEqual(await inspectLock(dir), { state: "free" });
});

test("inspectLock refuses to guess at a garbled lock", async () => {
  const dir = await tempDataDir();
  await writeFile(lockPath(dir), "not-a-pid\n", "utf8");
  const state = await inspectLock(dir);
  assert.equal(state.state, "error");
});

test("a data directory that does not exist is an error, not a silent success", async () => {
  const result = await acquireLock(join(tmpdir(), "pupkeep-missing-dir-xyz"));
  assert.ok(!result.ok);
  assert.equal(result.reason, "error");
});

test("an unreadable lock is an error, not something to unlink on a guess", async () => {
  const dir = await tempDataDir();
  // A truncated write (power loss) or a garbled file: there is no evidence of a
  // dead owner here, so removing it could take a live process's lock away.
  await writeFile(lockPath(dir), "not-a-pid\n", "utf8");
  const result = await acquireLock(dir, process.pid);
  assert.ok(!result.ok);
  assert.equal(result.reason, "error");
  assert.match((result as { message: string }).message, /unreadable/);
});

test("a live lock with a non-numeric start time is unreadable, not stale", async () => {
  const dir = await tempDataDir();
  // Comparing "yesterday" to a real start tick would mark this live holder stale
  // and let a second writer in; refuse instead.
  await writeFile(lockPath(dir), `${process.pid} yesterday 2026-10-29T00:00:00.000Z\n`, "utf8");
  const result = await acquireLock(dir, process.pid);
  assert.ok(!result.ok);
  assert.equal(result.reason, "error");
});

test("a recycled pid with a different start time is stale, not a live holder", async () => {
  const dir = await tempDataDir();
  // Same pid as this process, but a start time that cannot be ours: this is what
  // a reused pid looks like after a reboot.
  await writeFile(lockPath(dir), `${process.pid} 1 2026-10-29T00:00:00.000Z\n`, "utf8");
  const result = await acquireLock(dir, process.pid);
  assert.ok(result.ok, "a recycled pid must not block the host");
  await result.lock.release();
});

test("a lock naming this same live process is still refused by a second instance", async () => {
  const dir = await tempDataDir();
  const first = await acquireLock(dir, process.pid);
  assert.ok(first.ok);

  const second = await acquireLock(dir, process.pid + 1);
  assert.ok(!second.ok);
  assert.equal(second.reason, "held");

  await first.lock.release();
});
