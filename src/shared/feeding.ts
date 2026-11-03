// The meal-slot shape both sides of the first-run wizard use (PLAN §8.1, §8.3).
//
// P1-14 stores the slots a household eats on; P2-01 adds the feed events and
// the service that logs against them. The slots are validated here rather than
// in the route so the HTTP surface and the document parser agree on one shape:
//
//   * a slot time is household wall-clock `HH:MM`, never an instant (§8.4);
//   * ids and labels are free-ish text, so control characters are refused — a
//     label lands in the UI and, later, in reminder copy;
//   * one meal time is not offered twice: two normal feeds at 07:00 would make
//     `(slotId, localDate)` ambiguous to a caregiver, even though the ids differ;
//   * a schedule with slots has at least one active one, so no write can leave
//     the household with a schedule that shows nothing.

import type { MealSlot } from "./domain.ts";
import { hasControlCharacter } from "./profile.ts";

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

/** 24-hour wall clock, `00:00`–`23:59`. */
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The wizard's ids (`slot-…`); opaque to the server, stable across edits. */
const SLOT_ID = /^[A-Za-z0-9._:-]+$/;

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
  if (typeof id !== "string" || id.length === 0 || id.length > SLOT_ID_LIMIT || !SLOT_ID.test(id)) return undefined;
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
