// Calendar arithmetic on household-local dates (`YYYY-MM-DD`), shared by the
// server and the pure view modules.
//
// Local dates are calendar values, not instants: `daysBetween("2026-03-29",
// "2026-03-30")` is one day in every zone, DST change or not, because the two
// strings are read at midnight UTC and differ by exactly 86 400 000 ms. That is
// why this arithmetic lives here (no `Intl`, no zone) while the zone-aware
// formatting and the wall-clock conversion stay in `server/domain/time.ts`.

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
