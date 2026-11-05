// The growth domain's model-facing copy (PLAN §9.5, §10.1, §10.3).
//
// Kept out of `growth-tools.ts` so the context tool can render the latest
// weight without importing another extension's registration module, exactly as
// `feed-text.ts` does for the meals. The trend sentences themselves come from
// P3-02 (`growthSummaryText`) — this module only lists the committed points and
// frames them, so the model, the panel and the test read one copy.

import type { GrowthPoint, GrowthView } from "../../shared/growth.ts";
import { formatWeightKg } from "../../shared/growth.ts";
import { growthSummaryText, type GrowthTrendState } from "../../shared/growth-trend.ts";

/** The newest points listed in a tool answer; the chart carries the rest. */
const MAX_MEASUREMENT_LINES = 12;

function measurementLine(point: GrowthView["points"][number]): string {
  const height = point.heightCm === undefined ? "" : `, ${point.heightCm} cm`;
  return `${point.localDate} ${formatWeightKg(point.weightKg)}${height}`;
}

/**
 * The model's growth report: the committed points (oldest first, newest tail
 * kept), then P3-02's trend/target copy and its disclaimer. A series with no
 * point says so; it never renders as an empty "nothing logged" table.
 */
export function growthReportText(growth: GrowthView): string {
  const points = growth.points;
  // P3-02's one renderer, not a second join of the same lines.
  const copy = growthSummaryText(growth.summary);
  if (points.length === 0) return `Measurements: none yet.\n${copy}`;
  const shown = points.slice(-MAX_MEASUREMENT_LINES);
  const more = points.length - shown.length;
  const lines = shown.map(measurementLine);
  if (more > 0) lines.unshift(`and ${more} earlier measurements`);
  return `Measurements (oldest first):\n${lines.join("\n")}\nTrend: ${copy}`;
}

/**
 * The one-line latest weight for `get_context` (§10.1). A stale series says so,
 * because "latest" must never read as "current" when the last weighing was a
 * month ago (P3-02's rule). The rest of the trend is `get_growth`'s: this line
 * carries no advice and no state jargon.
 */
export function latestWeightText(points: readonly GrowthPoint[], state: GrowthTrendState): string {
  if (points.length === 0) return "Latest weight: none logged yet";
  const point = points[points.length - 1]!;
  const stale = state === "stale" ? " (no recent measurement)" : "";
  return `Latest weight: ${formatWeightKg(point.weightKg)} on ${point.localDate}${stale}`;
}
