// `/healthz`: the honest answer behind `/health`'s liveness.
//
// `/health` is what the container's HEALTHCHECK reads, so it must stay a cheap
// "the event loop runs" answer: a wedged database would otherwise restart the
// container in a loop instead of being reported. `/healthz` is the operator's
// and the outside probe's answer (PLAN R8), so it does the two checks that turn
// "the process is up" into "the app can still do its job":
//
//   * a read that must reach SQLite. A lookup of one conversation row is the
//     cheapest honest read: it goes through the Session's serialized read line
//     — the same line a route's read and a care commit's document load use —
//     and, unlike a document snapshot, it cannot be answered from the Session's
//     in-memory document cache. A read that never answers is as dead as one that
//     throws, hence the bound.
//   * a free-disk floor on the data directory. The WAL, the backup staging
//     directory and the archives all live there, so a filesystem with no room is
//     an app that will fail its next write.
//
// The answer names the failed checks and nothing else: §14.2 forbids a path, a
// version or a count in a body, and this one is unauthenticated.

import { statfs } from "node:fs/promises";

/**
 * 64 MiB. The largest single write the app makes is a backup archive plus a WAL
 * checkpoint — measured at 4.9 MiB and 162 KiB at 500 days of household data
 * (`docs/data-growth.md`) — so this leaves an order of magnitude of headroom,
 * while staying far enough below a small VPS's free space that a false alarm
 * does not become the alarm that gets ignored.
 */
export const HEALTH_DISK_FLOOR_BYTES = 64 * 1024 * 1024;

/**
 * How long the storage read may take before it counts as wedged. The
 * connection's `busy_timeout` is 5000 ms (`src/server/harness.ts`), so a read
 * waiting on a lock answers inside that; this bound is for a handle that never
 * answers at all. It is also well above every measured commit (62 ms median on
 * the phone, 111 ms at 1 500 feeds on this host), so a slow commit is not
 * mistaken for a dead database.
 */
export const HEALTH_STORAGE_TIMEOUT_MS = 3000;

export type HealthCheck = "storage" | "disk";

export interface HealthInput {
  /** A read that must reach the open SQLite handle; never served from a cache. */
  readonly readStorage: () => Promise<unknown>;
  /** The data directory whose filesystem every write lands on. */
  readonly dataDir: string;
  /** Test seam: a test cannot fill a disk, so it supplies the free-byte count. */
  readonly freeBytes?: (directory: string) => Promise<number>;
  /** The storage bound; a test that proves the wedge path shortens it. */
  readonly storageTimeoutMs?: number;
}

export interface HealthReport {
  /** True only when every check passed. */
  readonly ok: boolean;
  /** The failed checks, in a fixed order; empty when `ok`. */
  readonly failed: readonly HealthCheck[];
}

/**
 * Bytes an unprivileged writer may still use on the filesystem holding
 * `directory`. `bavail`, not `bfree`: the reserved blocks are exactly the space
 * this process — uid 10001 in the container, the app's user on the phone —
 * cannot have. `frsize` is the fundamental block size, so the product is bytes.
 */
export async function freeDiskBytes(directory: string): Promise<number> {
  const stats = await statfs(directory);
  return stats.bavail * stats.frsize;
}

/**
 * True when the read answers inside `timeoutMs`. Both sides of the race settle
 * and the losing read is caught, so a handle that answers long after the bound
 * (or never) cannot become an unhandled rejection.
 */
async function storageAnswers(read: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    // The timer must not be the only thing keeping the process alive.
    timer.unref?.();
  });
  const attempt = (async () => {
    try {
      await read();
      return true;
    } catch {
      // A closed, failed or refusing handle: the read is what proves it works,
      // so its refusal is the answer. The error text stays out of the body.
      return false;
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function diskHasRoom(input: HealthInput): Promise<boolean> {
  try {
    const free = await (input.freeBytes ?? freeDiskBytes)(input.dataDir);
    return free >= HEALTH_DISK_FLOOR_BYTES;
  } catch {
    // A `statfs` that fails is not room: a vanished mount or a permission error
    // fails the next write the same way.
    return false;
  }
}

/** Both checks, always both: one failure must not hide the other. */
export async function checkHealth(input: HealthInput): Promise<HealthReport> {
  const [storage, disk] = await Promise.all([
    storageAnswers(input.readStorage, input.storageTimeoutMs ?? HEALTH_STORAGE_TIMEOUT_MS),
    diskHasRoom(input),
  ]);
  const failed: HealthCheck[] = [];
  if (!storage) failed.push("storage");
  if (!disk) failed.push("disk");
  return { ok: failed.length === 0, failed };
}
