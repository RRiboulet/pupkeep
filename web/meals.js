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
// called overdue.

/** One formatter per zone and kind: `Intl` construction is the expensive part. */
const FORMATTERS = new Map();

/** A getter for one formatter part, or `null` when the zone/instant is unusable. */
function partsOf(timezone, options, instant) {
  // `timeZone: undefined` asks Intl for the *device's* zone; this card never
  // does that (§8.1), so only a real zone is trusted.
  if (typeof timezone !== "string" || timezone === "") return null;
  const key = `${timezone}|${JSON.stringify(options)}`;
  try {
    let formatter = FORMATTERS.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: timezone });
      FORMATTERS.set(key, formatter);
    }
    const parts = formatter.formatToParts(instant);
    return (type) => parts.find((part) => part.type === type)?.value ?? "";
  } catch {
    // An unusable zone is a configuration defect the server refuses at boot;
    // showing an unknown time is visibly wrong rather than silently the
    // device's zone.
    return null;
  }
}

/** `"07:30"` → 450. An unparseable time yields `null` so a caller can say so. */
export function minutesOf(timeLocal) {
  if (typeof timeLocal !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeLocal);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * The household-local wall clock of `instant` as minutes since midnight. The
 * zone is the household's, passed explicitly: `Intl` never falls back to the
 * device's zone without being asked to.
 */
export function localMinutes(instant, timezone) {
  const get = partsOf(timezone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, instant);
  if (get === null) return null;
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

/**
 * The household-local calendar date of `instant` as `YYYY-MM-DD`, derived the
 * same way the server derives it (`localDateAt`): an open Today screen must
 * notice midnight on its own, without asking the server which day it is on.
 */
export function localDate(instant, timezone) {
  const get = partsOf(timezone, { year: "numeric", month: "2-digit", day: "2-digit" }, instant);
  if (get === null) return null;
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

/** `"07:30"` for a stored instant, in the household zone. */
export function feedTimeText(instant, timezone) {
  const minutes = localMinutes(new Date(instant), timezone);
  if (minutes === null) return "at an unknown time";
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hour}:${minute}`;
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
    today: localDate(now, timezone),
    nowMinutes: localMinutes(now, timezone),
    // The document accepts any finite non-negative delay, so the card does too
    // (a fractional minute is not an integer but is still a bound).
    delayMin:
      Number.isFinite(day.overdueAfterMin) && day.overdueAfterMin >= 0 ? day.overdueAfterMin : 0,
  };
}
