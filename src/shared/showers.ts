// `app.showers` and its invariants (PLAN §8.1, §8.4, §9.2, §7.3, §16 P3-06).
//
// A shower is an observation, not a claim: nothing is unique per day, so a
// second rinse on the same afternoon is legitimate and needs no conflict
// (contrast a feed, which claims a meal). What this module fixes:
//
//   * **the date is a household-local calendar date**, derived at write time
//     from the server clock in the household zone (§8.4) and stored with the
//     record — never re-derived from `at`, so a household that moves zones does
//     not have its shower dates re-dated.
//   * **the next due date is derived, never stored**: the latest shower's local
//     date plus `app.household.settings.showerIntervalDays` (the plan's one
//     source for the interval, on the household document). A date question uses
//     dates: the "latest" shower is the one with the greatest stored
//     `localDate` (ties by `at`), not simply the greatest instant — after a
//     westward zone change those two can disagree, and the calendar is what a
//     due date means.
//   * **history is append-only and unordered**: readers sort; a clock jump must
//     not make the document unreadable or invent a negative interval.
//   * the two text fields are one line each, bounded and control-character
//     free, and the §9.2 pairing holds on the record.
//
// `actionId` uniqueness is deliberately not a document rule: the key is 24
// h-scoped in `app.commands` (§7.3), so a reused key must not make
// `app.showers` unreadable — the service answers it.

import type { Household, Shower, Showers } from "./domain.ts";
import { OPAQUE_ID_PATTERN, isIsoInstant } from "./domain.ts";
import { HOUSEHOLD_FALLBACK_LABEL } from "./chat.ts";
import { hasControlCharacter, isLocalDate } from "./profile.ts";
import { dateMinusDays, daysBetween } from "./dates.ts";

/** `SHOWER_ID_LIMIT` is the opaque-id bound; the action id matches `COMMAND_KEY_LIMIT`. */
export const SHOWER_ID_LIMIT = 64;
export const SHOWER_ACTION_ID_LIMIT = 120;
/** One shampoo name and one note: a line each, not a diary. */
export const SHAMPOO_LIMIT = 80;
export const SHOWER_NOTES_LIMIT = 280;

/** The one sentence a refused shower answers with (route and tool). */
export const SHOWER_RULE =
  "a shower is optional shampoo and note text, one line each (shampoo up to 80 characters, notes up to 280); the date and who logged it come from the server";

/** The fields a shower write carries, normalised once: empty text is absent. */
export type ShowerFields = {
  shampoo?: string;
  notes?: string;
};

export function parseShowerFields(raw: unknown): ShowerFields | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["shampoo", "notes"].includes(key))) return undefined;

  const fields: ShowerFields = {};
  for (const [key, limit] of [
    ["shampoo", SHAMPOO_LIMIT],
    ["notes", SHOWER_NOTES_LIMIT],
  ] as const) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    if (trimmed.length > limit || hasControlCharacter(trimmed)) return undefined;
    fields[key] = trimmed;
  }
  return fields;
}

const SHOWER_KEYS = ["id", "localDate", "at", "shampoo", "notes", "byUserId", "byLabel", "source", "actionId"] as const;

/** Display text is uncapped, as a member's name is: JSON-quoted where shown. */
function displayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

/** One shower, or `undefined` for a shape this build does not accept. */
export function parseShower(raw: unknown): Shower | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(SHOWER_KEYS as readonly string[]).includes(key))) return undefined;

  const { id, localDate, at, byUserId, source, actionId } = record;
  if (typeof id !== "string" || id.length === 0 || id.length > SHOWER_ID_LIMIT || !OPAQUE_ID_PATTERN.test(id)) {
    return undefined;
  }
  if (!isLocalDate(localDate)) return undefined;
  if (!isIsoInstant(at)) return undefined;

  const fields = parseShowerFields({ shampoo: record.shampoo, notes: record.notes });
  if (!fields) return undefined;

  const label = displayText(record.byLabel);
  if (label === undefined) return undefined;
  let actorId: string | null;
  if (byUserId === null) actorId = null;
  else {
    const rawId = displayText(byUserId);
    if (rawId === undefined) return undefined;
    actorId = rawId;
  }
  // §9.2's fence: no id always travels with the household label.
  if (actorId === null && label !== HOUSEHOLD_FALLBACK_LABEL) return undefined;

  if (source !== "ui" && source !== "agent") return undefined;
  if (
    typeof actionId !== "string" ||
    actionId.length === 0 ||
    actionId.length > SHOWER_ACTION_ID_LIMIT ||
    !OPAQUE_ID_PATTERN.test(actionId)
  ) {
    return undefined;
  }

  return {
    id,
    localDate,
    at,
    ...fields,
    byUserId: actorId,
    byLabel: label,
    source,
    actionId,
  };
}

/** A stored history: unique ids. Order and day repetition are not rules. */
export function parseShowerList(raw: unknown): Shower[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const showers: Shower[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const shower = parseShower(item);
    if (!shower || ids.has(shower.id)) return undefined;
    ids.add(shower.id);
    showers.push(shower);
  }
  return showers;
}

/**
 * The history newest first, by the stored local date (ties: the later instant
 * first). The UI shows the recent few; the tool lists the rest.
 */
export function showerHistory(showers: Pick<Showers, "showers">): Shower[] {
  return [...showers.showers].sort((a, b) => {
    if (a.localDate !== b.localDate) return a.localDate < b.localDate ? 1 : -1;
    return Date.parse(b.at) - Date.parse(a.at);
  });
}

/**
 * The latest shower as the calendar sees it: greatest local date, ties by the
 * later instant. A linear scan, not a sort of the whole history — this is the
 * one element a due date needs, and the history is unbounded (§8.5).
 */
export function lastShower(showers: Pick<Showers, "showers">): Shower | undefined {
  let latest: Shower | undefined;
  for (const shower of showers.showers) {
    if (latest === undefined) {
      latest = shower;
      continue;
    }
    if (shower.localDate !== latest.localDate) {
      if (shower.localDate > latest.localDate) latest = shower;
      continue;
    }
    if (Date.parse(shower.at) > Date.parse(latest.at)) latest = shower;
  }
  return latest;
}

/**
 * What `GET /api/showers` and the `list_showers` tool carry (P3-07): the
 * history newest first, the derived status and the interval the household uses
 * (for "every 21 days" copy). Built by `showerView`; the browser renders it.
 */
export type ShowerView = {
  history: Shower[];
  status: ShowerStatus;
  intervalDays: number;
};

export type ShowerStatus = {
  /** The latest shower, or `null` for a history with none. */
  last: Shower | null;
  /** `YYYY-MM-DD`; absent without a shower to count from. */
  nextDue: string | null;
  /**
   * Whole days from `today` to `nextDue`: positive means still to come, zero
   * means due today, negative means overdue. `null` without a history. "Due" is
   * this one comparison (`daysUntilDue <= 0`), so a card and a badge cannot
   * disagree about it.
   */
  daysUntilDue: number | null;
};

/**
 * When the next shower is due: the latest shower's local date plus the
 * household's interval, compared with the household-local today. Pure, so the
 * card, the route and the test agree about a date across a DST change — the
 * arithmetic is on calendar dates, which have no DST.
 *
 * `intervalDays` is the household document's validated setting (a whole number
 * of days, bounded by the parser), never a value to guess at here.
 */
export function showerStatus(
  showers: Pick<Showers, "showers">,
  intervalDays: number,
  today: string,
): ShowerStatus {
  // The document parser bounds the setting, so these are caller bugs, not data:
  // fail loudly instead of turning an invalid date into a `RangeError`.
  if (!Number.isSafeInteger(intervalDays) || intervalDays < 1) {
    throw new Error(`not a shower interval: ${String(intervalDays)}`);
  }
  const last = lastShower(showers);
  if (last === undefined) return { last: null, nextDue: null, daysUntilDue: null };
  const nextDue = dateMinusDays(last.localDate, -intervalDays);
  if (!isLocalDate(nextDue)) {
    throw new Error(`the next shower due date is not a calendar date: ${nextDue}`);
  }
  return { last, nextDue, daysUntilDue: daysBetween(today, nextDue) };
}
