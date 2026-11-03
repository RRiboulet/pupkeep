// The Today meals card's pure half (PLAN §13.1, §12.1).
//
// The card shows each slot as fed, pending or overdue. The rule is deterministic
// and derived from committed data — the slot's household wall-clock time, the
// day being viewed, and the household-local now — never from a device zone and
// never from model output (§13/§14 guardrail: no general feeding advice).
//
// These are plain functions over plain objects (no Preact, no fetch, no DOM), so
// a Node test can pin the boundaries: midnight, a past or future day, an unfed
// slot before and after its reminder delay, and a fed slot that can never be
// called overdue. The zone formatting itself lives in `clock.js`, shared with
// the walk timer so both keep one formatter cache.

import { localDate as clockDate, localMinutes as clockMinutes, localTimeText } from "./clock.js";

export { clockDate as localDate, clockMinutes as localMinutes };

/** `"07:30"` → 450. An unparseable time yields `null` so a caller can say so. */
export function minutesOf(timeLocal) {
  if (typeof timeLocal !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeLocal);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}



/** `"07:30"` for a stored instant, in the household zone. */
export function feedTimeText(instant, timezone) {
  return localTimeText(instant, timezone);
}

/**
 * One slot's state. A committed feed wins outright; a past day's unfed slot is
 * overdue; a future day's is pending; today depends on the slot time plus the
 * household's reminder delay.
 *
 * `nowMinutes` is minutes since midnight in the household zone. A slot at
 * 23:50 is still pending at 00:05 *today* — the wrap is correct because the
 * extra minute count belongs to the next day, not this slot.
 */
export function mealStatus(localDate, slot, feed, clock) {
  if (feed) return "fed";
  if (localDate < clock.today) return "overdue";
  if (localDate > clock.today) return "pending";
  const due = minutesOf(slot.timeLocal);
  if (due === null || clock.nowMinutes === null) return "pending";
  return clock.nowMinutes >= due + clock.delayMin ? "overdue" : "pending";
}

/** The active slots as rows the card renders, in the document's time order. */
export function mealRows(day, clock) {
  return day.slots.map((entry) => ({
    slot: entry.slot,
    feed: entry.feed,
    status: mealStatus(day.localDate, entry.slot, entry.feed, clock),
  }));
}

/**
 * `{ today, nowMinutes, delayMin }` from the day's view, the household zone and
 * the current instant. `today` is derived locally, not taken from the response,
 * so the card crosses midnight while it is open.
 */
export function mealClock(day, timezone, now = new Date()) {
  return {
    today: clockDate(now, timezone),
    nowMinutes: clockMinutes(now, timezone),
    // The document accepts any finite non-negative delay, so the card does too
    // (a fractional minute is not an integer but is still a bound).
    delayMin:
      Number.isFinite(day.overdueAfterMin) && day.overdueAfterMin >= 0 ? day.overdueAfterMin : 0,
  };
}
