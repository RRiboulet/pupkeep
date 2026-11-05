// The growth chart's pure half (PLAN §13.1, §13.2, §16 P3-03).
//
// The Pup screen draws an inline SVG: no chart library, no build step. The
// screen reads the series from `GET /api/growth` (the care frame is a signal,
// not data — P2-05), so nothing here compares frames. This
// module is the part a Node test can pin — the points a committed series
// produces, where they land, how a gap is marked, the axis labels and the table
// rows — while the view only turns these numbers into elements. It imports no
// Preact and touches no DOM.
//
// Three rules from the task, made arithmetic:
//   * **only committed points are drawn.** The input is `growthSeries(growth)`
//     from the care frame; nothing here interpolates, averages or fills.
//   * **a gap is marked, never smoothed away.** Consecutive points are joined by
//     a solid segment only when they are at most a day apart; anything longer is
//     `gap: true` and the view dashes it, with a caption saying so. The line is
//     never curved.
//   * **x is time, not index.** A weekly series is spaced by its dates, so the
//     picture cannot imply daily measurements that were never taken. The axis
//     labels are the household-local `localDate` strings P3-01 stored, never a
//     UTC rendering of an instant.

// `right` leaves room for the last date label, which is centred on the plot's
// right edge; `bottom` does the same for the first.
export const CHART_SIZE = { width: 640, height: 220, padding: { top: 16, right: 40, bottom: 30, left: 52 } };

const DAY_MS = 86_400_000;

/** Whole days between two `YYYY-MM-DD` strings, read as UTC midnights. */
export function daysBetweenLocalDates(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** `4.237` → `"4.237 kg"`, `4.2` → `"4.2 kg"`, `4` → `"4 kg"`. */
export function formatKg(value) {
  return `${Number(value.toFixed(3))} kg`;
}

/** A chartless surface still shows the numbers: newest first for a table. */
/**
 * One 7/14/30-day slice as a chip (§13.1): the change, or what is missing. It
 * is the summary's own `windows`, so the panel does not recompute a slice.
 */
export function windowLabel(window) {
  if (!window || !window.available) {
    if (window?.reason === "no_readings") return "no readings";
    if (window?.reason === "one_reading") return "one reading";
    return "too few days";
  }
  return `${window.pct > 0 ? "+" : ""}${window.pct.toFixed(1)}%`;
}

export function measurementRows(points) {
  return points
    .slice()
    .reverse()
    .map((point) => ({
      localDate: point.localDate,
      weightKg: formatKg(point.weightKg),
      heightCm: point.heightCm === undefined ? "" : `${Number(point.heightCm.toFixed(1))} cm`,
    }));
}

function round(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Where the committed points land. `null` for an empty series; one point is
 * centred (a chart of a single reading has no span to divide).
 */
export function chartGeometry(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const { width, height, padding } = CHART_SIZE;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const weights = points.map((point) => point.weightKg);
  let minKg = Math.min(...weights);
  let maxKg = Math.max(...weights);
  if (minKg === maxKg) {
    // A flat series still needs a band: half a kilo either side, so the dot is
    // not drawn on the axis where a zero baseline would imply.
    minKg -= 0.5;
    maxKg += 0.5;
  } else {
    const pad = (maxKg - minKg) * 0.1;
    minKg -= pad;
    maxKg += pad;
  }

  const firstDate = points[0].localDate;
  const lastDate = points[points.length - 1].localDate;
  const spanDays = daysBetweenLocalDates(firstDate, lastDate);

  const xOf = (localDate) => {
    if (spanDays <= 0) return padding.left + plotWidth / 2;
    return padding.left + (daysBetweenLocalDates(firstDate, localDate) / spanDays) * plotWidth;
  };
  const yOf = (weightKg) => padding.top + (1 - (weightKg - minKg) / (maxKg - minKg)) * plotHeight;

  const dots = points.map((point) => ({
    x: round(xOf(point.localDate)),
    y: round(yOf(point.weightKg)),
    localDate: point.localDate,
    weightKg: point.weightKg,
  }));

  const segments = [];
  for (let index = 1; index < dots.length; index += 1) {
    const from = dots[index - 1];
    const to = dots[index];
    segments.push({
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      gap: daysBetweenLocalDates(from.localDate, to.localDate) > 1,
    });
  }

  // Three weight ticks: the band's floor, middle and ceiling. Up to gram
  // precision and no trailing zeros: a slowly growing puppy's range is often a
  // few grams wide, and three identical "4.2"s would hide the scale entirely.
  const mid = (minKg + maxKg) / 2;
  const yTicks = [maxKg, mid, minKg].map((value) => ({
    y: round(yOf(value)),
    label: String(Number(value.toFixed(3))),
  }));

  const xTicks = [{ x: round(xOf(firstDate)), label: firstDate }];
  if (spanDays > 0) xTicks.push({ x: round(xOf(lastDate)), label: lastDate });

  return {
    width,
    height,
    plot: {
      x: padding.left,
      y: padding.top,
      width: plotWidth,
      height: plotHeight,
    },
    dots,
    segments,
    yTicks,
    xTicks,
    firstDate,
    lastDate,
    /** True when any segment crosses more than a day: the view captions it. */
    hasGaps: segments.some((segment) => segment.gap),
  };
}
