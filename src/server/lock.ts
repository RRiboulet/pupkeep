// One process per data directory. Pi Durable has no cross-process locking, and
// two servers against one SQLite file is the failure the whole durability story
// rests on avoiding (PLAN §3.2), so the launcher takes a pid lock before it
// starts anything.
//
// This is the item PLAN §16 assigns to P1-05; it lands here because the launcher
// cannot be honest about "one process" without it. P1-05 keeps the rest: config,
// secrets, push, serialized writes and the log scrub.

import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface LockHandle {
  path: string;
  pid: number;
  release(): Promise<void>;
}

interface LockOwner {
  pid: number;
  /** Kernel start ticks of the holder, when it can be read. */
  startTicks?: string;
}

export type LockResult =
  | { ok: true; lock: LockHandle }
  | { ok: false; reason: "held"; path: string; pid: number; alive: true }
  | { ok: false; reason: "error"; message: string };

export const LOCK_FILE = "launcher.pid";
/**
 * The server takes a lock of its own, not the launcher's.
 *
 * A child cannot hold the lock its parent already holds, and the failure this
 * closes is exactly that pair drifting apart: a SIGKILLed launcher leaves its
 * detached server alive, a new launcher sees the launcher lock's dead pid and
 * clears it, then spawns a second server. The surviving server's own lock is
 * still live, so the second server refuses at open and the one-writer rule
 * holds without depending on the launcher being alive. P1-07's carry-over.
 */
export const SERVER_LOCK_FILE = "server.pid";

export function lockPath(dataDir: string, file: string = LOCK_FILE): string {
  return join(dataDir, file);
}

/**
 * The kernel's start time for a pid, as ticks since boot. This is what tells a
 * recycled pid apart from the process that wrote the lock: pids are reused, and a
 * lock naming a live-but-unrelated process would block the host for as long as
 * that process happens to live.
 *
 * Linux and Android expose it as field 22 of `/proc/<pid>/stat`. Where `/proc` is
 * absent, `undefined` means "cannot tell" and the caller stays conservative.
 */
async function processStartTicks(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command name can contain spaces and parentheses; start counting after
    // the last ')', where the fields are whitespace-separated.
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).split(" ");
    // After the command, `state` is field 3, so field 22 is index 19 here.
    return fields[19];
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: it exists but belongs to someone else —
    // still alive, and definitely not ours to take over.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type ReadOwner = { ok: true; owner?: LockOwner } | { ok: false; reason: string };

async function readOwner(path: string): Promise<ReadOwner> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
    return { ok: false, reason: (error as Error).message };
  }
  const [pidText, ticks] = text.trim().split(/\s+/);
  const pid = Number(pidText);
  // An empty or garbled lock is *not* evidence of a dead owner. Unlinking it on
  // a guess lets two simultaneous starters remove each other's lock. The ticks
  // field is load-bearing: a non-numeric value would compare unequal to every
  // real process and silently mark a live holder stale.
  const validTicks = ticks === undefined || ticks === "-" || /^\d+$/.test(ticks);
  if (!Number.isInteger(pid) || pid <= 0 || !validTicks) {
    return { ok: false, reason: `lock file is unreadable: ${path}` };
  }
  return { ok: true, owner: { pid, ...(ticks ? { startTicks: ticks } : {}) } };
}

/**
 * Take the lock, or report who holds it.
 *
 * A stale file — pid gone — is replaced rather than treated as an error: a phone
 * that lost power or had Termux killed leaves one behind, and refusing to boot
 * after a normal crash would be worse than the race it protects against.
 *
 * That takeover is read → unlink → exclusive create, not a compare-and-swap.
 * Two *simultaneous manual* starts on the same stale lock can in principle both
 * clear it; the supervisor spawns one child at a time, and `flock` would need a
 * native module the phone runtime forbids (PLAN §3.2). This is the accepted
 * Phase 1 residual, not a silent claim of atomicity.
 */
export async function acquireLock(
  dataDir: string,
  pid: number = process.pid,
  startedAt: Date = new Date(),
  file: string = LOCK_FILE,
): Promise<LockResult> {
  const path = lockPath(dataDir, file);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        const ticks = await processStartTicks(pid);
        // `pid startTicks startedAt` — ticks make a recycled pid detectable, the
        // timestamp is for a human reading the file.
        await handle.writeFile(`${pid} ${ticks ?? "-"} ${startedAt.toISOString()}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { ok: true, lock: { path, pid, release: () => releaseLock(path, pid) } };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return { ok: false, reason: "error", message: (error as Error).message };
      }

      const read = await readOwner(path);
      if (!read.ok) {
        return { ok: false, reason: "error", message: `${read.reason} (refusing to guess)` };
      }

      const holder = read.owner;
      if (holder && isAlive(holder.pid)) {
        // Alive — but is it the recorded owner, or has the pid been recycled?
        // The start ticks are the only evidence that distinguishes them. When
        // both sides have ticks and they differ, the pid now belongs to another
        // process: the lock is stale whether that pid is ours or a stranger's.
        // When either side cannot tell, stay conservative and refuse.
        const currentTicks = await processStartTicks(holder.pid);
        const canTell = holder.startTicks !== undefined && currentTicks !== undefined;
        const sameProcess = !canTell || holder.startTicks === currentTicks;
        if (sameProcess) {
          return { ok: false, reason: "held", path, pid: holder.pid, alive: true };
        }
      }

      // Stale: the pid is gone, or it was recycled (same number, different
      // start ticks). Clear and retry once.
      try {
        await unlink(path);
      } catch {
        // Someone else cleaned it up first; the retry will tell.
      }
    }
  }

  return { ok: false, reason: "error", message: `could not take the lock at ${path}` };
}

export type LockInspection =
  | { state: "free" }
  | { state: "held"; pid: number }
  | { state: "error"; message: string };

/**
 * Read a lock without taking it. A dead pid, or a pid whose start ticks no
 * longer match, is free: that is what a crash leaves behind. An unreadable lock
 * is an error for the same reason `acquireLock` refuses to unlink it on a
 * guess — there is no evidence that its owner is gone.
 */
export async function inspectLock(
  dataDir: string,
  file: string = LOCK_FILE,
): Promise<LockInspection> {
  const path = lockPath(dataDir, file);
  const read = await readOwner(path);
  if (!read.ok) return { state: "error", message: read.reason };
  if (!read.owner) return { state: "free" };

  const holder = read.owner;
  // No same-pid shortcut: a lock naming this pid can be a leftover from a
  // previous boot whose pid was reused, and the start ticks are what tell them
  // apart.
  if (!isAlive(holder.pid)) return { state: "free" };

  const currentTicks = await processStartTicks(holder.pid);
  const sameProcess =
    holder.startTicks === undefined || currentTicks === undefined || holder.startTicks === currentTicks;
  return sameProcess ? { state: "held", pid: holder.pid } : { state: "free" };
}

async function releaseLock(path: string, pid: number): Promise<void> {
  // Only remove the file if it is still ours: a restarted launcher may already
  // own it, and deleting that would let a second instance in.
  const read = await readOwner(path);
  if (!read.ok || read.owner?.pid !== pid) return;
  try {
    await unlink(path);
  } catch {
    // Already gone; nothing to do.
  }
}
