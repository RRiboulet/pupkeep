// The meal schedule and the meals logged against it (PLAN §8.1, §8.3, §8.5).
//
// P1-14 stores the slots a household eats on; P2-01 adds the feed events and
// this module's invariants. The shapes are validated here rather than in the
// route so the HTTP surface, the agent tools and the document parser agree on
// one rule set:
//
//   * a slot time is household wall-clock `HH:MM`, never an instant (§8.4);
//   * ids and labels are free-ish text, so control characters are refused — a
//     label lands in the UI and, later, in reminder copy;
//   * one meal time is not offered twice: two normal feeds at 07:00 would make
//     `(slotId, localDate)` ambiguous to a caregiver, even though the ids differ;
//   * a schedule with slots has at least one active one, so no write can leave
//     the household with a schedule that shows nothing;
//   * a normal feed claims a slot **once** per local date — the plan's "partial
//     unique index" (§7.3, §8.5), which lives in this JSON document as a parser
//     invariant because the events are not a SQLite table. Extra feedings have
//     no slot and never claim one.
//
// What this module does **not** decide: whether an event's `localDate` matches
// its `at` in the household's current zone. That is a write-time rule (§8.5:
// never client input) and a zone change must not make yesterday's meals
// unreadable; P2-02's service derives the date when it appends.

import type { FeedEvent, Feeding, MealSlot } from "./domain.ts";
import { isLocalDate, hasControlCharacter } from "./profile.ts";
import { HOUSEHOLD_FALLBACK_LABEL } from "./chat.ts";
import { isIsoInstant } from "./domain.ts";

/** Most meals a schedule may hold; a puppy eating more than this is a typo. */
export const MEAL_SLOTS_MAX = 12;
export const SLOT_ID_LIMIT = 64;
export const SLOT_LABEL_LIMIT = 40;
export const SLOT_PORTION_LIMIT = 80;

/**
 * The one sentence a refused schedule answers with. It is shared rather than
 * re-typed in the route and the writer, so the caregiver reads one rule and a
 * later edit cannot fix only one copy.
 */
export const MEAL_SCHEDULE_RULE =
  "a meal schedule needs 1 to 12 slots, each with a label and an HH:MM time, at least one active, and no two at the same time";

/** Field caps for one logged meal; a note longer than this is a diary, not a meal. */
export const FEED_ID_LIMIT = 64;
/** Matches `COMMAND_KEY_LIMIT`: `http:<key>` or `tool:<taskId>`. */
export const FEED_ACTION_ID_LIMIT = 120;
/** The same bound as a slot's planned portion: both describe the same quantity. */
export const FEED_AMOUNT_LIMIT = SLOT_PORTION_LIMIT;
export const FEED_NOTE_LIMIT = 280;
// `byLabel` and `byUserId` are deliberately **uncapped**. They mirror a member
// profile (`app.household.members`) and a config member id; the roster parser
// (`parseMemberProfiles`) does not cap a name's length, and a hand-edited
// `config.json` can carry any id, so a cap here could turn a legitimate member
// into a document the parser refuses — and a refused `app.feeding` fails boot
// (§8.1). The invite route does cap a *new* display name at 64 characters;
// this reader must not assume that every stored profile came through it. The
// rule is therefore the roster's: non-empty, trimmed, free of control
// characters.

/**
 * 24-hour wall clock, `00:00`–`23:59`. The three calendar types live in their
 * document's home: this one, `isLocalDate` in `profile.ts`, and
 * `isIsoInstant` in `domain.ts`.
 */
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/**
 * The charset for every opaque id in this document: a slot's (`slot-…`), a
 * logged meal's, and its action id (`http:<key>` / `tool:<taskId>`). Opaque to
 * the server, stable across edits.
 */
const OPAQUE_ID = /^[A-Za-z0-9._:-]+$/;

/** True for a household wall-clock time, `HH:MM` on a 24-hour clock. */
export function isLocalTime(value: unknown): value is string {
  return typeof value === "string" && LOCAL_TIME.test(value);
}

export function parseMealSlot(raw: unknown): MealSlot | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  // Unknown keys are refused rather than ignored: a typo in a client is
  // visible, and a future field cannot slip into the document unvalidated.
  if (keys.some((key) => !["id", "label", "timeLocal", "portion", "active"].includes(key))) return undefined;

  const { id, label, timeLocal, active } = record;
  if (typeof id !== "string" || id.length === 0 || id.length > SLOT_ID_LIMIT || !OPAQUE_ID.test(id)) return undefined;
  if (typeof label !== "string") return undefined;
  const trimmedLabel = label.trim();
  if (trimmedLabel === "" || trimmedLabel.length > SLOT_LABEL_LIMIT) return undefined;
  if (hasControlCharacter(trimmedLabel)) return undefined;
  if (!isLocalTime(timeLocal)) return undefined;
  if (typeof active !== "boolean") return undefined;

  const slot: MealSlot = { id, label: trimmedLabel, timeLocal, active };
  if (record.portion !== undefined && record.portion !== null) {
    if (typeof record.portion !== "string") return undefined;
    const portion = record.portion.trim();
    if (portion.length > SLOT_PORTION_LIMIT || hasControlCharacter(portion)) return undefined;
    // An empty portion is "not set", not an empty string in the document.
    if (portion !== "") slot.portion = portion;
  }
  return slot;
}

function parseSlotList(raw: unknown, minimum: number): MealSlot[] | undefined {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > MEAL_SLOTS_MAX) return undefined;
  const slots: MealSlot[] = [];
  const ids = new Set<string>();
  const times = new Set<string>();
  for (const item of raw) {
    const slot = parseMealSlot(item);
    if (!slot) return undefined;
    if (ids.has(slot.id) || times.has(slot.timeLocal)) return undefined;
    ids.add(slot.id);
    times.add(slot.timeLocal);
    slots.push(slot);
  }
  // A schedule that exists must show at least one meal.
  if (slots.length > 0 && !slots.some((slot) => slot.active)) return undefined;
  return slots;
}

/**
 * A write's schedule: one to `MEAL_SLOTS_MAX` slots, at least one active. The
 * first-run wizard cannot finish without it (§16 P1-14).
 */
export function parseMealSlots(raw: unknown): MealSlot[] | undefined {
  return parseSlotList(raw, 1);
}

/**
 * A stored schedule. A fresh document has none yet, so zero is allowed; every
 * later write passes through `parseMealSlots`.
 */
export function parseStoredMealSlots(raw: unknown): MealSlot[] | undefined {
  return parseSlotList(raw, 0);
}

// --- logged meals (P2-01) ---------------------------------------------------

const FEED_SOURCES = ["ui", "agent"] as const;
const FEED_KEYS = ["id", "slotId", "localDate", "at", "amount", "note", "byUserId", "byLabel", "source", "actionId"];

/**
 * Trim and validate one free-text field. `null` means "not set" (omit it from
 * the stored value); `undefined` means the value is malformed.
 */
/**
 * A member label or id as the roster/config world wrote it: non-empty, trimmed,
 * no control characters, no length cap (see `FEED_AMOUNT_LIMIT`'s note above
 * `byLabel`), and never `null` — callers that allow "not set" use `cleanText`.
 */
function displayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

function cleanText(value: unknown, limit: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > limit || hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

/** One event as stored: shape only; list-level invariants are checked below. */
export function parseFeedEvent(raw: unknown): FeedEvent | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !FEED_KEYS.includes(key))) return undefined;

  const { id, slotId, localDate, at, byUserId, byLabel, source, actionId } = record;
  if (typeof id !== "string" || id.length === 0 || id.length > FEED_ID_LIMIT || !OPAQUE_ID.test(id)) return undefined;

  let claimed: string | null;
  if (slotId === null) claimed = null;
  else if (typeof slotId === "string" && slotId.length > 0 && slotId.length <= SLOT_ID_LIMIT && OPAQUE_ID.test(slotId)) {
    claimed = slotId;
  } else return undefined;

  if (!isLocalDate(localDate)) return undefined;
  if (!isIsoInstant(at)) return undefined;

  const amount = cleanText(record.amount, FEED_AMOUNT_LIMIT);
  if (amount === undefined) return undefined;
  const note = cleanText(record.note, FEED_NOTE_LIMIT);
  if (note === undefined) return undefined;

  let memberId: string | null;
  if (byUserId === null) memberId = null;
  else {
    memberId = displayText(byUserId) ?? null;
    if (memberId === null) return undefined;
  }

  const label = displayText(byLabel);
  if (label === undefined) return undefined;
  // The same fence as a transcript tool card (§9.2, §15.3): no member id always
  // travels with the household label, so a care record can never show
  // "Household" as if it were a person. A real member's label is whatever the
  // household called them.
  if (memberId === null && label !== HOUSEHOLD_FALLBACK_LABEL) return undefined;

  if (!FEED_SOURCES.includes(source as (typeof FEED_SOURCES)[number])) return undefined;

  if (typeof actionId !== "string" || actionId.length === 0 || actionId.length > FEED_ACTION_ID_LIMIT) {
    return undefined;
  }
  if (!OPAQUE_ID.test(actionId)) return undefined;

  const event: FeedEvent = {
    id,
    slotId: claimed,
    localDate,
    at,
    byUserId: memberId,
    byLabel: label,
    source: source as FeedEvent["source"],
    actionId,
  };
  if (amount !== null) event.amount = amount;
  if (note !== null) event.note = note;
  return event;
}

/**
 * A stored event list in append order. Zero events is valid (a fresh
 * household); a repeated slot on the same date or a repeated event id is not —
 * those are the invariants P2-02's service relies on to answer a double feed
 * with a conflict instead of a duplicate.
 *
 * Two things are deliberately **not** invariants:
 *
 *   * **order.** `at` comes from the server clock, and a backward clock jump
 *     (NTP, a timezone tool, a restore) must not make the document unreadable
 *     or block the next meal; `feedingDay` sorts by `at` where a reader needs
 *     chronological order.
 *   * **`actionId` uniqueness.** It is tempting to make the idempotency key a
 *     permanent document invariant, but the key lives in `app.commands` with a
 *     24 h TTL (§7.3): a key reused after that window is legal for the service
 *     and would then make the document fail to parse — a boot failure caused by
 *     a client key. P2-02 owns the answer (replay inside the window, the
 *     slot+date conflict outside it); the document only guarantees unique ids.
 *
 * The original version of this comment also claimed order was an invariant; it
 * is not, and a reader who adds that check would reintroduce the clock-jump
 * wedge. `at` comes from the server clock,
 * and a backward clock jump (NTP, a timezone tool, a restore) must not make the
 * document unreadable or block the next meal; `feedingDay` sorts by `at` where
 * a reader needs chronological order.
 */
export function parseFeedEvents(raw: unknown): FeedEvent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const events: FeedEvent[] = [];
  const ids = new Set<string>();
  const claimed = new Set<string>();
  for (const item of raw) {
    const event = parseFeedEvent(item);
    if (!event) return undefined;
    if (ids.has(event.id)) return undefined;
    // The partial unique index: one normal feed per (slotId, localDate).
    if (event.slotId !== null) {
      const key = `${event.localDate}\u0000${event.slotId}`;
      if (claimed.has(key)) return undefined;
      claimed.add(key);
    }
    ids.add(event.id);
    events.push(event);
  }
  return events;
}

// --- one day's view (P2-01's pure half; P2-03/P2-04 serve it) ---------------

/** One active slot and the normal feed that claimed it today, if any. */
export type FeedingDaySlot = {
  slot: MealSlot;
  feed: FeedEvent | null;
};

/**
 * What a day looks like on the household's calendar: the active slots in time
 * order with the feed that claimed each, plus the extras. `events` carries
 * every event filed under the date, including one whose slot has since been
 * removed or deactivated — history is not rewritten when the schedule changes.
 */
export type FeedingDay = {
  localDate: string;
  events: FeedEvent[];
  slots: FeedingDaySlot[];
  extras: FeedEvent[];
};

/**
 * Build one day from the committed document. Pure: the caller supplies the
 * household-local date (derived from an instant with `localDateAt`, never from
 * a browser), so no clock or zone is guessed here. "Overdue" is not computed —
 * that needs a server-local "now" and belongs to the day route (P2-03/P2-05).
 */
export function feedingDay(feeding: Feeding, localDate: string): FeedingDay {
  if (!isLocalDate(localDate)) throw new Error(`not a local date: ${localDate}`);
  const events = feeding.events
    .filter((event) => event.localDate === localDate)
    .slice()
    .sort((a, b) => {
      const byTime = Date.parse(a.at) - Date.parse(b.at);
      return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const slots = feeding.slots
    .filter((slot) => slot.active)
    .slice()
    .sort((a, b) => (a.timeLocal < b.timeLocal ? -1 : a.timeLocal > b.timeLocal ? 1 : 0))
    .map((slot) => ({ slot, feed: events.find((event) => event.slotId === slot.id) ?? null }));
  return {
    localDate,
    events,
    slots,
    extras: events.filter((event) => event.slotId === null),
  };
}
