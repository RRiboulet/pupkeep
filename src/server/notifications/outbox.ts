// The notification outbox (PLAN §12.3, §14.3, §16 P4-05).
//
// Intents are committed by the care action (or a reminder task's terminal
// commit) with the server dedupe key authoritative. This module drains the ones
// that still owe a push:
//
//   * only `pending`, and `failed` items whose backoff has elapsed, are tried;
//   * an item for a member with no device subscription is **skipped**, not
//     failed: the in-app item is already visible and P4-06's ntfy may deliver it;
//   * an item whose member disabled the category is **dropped**: never sent,
//     but never deleted (the in-app centre still shows it);
//   * a 404/410 removes the dead subscription; other failures are recorded with
//     an attempt count and a bounded error, and retried with backoff.
//
// Delivery is at-least-once: marking happens after the send, so a crash between
// the two can resend. The push payload's `tag` (the dedupe key) collapses the
// duplicate on the device. The alternative — mark first — could silently lose a
// reminder, which is worse for a care app.
//
// The delivery fields are written in one commit that re-reads the document, so
// an item appended while the sends were in flight is not clobbered, and an item
// another drain already marked sent is left alone.

import type { Context } from "@earendil-works/chord";
import type { PushConfig } from "../config.ts";
import type { NotificationDelivery, NotificationIntent } from "../../shared/domain.ts";
import { NotificationsDoc, parseNotifications, type DocStore } from "../domain/docs.ts";
import type { JsonFileStore } from "../json-file.ts";
import type { Logger } from "../log.ts";
import { ensureVapid } from "../push/vapid.ts";
import { sendWebPush, type PushTransport } from "../push/web-push.ts";
import { sendNtfy, type NtfyTransport } from "./ntfy.ts";
import { sendTermux, type ExecFile } from "./termux.ts";

/** Give up after this many failed attempts; the in-app item remains. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** First retry delay; doubles per attempt up to the cap. */
export const OUTBOX_BACKOFF_MS = 60_000;
export const OUTBOX_MAX_BACKOFF_MS = 30 * 60_000;
/** §12.3's "bounded error": a sentence, never a provider payload. */
export const OUTBOX_ERROR_LIMIT = 200;

export type OutboxOutcome = {
  sent: number;
  failed: number;
  dropped: number;
  skipped: number;
  removedSubscriptions: number;
};

const NOTHING: OutboxOutcome = { sent: 0, failed: 0, dropped: 0, skipped: 0, removedSubscriptions: 0 };

function backoffMs(attempts: number): number {
  return Math.min(OUTBOX_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_MAX_BACKOFF_MS);
}

/** Whether an intent may be attempted now. */
export function deliverableDelivery(delivery: NotificationDelivery, now: Date): boolean {
  if (delivery.state === "pending") return true;
  if (delivery.state !== "failed" || delivery.attempts >= OUTBOX_MAX_ATTEMPTS) return false;
  if (delivery.lastAttemptAt === null) return true;
  return Date.parse(delivery.lastAttemptAt) + backoffMs(delivery.attempts) <= now.getTime();
}

/**
 * A member's push preference for one category. No prefs entry means the
 * default: enabled for every §12.1 category. `push.json`'s parser accepts the
 * full vocabulary, including categories this build does not send yet.
 */
export function pushEnabledFor(config: Pick<PushConfig, "prefs">, memberId: string, category: string): boolean {
  const prefs = config.prefs[memberId];
  if (!prefs) return true;
  return prefs.enabled && (prefs.categories as readonly string[]).includes(category);
}

function errorText(error: string | undefined, status: number | null | undefined): string {
  const raw = error ?? (status !== undefined && status !== null ? `push service answered ${status}` : "push failed");
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, OUTBOX_ERROR_LIMIT);
}

export type DrainOptions = {
  readonly store: DocStore;
  readonly context: Context;
  readonly push: JsonFileStore<PushConfig>;
  readonly now?: Date;
  /** Test seam; the global `fetch` otherwise. */
  readonly transport?: PushTransport;
  /** ntfy (the partner's daily path). Absent: ntfy is not attempted. */
  readonly ntfy?: { baseUrl?: string; transport?: NtfyTransport };
  /**
   * The host phone's Termux:API transport for the member who runs the server.
   * Absent off-Termux, which leaves the intent to push/ntfy/in-app.
   */
  readonly termux?: { memberId: string; exec: ExecFile; channelReady: boolean };
  readonly logger?: Pick<Logger, "warn">;
};

/**
 * One pass over the outbox. Safe to call from a commit watcher, boot and a
 * periodic retry: the delivery fields are idempotent and the dedupe key is the
 * server's.
 */
export async function drainNotificationOutbox(options: DrainOptions): Promise<OutboxOutcome> {
  const now = options.now ?? new Date();
  const snapshot = await options.store.snapshot(NotificationsDoc, options.context);
  const document = snapshot === undefined ? undefined : parseNotifications(snapshot);
  if (document === undefined) return NOTHING;

  const candidates = document.items.filter((intent) => deliverableDelivery(intent.delivery, now));
  if (candidates.length === 0) return NOTHING;

  let config: PushConfig;
  try {
    config = await options.push.read();
  } catch (error) {
    options.logger?.warn("could not read push.json; notifications wait", { error });
    return { ...NOTHING, skipped: candidates.length };
  }
  // The key pair is needed only by Web Push; ntfy and the host's Termux:API do
  // not depend on it, so an unwritable key store must not stop them.
  let vapid = config.vapid;
  if (vapid === null) {
    try {
      vapid = await ensureVapid(options.push);
    } catch (error) {
      options.logger?.warn("could not prepare the Web Push key pair; push is skipped", { error });
    }
  }
  const gone = new Set<string>();
  const deliveries = new Map<string, NotificationDelivery>();
  let sent = 0;
  let failed = 0;
  let dropped = 0;
  let skipped = 0;

  for (const intent of candidates) {
    if (!pushEnabledFor(config, intent.userId, intent.category)) {
      deliveries.set(intent.id, {
        state: "dropped",
        attempts: intent.delivery.attempts,
        lastAttemptAt: now.toISOString(),
      });
      dropped += 1;
      continue;
    }
    const subscriptions = config.subscriptions.filter(
      (subscription) => subscription.memberId === intent.userId && !gone.has(subscription.endpoint),
    );
    const topic = config.ntfy[intent.userId]?.topic;
    const host = options.termux !== undefined && options.termux.memberId === intent.userId;
    if (subscriptions.length === 0 && topic === undefined && !host) {
      // No device, no topic and not the host: not a delivery failure. The in-app
      // item is already visible and stays owed.
      skipped += 1;
      continue;
    }

    let delivered = false;
    let lastError: string | undefined;
    let lastStatus: number | null = null;
    // The transport chain: Web Push, then ntfy, then the host's Termux:API. A
    // transport that succeeds stops the chain, so a member with two configured
    // paths is not notified twice.
    if (subscriptions.length > 0 && vapid === null) {
      lastError = "the Web Push key pair is unavailable";
    }
    for (const subscription of subscriptions) {
      if (vapid === null) break;
      const result = await sendWebPush(
        subscription,
        { title: intent.title, tag: intent.dedupeKey, url: "/" },
        vapid,
        { now, ...(options.transport !== undefined ? { transport: options.transport } : {}) },
      );
      if (result.kind === "sent") delivered = true;
      else if (result.kind === "gone") {
        gone.add(subscription.endpoint);
        lastStatus = result.status;
      } else if (result.status === null) {
        // A local failure (an unusable key, an encryption error) is permanent
        // for this subscription: retrying it would burn the intent's attempts
        // forever. Remove it like a gone endpoint.
        gone.add(subscription.endpoint);
        lastError = result.error;
      } else {
        lastStatus = result.status;
        lastError = result.error;
      }
    }
    if (!delivered && topic !== undefined) {
      const result = await sendNtfy(topic, intent.category, {
        ...(options.ntfy?.baseUrl !== undefined ? { baseUrl: options.ntfy.baseUrl } : {}),
        ...(options.ntfy?.transport !== undefined ? { transport: options.ntfy.transport } : {}),
      });
      if (result.kind === "sent") delivered = true;
      else {
        lastStatus = result.status;
        lastError = result.error ?? (result.status !== null ? `ntfy answered ${result.status}` : "ntfy failed");
      }
    }
    if (!delivered && host && options.termux !== undefined) {
      const sent = await sendTermux(
        options.termux.exec,
        { dedupeKey: intent.dedupeKey, category: intent.category },
        options.termux.channelReady,
      );
      if (sent) delivered = true;
      else lastError = "the host notification command failed";
    }

    const attempts = intent.delivery.attempts + 1;
    if (delivered) {
      deliveries.set(intent.id, {
        state: "sent",
        attempts,
        lastAttemptAt: now.toISOString(),
        sentAt: now.toISOString(),
      });
      sent += 1;
    } else {
      deliveries.set(intent.id, {
        state: "failed",
        attempts,
        lastAttemptAt: now.toISOString(),
        lastError: errorText(lastError, lastStatus),
      });
      failed += 1;
    }
  }

  if (deliveries.size > 0) {
    await options.store.commit(async (tx) => {
      const draft = await tx.doc(NotificationsDoc);
      const items = draft.items.map((intent) => {
        const delivery = deliveries.get(intent.id);
        // Never overwrite a sent item: another drain may have won the race, and
        // a failed retry must not un-send it.
        if (delivery === undefined || intent.delivery.state === "sent") return intent;
        return { ...intent, delivery };
      });
      const parsed = parseNotifications({ ...draft, items });
      if (parsed === undefined) {
        options.logger?.warn("the notification outbox produced an unreadable document; nothing was marked");
        return;
      }
      draft.items = parsed.items;
    }, options.context);
  }

  if (gone.size > 0) {
    // The push service said the endpoint is gone (a reinstalled browser, a
    // revoked permission). Remove it; the intent is already recorded as failed
    // or sent above.
    await options.push.update((current) => ({
      ...current,
      subscriptions: current.subscriptions.filter((subscription) => !gone.has(subscription.endpoint)),
    }));
  }

  return { sent, failed, dropped, skipped, removedSubscriptions: gone.size };
}
