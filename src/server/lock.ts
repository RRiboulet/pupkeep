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

export type LockResult =
  | { ok: true; lock: LockHandle }
  | { ok: false; reason: "held"; path: string; pid: number; alive: true }
  | { ok: false; reason: "error"; message: string };

export const LOCK_FILE = "launcher.pid";

export function lockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE);
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

async function readPid(path: string): Promise<number | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const pid = Number(text.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take the lock, or report who holds it.
 *
 * A stale file — pid gone — is replaced rather than treated as an error: a phone
 * that lost power or had Termux killed leaves one behind, and refusing to boot
 * after a normal crash would be worse than the race it protects against.
 */
export async function acquireLock(
  dataDir: string,
  pid: number = process.pid,
  startedAt: Date = new Date(),
): Promise<LockResult> {
  const path = lockPath(dataDir);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${pid} ${startedAt.toISOString()}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return { ok: true, lock: { path, pid, release: () => releaseLock(path, pid) } };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return { ok: false, reason: "error", message: (error as Error).message };
      }

      const holder = await readPid(path);
      if (holder !== undefined && holder !== pid && isAlive(holder)) {
        return { ok: false, reason: "held", path, pid: holder, alive: true };
      }

      // Stale (or our own pid from a previous incarnation): clear and retry once.
      try {
        await unlink(path);
      } catch {
        // Someone else cleaned it up first; the retry will tell.
      }
    }
  }

  return { ok: false, reason: "error", message: `could not take the lock at ${path}` };
}

async function releaseLock(path: string, pid: number): Promise<void> {
  // Only remove the file if it is still ours: a restarted launcher may already
  // own it, and deleting that would let a second instance in.
  const holder = await readPid(path);
  if (holder !== pid) return;
  try {
    await unlink(path);
  } catch {
    // Already gone; nothing to do.
  }
}
