// Household-local dates and times (PLAN §8.1: every `localDate` is derived in
// `app.household.timezone`).
//
// Two rules keep this honest:
//   * never derive a local date from `Date#toISOString().slice(0, 10)` — that is
//     the UTC date and is wrong for half of every day;
//   * never cache a formatter per call site. `Intl.DateTimeFormat` is expensive
//     to construct and cheap to reuse, so one cache keyed by zone and options.
//
// The full feeding/walking/care calendar arrives with P2-01. This module holds
// only what the profile (age) and `get_context` (today, now) need.

import type { PuppyAge } from "../../shared/profile.ts";

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

const DAY_MS = 86_400_000;

/** Whole days from one local date to another; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
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
