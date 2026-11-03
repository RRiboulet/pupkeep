// Notification intents: the categories and the one parser (PLAN §12.3, §14.3).
//
// P2-02 commits an intent in the same transaction as the care action that caused
// it; P4-05 adds the outbox that drains intents into pushes and the delivery
// loop. What this module fixes now:
//
//   * **category text only** — `title` comes from this catalog and is the only
//     text a push or ntfy body may carry. `body` is in-app copy built by app
//     code and must never be pushed (§14.3: no care specifics in a push body);
//   * **the dedupe key is the server's**, not a client's: one key, one intent,
//     and a repeated key is dropped rather than shown twice (§12.3);
//   * a reader that never prunes unread items cannot lose a notification (§8.5).
//
// Two rules that are easy to break later:
//   * **the catalog text is document-frozen.** A stored intent's title must equal
//     its category's catalog string, so rewording an entry needs a document
//     version bump and a `migrate` — otherwise every existing item fails to
//     parse and the next boot refuses the document (P4-05 owns that migration).
//   * **display text is not capped, only checked.** A member name and a config id
//     are uncapped where they are written (the roster parser and `config.json`),
//     so a cap here would turn a long name into a document the parser refuses —
//     a boot failure caused by a profile. `title` is code-owned and stays bounded.

import type { NotificationIntent } from "./domain.ts";
import { OPAQUE_ID_PATTERN, isIsoInstant } from "./domain.ts";
import { hasControlCharacter } from "./profile.ts";

/**
 * §12.1's vocabulary: every category a caregiver's notification settings may
 * offer. `push.json`'s per-member prefs validate against all of it, including
 * the categories this build cannot deliver yet, so settings never shrink to the
 * writable subset below.
 */
export const NOTIFICATION_CATEGORIES = [
  "appointment",
  "feed_overdue",
  "fed",
  "approval",
  "test",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * The categories this build commits intents for — P2-02 writes `fed`; P4-05 adds
 * the reminder and approval ones. The intent parser refuses anything else: a
 * Phase 2 build must not store an intent it cannot deliver. Widening the set
 * also needs a `NOTIFICATION_TITLES` entry; the document version bump is for
 * changing that catalog's text or the intent's shape, not for the widening.
 */
export const NOTIFICATION_INTENT_CATEGORIES = ["fed"] as const satisfies readonly NotificationCategory[];
export type NotificationIntentCategory = (typeof NOTIFICATION_INTENT_CATEGORIES)[number];

/** Category-only titles: the only text allowed in a push or ntfy body. */
export const NOTIFICATION_TITLES: Readonly<Record<NotificationIntentCategory, string>> = Object.freeze({
  fed: "A meal was logged",
});

/** §8.5: the household keeps its newest 500 read items; unread are never dropped. */
export const NOTIFICATION_LIMIT = 500;
export const NOTIFICATION_ID_LIMIT = 64;
/** Code-owned catalog text; not derived from a caregiver's input. */
export const NOTIFICATION_TITLE_LIMIT = 80;

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > limit || hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

/** Uncapped display text: non-empty, trimmed, no control characters. */
function displayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

/**
 * A dedupe key from its parts. Every part is percent-encoded and joined with
 * `|`, which none of the parts can then contain — so `("a:b", "c")` and
 * `("a", "b:c")` cannot collapse into one key and silently drop an intent.
 */
export function notificationKey(...parts: readonly string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join("|");
}

/** One intent as stored, or `undefined` for a shape this build does not accept. */
export function parseNotificationIntent(raw: unknown): NotificationIntent | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const keys = ["id", "dedupeKey", "category", "userId", "title", "body", "createdAt", "readAt"];
  if (Object.keys(record).some((key) => !keys.includes(key))) return undefined;

  const { id, dedupeKey, category, userId, readAt } = record;
  if (typeof id !== "string" || id.length === 0 || id.length > NOTIFICATION_ID_LIMIT || !OPAQUE_ID_PATTERN.test(id)) {
    return undefined;
  }
  const key = displayText(dedupeKey);
  if (key === undefined) return undefined;
  if (!(NOTIFICATION_INTENT_CATEGORIES as readonly string[]).includes(category as string)) return undefined;
  const user = displayText(userId);
  if (user === undefined) return undefined;
  const title = text(record.title, NOTIFICATION_TITLE_LIMIT);
  if (title === undefined) return undefined;
  const body = displayText(record.body);
  if (body === undefined) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
  if (readAt !== null && !isIsoInstant(readAt)) return undefined;

  return {
    id,
    dedupeKey: key,
    category: category as NotificationIntent["category"],
    userId: user,
    title,
    body,
    createdAt: record.createdAt,
    readAt,
  };
}

/**
 * A stored intent list: one parser for the document and for callers that build a
 * batch, mirroring `parseFeedEvents`. Keys and ids are unique (a duplicate key
 * would make the dedupe ambiguous), and each intent's title must be its
 * category's catalog text.
 */
export function parseNotificationIntents(raw: unknown): NotificationIntent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: NotificationIntent[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const item of raw) {
    const intent = parseNotificationIntent(item);
    if (!intent) return undefined;
    if (ids.has(intent.id) || keys.has(intent.dedupeKey)) return undefined;
    if (NOTIFICATION_TITLES[intent.category] !== intent.title) return undefined;
    ids.add(intent.id);
    keys.add(intent.dedupeKey);
    items.push(intent);
  }
  return items;
}

/**
 * Append intents, dropping ones whose dedupe key is already present and then
 * enforcing §8.5's retention: an unread item is never pruned; among read items
 * the newest `NOTIFICATION_LIMIT` are kept. In Phase 2 nothing is read yet, so
 * this keeps everything — the delivery state that makes pruning meaningful is
 * P4-05's.
 */
export function appendIntents(
  existing: readonly NotificationIntent[],
  incoming: readonly NotificationIntent[],
  limit = NOTIFICATION_LIMIT,
): NotificationIntent[] {
  const keys = new Set(existing.map((intent) => intent.dedupeKey));
  const added: NotificationIntent[] = [];
  for (const intent of incoming) {
    if (keys.has(intent.dedupeKey)) continue;
    keys.add(intent.dedupeKey);
    added.push(intent);
  }
  const all = [...existing, ...added];
  if (all.length <= limit) return all;

  const unread = all.filter((intent) => intent.readAt === null);
  // `slice(-0)` is `slice(0)`, which keeps every read item; so does a
  // fractional or NaN limit, which `slice` also maps to `0`.
  if (!Number.isInteger(limit) || limit <= 0) return unread;
  const read = all.filter((intent) => intent.readAt !== null).slice(-limit);
  // Keep document order: unread items are the ones a caregiver still has to see.
  const keep = new Set<NotificationIntent>([...unread, ...read]);
  return all.filter((intent) => keep.has(intent));
}
