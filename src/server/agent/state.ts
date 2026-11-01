// Live care state over the shared SSE stream (PLAN §9.4, §8.1).
//
// Both caregivers must see each other's profile edit without a reload, and the
// PWA already holds one authenticated event stream for the thread. Rather than
// add a second endpoint (and a second connection cap, and a second reconnect
// story), this watches the committed documents and pushes one `profile` frame
// through the bus that already exists. P2's meals and P3's growth join the same
// frame as their views land.
//
// Two subtleties:
//   * `subscribeCommits` listeners run synchronously on the commit path and may
//     not call Session APIs, so the frame is built from a later read and the
//     work is coalesced: ten rapid commits produce one frame, not ten;
//   * a listener that throws would be reported as a `listener_error` and the
//     watcher would look dead, so every failure is caught and logged.

import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import type { Logger } from "../log.ts";
import { readProfile } from "../domain/profile.ts";
import type { ThreadBus } from "./bus.ts";

/** Document kinds whose change makes the profile frame stale. */
const PROFILE_KINDS = new Set(["app.puppy", "app.household"]);

export interface ProfileStateOptions {
  readonly harness: Harness;
  readonly context: Context;
  readonly bus: Pick<ThreadBus, "publishState">;
  readonly logger: Logger;
  /** Test seam; the wall clock otherwise. */
  readonly now?: () => Date;
}

export interface ProfileStateWatch {
  stop(): void;
}

/**
 * Start publishing profile frames. The documents are read lazily on each
 * change, so a burst of writes costs one read (and one frame) at the end.
 */
export function watchProfileState(options: ProfileStateOptions): ProfileStateWatch {
  const now = options.now ?? (() => new Date());
  let stopped = false;
  /** A commit arrived that no published frame reflects yet. */
  let dirty = false;
  let running = false;

  const publish = async (): Promise<void> => {
    if (stopped) return;
    // Coalesced by the loop in `run`: the read takes the latest documents, so a
    // commit that lands while it is in flight is picked up by the next pass
    // instead of being published out of order.
    const profile = await readProfile(options.harness, options.context, now());
    if (stopped) return;
    options.bus.publishState({ kind: "profile", profile });
  };

  const run = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        await publish();
      }
    } catch (error) {
      // Not retried in a loop: a broken read would spin. The next commit (or a
      // reload) tries again, and the line makes the failure visible.
      dirty = false;
      options.logger.warn("could not publish the profile state frame", { error });
    } finally {
      running = false;
      // A commit that landed during the last await still gets its frame.
      if (dirty && !stopped) void run();
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    dirty = true;
    if (running) return;
    // A macrotask, not a microtask: `subscribeCommits` runs while the commit is
    // being adopted, and this read must not queue on the mutation line the
    // commit still holds.
    setImmediate(() => void run());
  };

  const unsubscribe = options.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type === "document" && PROFILE_KINDS.has(change.record.kind)) {
        schedule();
        return;
      }
    }
  });

  return {
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}
