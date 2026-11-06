// Keeping the notification outbox drained (PLAN §12.3, §16 P4-05).
//
// One watcher per server process. It drains on the commits that add intents
// (a feed, a reminder task), once at boot for anything left from a previous
// process, and on a slow retry timer for items whose backoff has elapsed. The
// drain itself coalesces: a burst of commits costs one pass, and a pass in
// flight is not started twice.
//
// A delivery failure is logged and recorded on the intent; it never fails the
// care action that wrote the intent, and it never crashes the process.

import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import type { PushConfig } from "../config.ts";
import type { JsonFileStore } from "../json-file.ts";
import type { Logger } from "../log.ts";
import { drainNotificationOutbox, type DrainOptions } from "./outbox.ts";
import type { PushTransport } from "../push/web-push.ts";

/** Retry cadence for failed items; the backoff itself lives in the outbox. */
export const OUTBOX_RETRY_MS = 5 * 60 * 1000;
/** The document whose commits ask for a drain. */
const NOTIFICATIONS_KIND = "app.notifications";

export interface NotificationOutboxWatch {
  stop(): void;
}

export interface OutboxWatchOptions {
  readonly harness: Harness;
  readonly context: Context;
  readonly push: JsonFileStore<PushConfig>;
  readonly logger: Logger;
  /** Test seams. */
  readonly now?: () => Date;
  readonly transport?: PushTransport;
  readonly retryMs?: number;
}

export function startNotificationOutbox(options: OutboxWatchOptions): NotificationOutboxWatch {
  const now = options.now ?? (() => new Date());
  const retryMs = options.retryMs ?? OUTBOX_RETRY_MS;
  let stopped = false;
  let running = false;
  let wanted = false;

  const drainOptions = (): DrainOptions => ({
    store: options.harness,
    context: options.context,
    push: options.push,
    now: now(),
    logger: options.logger,
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
  });

  const run = async (): Promise<void> => {
    if (stopped || running) {
      wanted = true;
      return;
    }
    running = true;
    try {
      do {
        wanted = false;
        try {
          const outcome = await drainNotificationOutbox(drainOptions());
          if (
            outcome.sent > 0 ||
            outcome.failed > 0 ||
            outcome.dropped > 0 ||
            outcome.removedSubscriptions > 0
          ) {
            options.logger.info("notification outbox", {
              sent: outcome.sent,
              failed: outcome.failed,
              dropped: outcome.dropped,
              skipped: outcome.skipped,
              removedSubscriptions: outcome.removedSubscriptions,
            });
          }
        } catch (error) {
          // A drain error is a delivery problem, never a care failure: report
          // it and let the retry timer try again.
          options.logger.warn("the notification outbox pass failed", { error });
        }
      } while (wanted && !stopped);
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    wanted = true;
    if (running) return;
    // A macrotask: commit listeners run on the commit path and must not queue
    // work on the line the commit holds.
    setImmediate(() => void run());
  };

  const unsubscribe = options.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type === "document" && change.record.kind === NOTIFICATIONS_KIND) {
        schedule();
        return;
      }
    }
  });

  // Boot: pending items from before this process. Not awaited here — the caller
  // logs `drain()` itself when it wants the count — but started at once.
  schedule();

  const timer = setInterval(() => schedule(), retryMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}
