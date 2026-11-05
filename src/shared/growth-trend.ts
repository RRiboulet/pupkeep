// The growth trend and its copy (PLAN §1.2, §1.3, §12, §13.1, §15, §16 P3-02).
//
// This module is the **only** "advice" the product gives, and the plan is
// explicit about its shape: deterministic app code over the logged weights,
// never the model, always marked as non-veterinary, and never a clinical
// judgement (§1.2). So there are no ranges, no dosages, no diagnoses, and no
// "should" about the puppy's health: the sentences state arithmetic and, at
// most, that a loss is worth a vet call — the plan's own example.
//
// Three rules keep the copy honest:
//
//   * **the numbers are the sentence.** Every note names the two weights and the
//     real span between them. The headline is built from an actual pair of
//     readings, never from a window's label: a household that weighs monthly
//     gets "over 30 days", not "not enough history" and never "over 30 days"
//     for a 13-day comparison. A reading dated after today (a clock jump, or a
//     westward zone change) is kept in the document but is not part of a trend
//     *as of today*: it cannot become the "current" weight or mask a stale
//     series before its day arrives.
//   * **a date question is answered with dates.** "Stale" compares the series'
//     last household-local `localDate` with today, not `latestMeasurement()`'s
//     instant (P3-01's carried note): after a timezone change the two differ,
//     and a stale series must never render as "steady".
//   * **the decision and the printed number are one number.** The percentage is
//     rounded to the tenth the copy shows *before* it is classified, so a
//     sentence can never print "10.0%" without the large-step warning, or
//     "2.0%" while being called steady.
//
// The 7/14/30-day slices are the chart's zoom levels (P3-03), not the trend: each
// is the last N **calendar dates** including today, carries its own comparison
// for whoever renders the chart, and builds no text. The headline uses the
// 14-day slice's oldest reading when there is one (§1.2's own example is a
// 14-day loss) and otherwise the last two readings, so a monthly weigher still
// has a comparison over the span they actually have. Two recent readings closer
// than three days are `too_short` even if the series holds a much older change:
// the headline is the *recent* trend, and the chart still shows the history.
//
// Thresholds are numbers of the product, not of the puppy: a loss beyond 2% of
// body weight over the comparison, a gain beyond 10% ("a large step — re-weigh
// before treating it as a trend": a young puppy gaining fast is normal, a
// single jump is as likely to be a scale or unit slip), and no reading for ten
// days. Each is pinned by a both-sides fixture in `test/growth-trend.test.ts`.

import { dateMinusDays, daysBetween } from "./dates.ts";
import type { GrowthPoint } from "./growth.ts";
import { formatWeightKg } from "./growth.ts";
import { isLocalDate } from "./profile.ts";

/** The slice lengths the chart (P3-03) offers, in calendar dates including today. */
export const TREND_WINDOWS_DAYS = [7, 14, 30] as const;
export type TrendWindowDays = (typeof TREND_WINDOWS_DAYS)[number];
/** The headline window (§1.2's own example is a 14-day loss). */
export const PRIMARY_TREND_DAYS: TrendWindowDays = 14;
/** A comparison of two readings closer than this is not a trend yet. */
export const MIN_TREND_SPAN_DAYS = 3;
/** A loss beyond this share of body weight is worth a vet call. */
export const WEIGHT_LOSS_PCT = 2;
/** A gain beyond this share is a large step, not a growth trend. */
export const RAPID_GAIN_PCT = 10;
/** No reading for this many household-local days makes the series stale. */
export const GROWTH_STALE_DAYS = 10;
/** Present in every summary: the plan's "always marked as non-veterinary". */
export const GROWTH_DISCLAIMER = "Trends are arithmetic over the logged weights, not veterinary advice.";

export type GrowthTrendState =
  | "no_data"
  | "too_short"
  | "stale"
  | "losing"
  | "gaining"
  | "rapid_gain"
  | "steady";

/** The comparison states, and the only ones a pair can produce. */
export type GrowthComparisonState = "losing" | "gaining" | "rapid_gain" | "steady";

/**
 * Two readings compared. `pct` is already rounded to the tenth the copy prints,
 * so the state and the sentence cannot disagree.
 */
export type GrowthComparison = {
  from: GrowthPoint;
  to: GrowthPoint;
  /** Whole days between the two stored local dates; always positive. */
  spanDays: number;
  /** Kilograms, rounded to whole grams. */
  deltaKg: number;
  /** Signed percentage, rounded to one decimal. */
  pct: number;
};

/**
 * One chart slice: `days` is the slice width in calendar dates including today,
 * `spanDays` the real distance between the readings it found. The reason names
 * what is missing rather than collapsing every case into "no data".
 */
export type GrowthWindow =
  | {
      days: TrendWindowDays;
      available: false;
      reason: "no_readings" | "one_reading" | "too_short";
    }
  | ({ days: TrendWindowDays; available: true } & GrowthComparison);

/** Distance to `app.puppy.targetWeightKg` (P1-11), never stored here. */
export type GrowthTargetProgress = {
  targetKg: number;
  latestKg: number;
  /** Never negative; zero means the target is reached. */
  remainingKg: number;
  reached: boolean;
};

export type GrowthSummary = {
  state: GrowthTrendState;
  /** The one deterministic sentence for `state`; quotes no texture but weights. */
  note: string;
  /**
   * The pair `note` describes. `null` when the note is not about a pair (no
   * data, or a stale series): a panel must not highlight a comparison the copy
   * does not make.
   */
  headline: GrowthComparison | null;
  /** Chart data for P3-03; the note is never built from these. */
  windows: GrowthWindow[];
  target: GrowthTargetProgress | null;
  disclaimer: string;
};

function roundKg(kg: number): number {
  return Math.round(kg * 1000) / 1000;
}

function comparisonOf(from: GrowthPoint, to: GrowthPoint): GrowthComparison | null {
  const spanDays = daysBetween(from.localDate, to.localDate);
  // One reading per local day in the series, so a zero span means the caller
  // passed a duplicate: there is nothing to compare.
  if (spanDays <= 0) return null;
  const deltaKg = roundKg(to.weightKg - from.weightKg);
  // Rounded to the tenth the copy prints, and classified from that number.
  const pct = Math.round((deltaKg / from.weightKg) * 100 * 10) / 10;
  return { from, to, spanDays, deltaKg, pct };
}

function classify(pct: number): GrowthComparisonState {
  if (pct <= -WEIGHT_LOSS_PCT) return "losing";
  if (pct >= RAPID_GAIN_PCT) return "rapid_gain";
  if (pct >= WEIGHT_LOSS_PCT) return "gaining";
  return "steady";
}

/**
 * The readings of one slice: the last `days` household-local calendar dates,
 * today included. The series is sorted (P3-01), so a contiguous filter is
 * enough. A reading dated after `today` (a clock jump, or a westward zone
 * change) is excluded: the slice is about the past, and a chart must not zoom a
 * future point into "now".
 */
function slicePoints(points: readonly GrowthPoint[], today: string, days: number): GrowthPoint[] {
  const from = dateMinusDays(today, days - 1);
  return points.filter((point) => point.localDate >= from && point.localDate <= today);
}

/** One chart slice over `points`. Pure; `growthSummary` uses the same builder. */
export function growthWindow(
  points: readonly GrowthPoint[],
  today: string,
  days: TrendWindowDays,
): GrowthWindow {
  const slice = slicePoints(points, today, days);
  if (slice.length === 0) return { days, available: false, reason: "no_readings" };
  if (slice.length === 1) return { days, available: false, reason: "one_reading" };
  const comparison = comparisonOf(slice[0]!, slice[slice.length - 1]!);
  if (!comparison || comparison.spanDays < MIN_TREND_SPAN_DAYS) {
    return { days, available: false, reason: "too_short" };
  }
  return { days, available: true, ...comparison };
}

/**
 * The pair the headline compares: the oldest reading of the 14-day slice when
 * that slice holds two, otherwise the last two readings (a monthly weigher
 * still has a comparison, over the span they actually have). `null` with fewer
 * than two readings.
 */
function headlineComparison(points: readonly GrowthPoint[], today: string): GrowthComparison | null {
  if (points.length < 2) return null;
  const to = points[points.length - 1]!;
  const slice = slicePoints(points, today, PRIMARY_TREND_DAYS);
  const from = slice.length >= 2 ? slice[0]! : points[points.length - 2]!;
  return comparisonOf(from, to);
}

/**
 * The readings that are part of a trend as of `today`: everything up to and
 * including today. A future-dated reading stays in the document (it is what the
 * household logged) and becomes visible when its day arrives.
 */
function asOfToday(points: readonly GrowthPoint[], today: string): GrowthPoint[] {
  return points.filter((point) => point.localDate <= today);
}

function noDataNote(latest: GrowthPoint | undefined): string {
  if (latest === undefined) return "No weight logged yet.";
  return `One weight logged (${formatWeightKg(latest.weightKg)} on ${latest.localDate}); a trend needs at least two readings.`;
}

function tooShortNote(headline: GrowthComparison): string {
  const span = headline.spanDays;
  return `The last two weights are only ${span} day${span === 1 ? "" : "s"} apart; a trend needs readings at least ${MIN_TREND_SPAN_DAYS} days apart.`;
}

function staleNote(latest: GrowthPoint, days: number): string {
  return `No weight logged in ${days} days (last ${latest.localDate}: ${formatWeightKg(latest.weightKg)}).`;
}

function pctText(pct: number): string {
  return `${Math.abs(pct).toFixed(1)}%`;
}

function weightsText(comparison: GrowthComparison): string {
  return `${formatWeightKg(comparison.from.weightKg)} → ${formatWeightKg(comparison.to.weightKg)}`;
}

function comparisonNote(state: GrowthComparisonState, comparison: GrowthComparison): string {
  switch (state) {
    case "losing":
      return `Weight is down ${pctText(comparison.pct)} over ${comparison.spanDays} days (${weightsText(comparison)}). Worth a vet call.`;
    case "rapid_gain":
      return `Weight is up ${pctText(comparison.pct)} over ${comparison.spanDays} days (${weightsText(comparison)}). A large step — re-weigh on the same scale before relying on it as a trend.`;
    case "gaining":
      return `Weight is up ${pctText(comparison.pct)} over ${comparison.spanDays} days (${weightsText(comparison)}).`;
    case "steady":
      return `Weight is steady over ${comparison.spanDays} days (${weightsText(comparison)}).`;
  }
}

/** Distance to the target, or `null` without both a target and a reading. */
export function targetProgress(
  latest: GrowthPoint | undefined,
  targetWeightKg: number | null,
): GrowthTargetProgress | null {
  // The type says `number | null`; a hand-built caller can still pass garbage,
  // and "NaN kg to go" is worse than no target line.
  if (latest === undefined) return null;
  if (typeof targetWeightKg !== "number" || !Number.isFinite(targetWeightKg)) return null;
  const remainingKg = Math.max(0, roundKg(targetWeightKg - latest.weightKg));
  return {
    targetKg: targetWeightKg,
    latestKg: latest.weightKg,
    remainingKg,
    reached: latest.weightKg >= targetWeightKg,
  };
}

/**
 * The trend over P3-01's daily series: the headline pair, the target distance,
 * the chart slices and the disclaimer. Pure, so the HTTP route, the agent tool
 * and the tests render the same sentences.
 *
 * Order: a stale series is stale whatever its numbers say (a flat line whose
 * last reading is a month old is not "steady"); otherwise the headline pair
 * decides; two readings closer than three days are `too_short`; no pair at all
 * is `no_data`.
 */
export function growthSummary(input: {
  /** `growthSeries(growth)`: one point per local date, ascending. */
  points: readonly GrowthPoint[];
  /** Household-local today, `YYYY-MM-DD`. */
  today: string;
  targetWeightKg: number | null;
}): GrowthSummary {
  const { today } = input;
  if (!isLocalDate(today)) throw new Error(`not a local date: ${today}`);
  const points = asOfToday(input.points, today);

  const latest = points[points.length - 1];
  const pair = headlineComparison(points, today);
  const windows = TREND_WINDOWS_DAYS.map((days) => growthWindow(points, today, days));
  const target = targetProgress(latest, input.targetWeightKg);

  let state: GrowthTrendState;
  let note: string;
  let headline: GrowthComparison | null = pair;
  if (latest !== undefined && daysBetween(latest.localDate, today) >= GROWTH_STALE_DAYS) {
    state = "stale";
    note = staleNote(latest, Math.max(0, daysBetween(latest.localDate, today)));
    // The note is about the missing days, not about a comparison.
    headline = null;
  } else if (pair === null) {
    state = "no_data";
    note = noDataNote(latest);
    headline = null;
  } else if (pair.spanDays < MIN_TREND_SPAN_DAYS) {
    state = "too_short";
    note = tooShortNote(pair);
  } else {
    state = classify(pair.pct);
    note = comparisonNote(state, pair);
  }

  return {
    state,
    note,
    headline,
    windows,
    target,
    disclaimer: GROWTH_DISCLAIMER,
  };
}

function targetText(target: GrowthTargetProgress): string {
  if (target.reached) return `Target ${formatWeightKg(target.targetKg)} reached (${formatWeightKg(target.latestKg)}).`;
  return `Target ${formatWeightKg(target.targetKg)} — ${formatWeightKg(target.remainingKg)} to go.`;
}

/** One line of the summary copy, with the role that says how it is displayed. */
export type GrowthSummaryLine = {
  role: "note" | "target" | "disclaimer";
  text: string;
};

/**
 * The summary as lines with roles: the note, the target sentence when there is
 * one, and the disclaimer last. The panel styles by role instead of by line
 * index, so a future third sentence cannot silently restyle the disclaimer.
 */
export function growthSummaryLines(summary: GrowthSummary): GrowthSummaryLine[] {
  const lines: GrowthSummaryLine[] = [{ role: "note", text: summary.note }];
  if (summary.target !== null) lines.push({ role: "target", text: targetText(summary.target) });
  lines.push({ role: "disclaimer", text: summary.disclaimer });
  return lines;
}

/**
 * The one text rendering of a summary: the note, the target and the disclaimer.
 * Nothing is built from the chart slices — a second, quieter sentence about the
 * same weights is how copy and headline drift apart.
 */
export function growthSummaryText(summary: GrowthSummary): string {
  return growthSummaryLines(summary)
    .map((line) => line.text)
    .join("\n");
}
