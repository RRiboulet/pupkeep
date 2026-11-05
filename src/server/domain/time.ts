// Household-local dates and times (PLAN §8.1: every `localDate` is derived in
// `app.household.timezone`).
//
// Two rules keep this honest:
//   * never derive a local date from `Date#toISOString().slice(0, 10)` — that is
//     the UTC date and is wrong for half of every day;
//   * never cache a formatter per call site. `Intl.DateTimeFormat` is expensive
//     to construct and cheap to reuse, so one cache keyed by zone and options.
//
// The feeding day view (P2-01) and the walk/growth calendar (P3+) build on this
// module. The *calendar* arithmetic on local dates (days between two dates, a
// date minus N days) lives in `src/shared/dates.ts`, so the pure view modules
// can use it without importing the server; this module keeps what needs `Intl`
// (formatting, the wall-clock conversion) plus the month arithmetic the puppy's
// age uses.

import { DAY_MS, daysBetween } from "../../shared/dates.ts";
import type { PuppyAge } from "../../shared/profile.ts";
import { isLocalDate } from "../../shared/profile.ts";
import { isLocalTime } from "../../shared/feeding.ts";

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** The IANA zone if `Intl` accepts it, else UTC; a bad zone never silently passes. */
export function safeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

function formatter(timezone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${safeZone(timezone)}|${JSON.stringify(options)}`;
  let cached = FORMATTERS.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: safeZone(timezone) });
    FORMATTERS.set(key, cached);
  }
  return cached;
}

/** The household-local calendar date of `instant`, as `YYYY-MM-DD`. */
export function localDateAt(instant: Date, timezone: string): string {
  const parts = formatter(timezone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The household-local wall-clock time of `instant`, as `HH:MM`. */
export function localTimeAt(instant: Date, timezone: string): string {
  const parts = formatter(timezone, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/**
 * The zone's offset from UTC at one instant, in milliseconds (positive east).
 * `Intl` formats the instant in the zone; reading those parts as if they were
 * UTC and subtracting the instant is the offset. Milliseconds are dropped
 * deliberately: the formatter only reports whole seconds.
 */
function zoneOffsetMs(instant: number, timezone: string): number {
  const parts = formatter(timezone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const whole = Math.floor(instant / 1000) * 1000;
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - whole;
}

/**
 * The instant at which the household clock reads `timeLocal` on `localDate`
 * (§8.4: meal slots are wall-clock times in the household zone). One slot time
 * therefore moves with the household through a DST change instead of staying a
 * fixed UTC instant.
 *
 * The two awkward cases resolve the way `Temporal`'s `compatible` disambiguation
 * does, which is what a caregiver expects from a wall clock:
 *   * **ambiguous** (the hour a fall-back repeats): the **earlier** occurrence,
 *     so a reminder is not delayed by an hour;
 *   * **nonexistent** (the hour a spring-forward skips): shifted **forward** by
 *     the gap — 02:30 on the transition day is 03:30 on the new clock. The
 *     reminder still happens that morning instead of vanishing.
 * Both are pinned by Europe/Paris fixtures in `test/reminders.test.ts`.
 */
export function instantAtLocalWallClock(localDate: string, timeLocal: string, timezone: string): Date {
  if (!isLocalDate(localDate)) throw new Error(`not a local date: ${localDate}`);
  if (!isLocalTime(timeLocal)) throw new Error(`not a wall-clock time: ${timeLocal}`);
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const [hour, minute] = timeLocal.split(":").map(Number) as [number, number];
  // `Date.UTC` maps years 0–99 to 1900–1999; `setUTCFullYear` does not. The
  // armer only ever passes today's date, but Phases 3–4 will pass appointment
  // dates, so the conversion must not silently move a year.
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, 0, 0);
  const wall = at.getTime();

  // A day either side of the wall time captures both offsets around a
  // transition; a candidate is real when it formats back to the same wall time.
  const offsets = new Set([
    zoneOffsetMs(wall - DAY_MS, timezone),
    zoneOffsetMs(wall, timezone),
    zoneOffsetMs(wall + DAY_MS, timezone),
  ]);
  const wallText = `${localDate} ${timeLocal}`;
  const matches = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => `${localDateAt(new Date(instant), timezone)} ${localTimeAt(new Date(instant), timezone)}` === wallText)
    .sort((a, b) => a - b);
  // One match is the ordinary case; two are an ambiguous hour, where the first
  // (earliest) is the one a wall clock shows first.
  if (matches.length > 0) return new Date(matches[0]!);

  // No match: the wall time falls in the skipped hour. `wall - offsetAfter` is
  // the instant one gap later on the new clock, which is the documented rule.
  const guess = wall - zoneOffsetMs(wall, timezone);
  return new Date(wall - zoneOffsetMs(guess, timezone));
}

/**
 * Calendar months between two local dates, without a library: add months to
 * the earlier date until it would pass the later one. Birthdays are the only
 * user, so the day-of-month clamp ("born on the 31st") is handled by the same
 * comparison instead of an average month length.
 */
export function monthsBetween(from: string, to: string): number {
  let months = 0;
  for (;;) {
    if (addMonths(from, months + 1) > to) return months;
    months += 1;
  }
}

/** `date` plus `months` calendar months, clamped to the month's last day. */
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const clamped = Math.min(day, lastDay);
  const result = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), clamped));
  return result.toISOString().slice(0, 10);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Age from a local birth date, in the plan's terms: days and weeks always,
 * with a human label that switches from days to weeks to months to years.
 * Deterministic text only — this is also what the UI and the agent quote.
 */
export function ageOf(birthday: string | null, today: string): PuppyAge | null {
  if (!birthday) return null;
  // A timezone change can make a real birthday look one day in the future for
  // a few hours; clamp instead of reporting a negative age.
  const days = Math.max(0, daysBetween(birthday, today));
  const weeks = Math.floor(days / 7);
  const months = monthsBetween(birthday, today);
  return { days, weeks, label: ageLabel(days, weeks, months) };
}

function ageLabel(days: number, weeks: number, months: number): string {
  if (days === 0) return "born today";
  if (days < 7) return `${plural(days, "day", "days")} old`;
  if (days < 140) return `${plural(weeks, "week", "weeks")} old`;
  if (months < 12) return `${plural(months, "month", "months")} old`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest === 0
    ? `${plural(years, "year", "years")} old`
    : `${plural(years, "year", "years")}, ${plural(rest, "month", "months")} old`;
}
