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
  /** Publish the current view once, as if it had just changed. */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Start publishing profile frames. The documents are read lazily on each
 * change, so a burst of writes costs one read (and one frame) at the end.
 */
export function watchProfileState(options: ProfileStateOptions): ProfileStateWatch {
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let scheduled = false;
  let running: Promise<void> | undefined;

  const publish = async (): Promise<void> => {
    if (stopped) return;
    const profile = await readProfile(options.harness, options.context, now());
    if (stopped) return;
    options.bus.publishState({ kind: "profile", profile });
  };

  const schedule = (): void => {
    if (stopped || scheduled) return;
    scheduled = true;
    // A microtask is enough: the commit has returned by the time the listener
    // runs, so the read sees it, and a burst is already queued.
    queueMicrotask(() => {
      scheduled = false;
      if (stopped || running) return;
      running = publish()
        .catch((error: unknown) => {
          options.logger.warn("could not publish the profile state frame", { error });
        })
        .finally(() => {
          running = undefined;
        });
    });
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
    refresh: publish,
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}
