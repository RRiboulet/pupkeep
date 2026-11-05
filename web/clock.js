// Household-zone clock formatting for the browser (PLAN §8.1, §8.4).
//
// One cached `Intl.DateTimeFormat` per zone and kind, exactly as the server's
// `time.ts` does: constructing one is the expensive part, and the Today card
// formats a live timer every second. The zone is always passed explicitly — the
// device's zone is never used — and an unusable zone answers `null`, which the
// callers render as "an unknown time".

const FORMATTERS = new Map();

function partsOf(timezone, options, instant) {
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
    return null;
  }
}

/** The household-local wall clock of `instant` as minutes since midnight. */
export function localMinutes(instant, timezone) {
  const get = partsOf(timezone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, instant);
  if (get === null) return null;
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

/** The household-local calendar date of `instant` as `YYYY-MM-DD`. */
export function localDate(instant, timezone) {
  const get = partsOf(timezone, { year: "numeric", month: "2-digit", day: "2-digit" }, instant);
  if (get === null) return null;
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

/** `HH:MM` for a stored instant in the household zone. */
export function localTimeText(instant, timezone) {
  const minutes = localMinutes(instant instanceof Date ? instant : new Date(instant), timezone);
  if (minutes === null) return "at an unknown time";
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

/**
 * A stored `YYYY-MM-DD` local date as display text: `15 Nov 2026`. The date was
 * already computed in the household zone by the server, so it is formatted at
 * UTC — reading it as an instant in a zone behind UTC would show the 14th. A
 * value that does not round-trip (a day that does not exist, a year `Date.UTC`
 * would remap) is returned as it arrived rather than shown as a different date.
 */
const LOCAL_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function dateText(localDate) {
  const raw = String(localDate ?? "");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return raw;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(at.getTime())) return raw;
  // `Date.UTC` maps years 0–99 into the 1900s and rolls 31 February into March;
  // the server's `isLocalDate` refuses both, so show the stored text instead.
  if (at.toISOString().slice(0, 10) !== raw) return raw;
  return LOCAL_DATE_FORMAT.format(at);
}
