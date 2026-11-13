// Calendar arithmetic on household-local dates (`YYYY-MM-DD`), shared by the
// server and the pure view modules.
//
// Local dates are calendar values, not instants: `daysBetween("2026-03-29",
// "2026-03-30")` is one day in every zone, DST change or not, because the two
// strings are read at midnight UTC and differ by exactly 86 400 000 ms. That is
// why this arithmetic lives here (no `Intl`, no zone) while the zone-aware
// formatting and the wall-clock conversion stay in `server/domain/time.ts`.

import { isLocalDate } from "./profile.ts";

/** Milliseconds in one calendar day; the unit of every function here. */
export const DAY_MS = 86_400_000;

/** Whole days from one local date to another; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** `date` as a local date `days` days earlier (or later, for a negative count). */
export function dateMinusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/** `2026-11-12` → `2026-11`; `undefined` if the value is not an ISO local date. */
export function monthOf(localDate: string): string | undefined {
  return isLocalDate(localDate) ? localDate.slice(0, 7) : undefined;
}

/**
 * Shift a `YYYY-MM` month by whole months, without a `Date`: month arithmetic
 * through a time zone is how a DST or a year boundary turns into a wrong month.
 * Returns `undefined` for a malformed month or one before 0000-01.
 */
export function shiftMonth(month: string, delta: number): string | undefined {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match || !Number.isInteger(delta)) return undefined;
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta;
  if (index < 0) return undefined;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/**
 * The first month that stays hot: `keepMonths` months ending with the one
 * `todayLocalDate` falls in. With the default of 2, today's month and the
 * previous one stay in the hot document, and everything older is archivable — a
 * month boundary therefore never archives a month a caregiver is still looking
 * at, and a zone change cannot archive "today".
 */
export function archiveCutoff(todayLocalDate: string, keepMonths = 2): string | undefined {
  const month = monthOf(todayLocalDate);
  if (month === undefined || !Number.isInteger(keepMonths) || keepMonths < 1) return undefined;
  return shiftMonth(month, -(keepMonths - 1));
}
