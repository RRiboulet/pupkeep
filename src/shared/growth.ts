// `app.growth` and its invariants (PLAN §8.1, §8.3, §8.4, §8.5, §9.2, §7.3).
//
// The document holds the weight (and optional height) measurements a caregiver
// logged. What this module fixes:
//
//   * **several measurements per day** are allowed, and the day's **latest**
//     `at` is the day's reading. A re-weigh is legitimate — the vet at 10:00,
//     home at 20:00 — and a second log must not be a conflict that blocks the
//     caregiver. The chart and P3-02's windows read `growthSeries()`, which
//     collapses a day to that latest reading; the full list is kept so nothing
//     a caregiver logged disappears.
//   * **kg, with gram precision** — `weightKg` is a number in kilograms and
//     never a converted string. A caregiver who types grams sees the conversion
//     in the UI (P3-03); the domain stores one unit and refuses to guess.
//     More precision than a gram is rounded on write (as the target weight
//     rounds to a hundredth), and the parser refuses a stored value that is not
//     a whole number of grams, so a document always holds a weight somebody
//     could have entered.
//   * **`localDate` is a write-time rule** — derived from the server clock in
//     the household zone (§8.4), never from client input, and never re-derived
//     on read: a household that moves zones must not have its history re-dated.
//   * **derived, never stored** — the daily series and the latest reading are
//     computed from committed measurements only. There is no interpolation, no
//     filling of missing days, and no weighted smoothing: a trend is a
//     statement about what was logged.
//   * **no revision** — the list is append-only and every write is the same
//     kind of write, so there is nothing to compare-and-swap. The target weight
//     keeps its own revision on `app.puppy` (P1-11); this document never copies
//     it.
//
// `actionId` uniqueness is deliberately **not** a document rule, exactly as for
// feed events and walks: the key is 24 h-scoped in `app.commands` (§7.3), so a
// reused key must not make `app.growth` unreadable — the service answers it.

import type { Growth, GrowthMeasurement } from "./domain.ts";
import { OPAQUE_ID_PATTERN, isIsoInstant } from "./domain.ts";
import { HOUSEHOLD_FALLBACK_LABEL } from "./chat.ts";
import { hasControlCharacter, isLocalDate } from "./profile.ts";

/** Same charset and bounds as a feed event's id and action id. */
export const MEASUREMENT_ID_LIMIT = 64;
export const MEASUREMENT_ACTION_ID_LIMIT = 120;
/** One measurement's note is a line, not a diary. */
export const MEASUREMENT_NOTE_LIMIT = 280;
/** A puppy heavier than this is a typo; a height is in centimetres. */
export const WEIGHT_MAX_KG = 200;
export const HEIGHT_MAX_CM = 200;

/**
 * The one sentence a refused measurement answers with. Shared by the route and
 * the tool (P3-03) so a caregiver reads one rule, not two wordings.
 */
export const MEASUREMENT_RULE =
  "a measurement is a weight in kilograms from 0.001 to 200 (whole grams), an optional height in centimetres from 0.1 to 200 (a tenth of a centimetre), and an optional one-line note up to 280 characters";

/** Whole grams: what a scale (and a caregiver typing grams) can tell apart. */
const GRAMS_PER_KG = 1000;
const PRECISION_EPSILON = 1e-6;

function isGramPrecision(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (value <= 0 || value > WEIGHT_MAX_KG) return false;
  return Math.abs(value * GRAMS_PER_KG - Math.round(value * GRAMS_PER_KG)) < PRECISION_EPSILON;
}

function isCentimetrePrecision(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (value <= 0 || value > HEIGHT_MAX_CM) return false;
  return Math.abs(value * 10 - Math.round(value * 10)) < PRECISION_EPSILON;
}

/**
 * Rounded to the stored precision, so "4.23749 kg" is the same request as 4.237.
 * A value that sits exactly half a gram between two stored weights follows
 * IEEE-754, so two "halves" can round opposite ways (4.2375 is representable
 * just above its half, 4.0005 just below). That is a sub-milligram distinction
 * no scale reports, and the stored-shape parser still refuses anything that is
 * not a whole number of grams.
 */
export function roundWeightKg(weightKg: number): number {
  return Math.round(weightKg * GRAMS_PER_KG) / GRAMS_PER_KG;
}

export function roundHeightCm(heightCm: number): number {
  return Math.round(heightCm * 10) / 10;
}

/** Display text for a stored weight, trimmed of trailing zeros: `4.25 kg`. */
export function formatWeightKg(weightKg: number): string {
  const text = weightKg.toFixed(3).replace(/\.?0+$/, "");
  return `${text} kg`;
}

/**
 * The fields one measurement write carries, normalised once: grams as grams,
 * an empty note as absent. The service hashes this result, so a retry of the
 * same measurement (padded note, extra decimals) is the same request (§7.3).
 *
 * An unknown key is refused rather than dropped: a client typo must be visible,
 * not silently lost. The parser answers `undefined`; the service turns that
 * into the one sentence above.
 */
export type MeasurementFields = {
  weightKg: number;
  heightCm?: number;
  note?: string;
};

export function parseMeasurementFields(raw: unknown): MeasurementFields | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["weightKg", "heightCm", "note"].includes(key))) return undefined;

  const weightKg = record.weightKg;
  if (typeof weightKg !== "number" || !Number.isFinite(weightKg) || weightKg <= 0 || weightKg > WEIGHT_MAX_KG) {
    return undefined;
  }
  // A value below half a gram rounds to zero, which is not a weight: refuse it
  // here rather than let the stored-shape backstop answer for it.
  const rounded = roundWeightKg(weightKg);
  if (rounded <= 0) return undefined;
  const fields: MeasurementFields = { weightKg: rounded };

  if (record.heightCm !== undefined && record.heightCm !== null) {
    const heightCm = record.heightCm;
    if (typeof heightCm !== "number" || !Number.isFinite(heightCm) || heightCm <= 0 || heightCm > HEIGHT_MAX_CM) {
      return undefined;
    }
    fields.heightCm = roundHeightCm(heightCm);
  }

  if (record.note !== undefined && record.note !== null) {
    if (typeof record.note !== "string") return undefined;
    const note = record.note.trim();
    if (note !== "") {
      if (note.length > MEASUREMENT_NOTE_LIMIT || hasControlCharacter(note)) return undefined;
      fields.note = note;
    }
  }
  return fields;
}

const MEASUREMENT_KEYS = [
  "id",
  "localDate",
  "at",
  "weightKg",
  "heightCm",
  "note",
  "byUserId",
  "byLabel",
  "source",
  "actionId",
] as const;

/** Display text is uncapped, as a member's name is: JSON-quoted where shown. */
function displayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

/** One measurement, or `undefined` for a shape this build does not accept. */
export function parseGrowthMeasurement(raw: unknown): GrowthMeasurement | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(MEASUREMENT_KEYS as readonly string[]).includes(key))) return undefined;

  const { id, localDate, at, byUserId, source, actionId } = record;
  if (typeof id !== "string" || id.length === 0 || id.length > MEASUREMENT_ID_LIMIT || !OPAQUE_ID_PATTERN.test(id)) {
    return undefined;
  }
  if (!isLocalDate(localDate)) return undefined;
  if (!isIsoInstant(at)) return undefined;
  if (!isGramPrecision(record.weightKg)) return undefined;
  if (record.heightCm !== undefined && !isCentimetrePrecision(record.heightCm)) return undefined;

  let note: string | undefined;
  if (record.note !== undefined) {
    if (typeof record.note !== "string") return undefined;
    const trimmed = record.note.trim();
    if (trimmed === "" || trimmed.length > MEASUREMENT_NOTE_LIMIT || hasControlCharacter(trimmed)) return undefined;
    note = trimmed;
  }

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
    actionId.length > MEASUREMENT_ACTION_ID_LIMIT ||
    !OPAQUE_ID_PATTERN.test(actionId)
  ) {
    return undefined;
  }

  const measurement: GrowthMeasurement = {
    id,
    localDate,
    at,
    weightKg: record.weightKg,
    byUserId: actorId,
    byLabel: label,
    source,
    actionId,
  };
  if (record.heightCm !== undefined) measurement.heightCm = record.heightCm as number;
  if (note !== undefined) measurement.note = note;
  return measurement;
}

/**
 * A stored measurement list. Empty is valid (a fresh household); a repeated id
 * is not — the service never writes one, so seeing one here is a bug that must
 * fail boot rather than be repaired.
 */
export function parseGrowthMeasurements(raw: unknown): GrowthMeasurement[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const measurements: GrowthMeasurement[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const measurement = parseGrowthMeasurement(item);
    if (!measurement || ids.has(measurement.id)) return undefined;
    ids.add(measurement.id);
    measurements.push(measurement);
  }
  return measurements;
}

/** One day's reading on the chart: the day's latest `at`, in local-date order. */
export type GrowthPoint = {
  /** `YYYY-MM-DD` in the household zone, as stored with the measurement. */
  localDate: string;
  /** The instant of the latest measurement that day. */
  at: string;
  weightKg: number;
  heightCm?: number;
  /** The measurement this point came from, so a row can be inspected. */
  measurementId: string;
};

/**
 * The series the chart (P3-03) and the trend windows (P3-02) read: one point
 * per day, the day's latest measurement, ascending by local date. P3-02's
 * "stale" rule must use this series (a date question), not
 * `latestMeasurement()` (an instant question) — see that function for why they
 * can differ. Pure and
 * derived from committed measurements only — no interpolation, no filling of a
 * skipped day, no smoothing. The list is not re-sorted by `at` across days: a
 * clock jump must not reorder a household's history (§8.4).
 */
export function growthSeries(growth: Pick<Growth, "measurements">): GrowthPoint[] {
  const byDay = new Map<string, GrowthMeasurement>();
  for (const measurement of growth.measurements) {
    const current = byDay.get(measurement.localDate);
    // `>=` so a same-instant duplicate keeps the append-order winner, which is
    // the one a reader would already have seen last.
    if (current === undefined || Date.parse(measurement.at) >= Date.parse(current.at)) {
      byDay.set(measurement.localDate, measurement);
    }
  }
  return [...byDay.values()]
    .sort((a, b) => (a.localDate < b.localDate ? -1 : a.localDate > b.localDate ? 1 : 0))
    .map((measurement) => {
      const point: GrowthPoint = {
        localDate: measurement.localDate,
        at: measurement.at,
        weightKg: measurement.weightKg,
        measurementId: measurement.id,
      };
      if (measurement.heightCm !== undefined) point.heightCm = measurement.heightCm;
      return point;
    });
}

/**
 * The last measurement **taken**, by instant. This is deliberately not always
 * `growthSeries(...).at(-1)`: the series keeps household-local days in date
 * order, so a household that changes timezone can have a later instant whose
 * stored local date is earlier. "When was the puppy last weighed?" is the
 * instant question; the chart and P3-02's date windows are the series question.
 */
export function latestMeasurement(growth: Pick<Growth, "measurements">): GrowthMeasurement | undefined {
  let latest: GrowthMeasurement | undefined;
  for (const measurement of growth.measurements) {
    if (latest === undefined || Date.parse(measurement.at) >= Date.parse(latest.at)) latest = measurement;
  }
  return latest;
}

export type { Growth };
