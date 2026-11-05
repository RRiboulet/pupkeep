// P3-02: the growth trend and its copy (PLAN §1.2, §12, §13.1, §15, §16 P3-02).
//
// The task is copy with thresholds, so every branch is pinned on both sides of
// its boundary, and the guardrail is a test: the notes state arithmetic, never
// a diagnosis, a dose, a range or a "should" about the puppy's health. The
// carried note from P3-01 is pinned too — staleness is a date question on the
// series, never an instant question on the latest measurement — and so is the
// reviewer-driven rule that a headline names its real span (monthly weighing is
// not "too short") and that the printed percentage is the classified one.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { GrowthPoint } from "../src/shared/growth.ts";
import {
  GROWTH_DISCLAIMER,
  GROWTH_STALE_DAYS,
  MIN_TREND_SPAN_DAYS,
  RAPID_GAIN_PCT,
  WEIGHT_LOSS_PCT,
  growthSummary,
  growthSummaryText,
  growthWindow,
  targetProgress,
} from "../src/shared/growth-trend.ts";

const TODAY = "2026-11-03";

function point(localDate: string, weightKg: number, at = `${localDate}T09:00:00.000Z`): GrowthPoint {
  return { localDate, at, weightKg, measurementId: `m-${localDate}-${weightKg}` };
}

/** Two readings 13 days apart: inside the 14-day headline window. */
function pair(fromWeight: number, toWeight: number, fromDate = "2026-10-21", toDate = TODAY): GrowthPoint[] {
  return [point(fromDate, fromWeight), point(toDate, toWeight)];
}

function summary(points: GrowthPoint[], targetWeightKg: number | null = null) {
  return growthSummary({ points, today: TODAY, targetWeightKg });
}

// --- the branches, both sides of every threshold ---------------------------

test("a loss beyond the threshold is worth a vet call, one below it is only steady", () => {
  const losing = summary(pair(5.0, 4.9));
  assert.equal(losing.state, "losing");
  assert.equal(
    losing.note,
    "Weight is down 2.0% over 13 days (5 kg → 4.9 kg). Worth a vet call.",
  );
  assert.equal(losing.headline?.spanDays, 13);
  assert.equal(losing.disclaimer, GROWTH_DISCLAIMER);
  // The plan's example wording, and the marker that makes it non-veterinary.
  assert.match(growthSummaryText(losing), /Worth a vet call\./);
  assert.ok(growthSummaryText(losing).endsWith(GROWTH_DISCLAIMER));

  // Just below the threshold *as it is printed*: 4.903 kg is -1.94%, which
  // rounds to -1.9% and stays steady. A change that prints "-2.0%" is
  // classified as a loss, so the sentence never contradicts its number.
  const barely = summary(pair(5.0, 4.903));
  assert.equal(barely.state, "steady");
  assert.equal(barely.note, "Weight is steady over 13 days (5 kg → 4.903 kg).");
  assert.doesNotMatch(barely.note, /vet/);
  assert.equal(summary(pair(5.0, 4.901)).state, "losing", "the printed 2.0% means losing");
  assert.equal(WEIGHT_LOSS_PCT, 2, "the threshold this test pins");
});

test("a gain is reported as arithmetic, a rapid gain as a large step, never as advice", () => {
  const gaining = summary(pair(5.0, 5.1));
  assert.equal(gaining.state, "gaining");
  assert.equal(gaining.note, "Weight is up 2.0% over 13 days (5 kg → 5.1 kg).");
  assert.doesNotMatch(gaining.note, /vet|large step|should/);

  // Just under the rapid threshold as printed: 5.497 kg is +9.94%, which
  // rounds to +9.9% and stays an ordinary gain.
  const fast = summary(pair(5.0, 5.497));
  assert.equal(fast.state, "gaining");
  assert.equal(fast.note, "Weight is up 9.9% over 13 days (5 kg → 5.497 kg).");

  // At the threshold: 5.5 kg is +10.0%.
  const rapid = summary(pair(5.0, 5.5));
  assert.equal(rapid.state, "rapid_gain");
  assert.equal(
    rapid.note,
    "Weight is up 10.0% over 13 days (5 kg → 5.5 kg). A large step — re-weigh on the same scale before relying on it as a trend.",
  );
  // A large step is a measurement warning, not a health judgement.
  assert.doesNotMatch(rapid.note, /vet|health|normal|should/);
  assert.equal(RAPID_GAIN_PCT, 10, "the threshold this test pins");
});

test("a steady series says so, and quiet numbers stay quiet", () => {
  const steady = summary(pair(5.0, 5.05));
  assert.equal(steady.state, "steady");
  assert.equal(steady.note, "Weight is steady over 13 days (5 kg → 5.05 kg).");
  assert.doesNotMatch(steady.note, /vet|large step/);
});

test("stale is its own state, and it never renders as steady", () => {
  // A flat pair that would otherwise be "steady", last read ten days ago.
  const points = [point("2026-10-21", 5.0), point("2026-10-24", 5.0)];
  const stale = growthSummary({ points, today: TODAY, targetWeightKg: null });
  assert.equal(stale.state, "stale");
  assert.equal(stale.note, "No weight logged in 10 days (last 2026-10-24: 5 kg).");
  assert.equal(stale.headline, null, "the note is not about a comparison, so no pair is offered");
  assert.doesNotMatch(growthSummaryText(stale), /steady/);
  assert.equal(GROWTH_STALE_DAYS, 10, "the threshold this test pins");

  // Nine days is not stale: the same pair is a steady series.
  const fresh = growthSummary({ points, today: "2026-11-02", targetWeightKg: null });
  assert.equal(fresh.state, "steady");
  assert.equal(fresh.note, "Weight is steady over 3 days (5 kg → 5 kg).");
});

test("staleness is a date question on the series, not an instant question on the last write", () => {
  // A later instant with an older stored local date is what a westward timezone
  // change leaves behind. `latestMeasurement()` would call this one day old; the
  // series' last *day* is 13 days old, and that is the question a stale rule
  // must answer (P3-01's carried note).
  const points = [point("2026-10-01", 4.0, "2026-11-01T00:00:00.000Z"), point("2026-10-20", 4.2)];
  const here = growthSummary({ points, today: "2026-11-02", targetWeightKg: null });
  assert.equal(here.state, "stale");
  assert.match(here.note, /No weight logged in 13 days/);
});

test("no history, one reading and two days of history are three different states", () => {
  const empty = summary([]);
  assert.equal(empty.state, "no_data");
  assert.equal(empty.headline, null);
  assert.equal(empty.note, "No weight logged yet.");
  assert.equal(empty.target, null);
  assert.equal(growthSummaryText(empty), `No weight logged yet.\n${GROWTH_DISCLAIMER}`);

  const one = summary([point(TODAY, 4.2)]);
  assert.equal(one.state, "no_data");
  assert.equal(one.note, "One weight logged (4.2 kg on 2026-11-03); a trend needs at least two readings.");

  const close = growthSummary({
    points: [point("2026-10-20", 4.2), point("2026-10-21", 4.25)],
    today: "2026-10-22",
    targetWeightKg: null,
  });
  assert.equal(close.state, "too_short");
  assert.equal(
    close.note,
    "The last two weights are only 1 day apart; a trend needs readings at least 3 days apart.",
  );
  assert.ok(close.headline !== null, "the note describes that pair, so it is offered");
  assert.equal(MIN_TREND_SPAN_DAYS, 3, "the threshold this test pins");

  // Two days is still too short; three days is a comparison.
  const twoDays = growthSummary({
    points: [point("2026-11-01", 4.2), point(TODAY, 4.3)],
    today: TODAY,
    targetWeightKg: null,
  });
  assert.equal(twoDays.state, "too_short");
  assert.equal(twoDays.note, "The last two weights are only 2 days apart; a trend needs readings at least 3 days apart.");
  const threeDays = growthSummary({
    points: [point("2026-10-31", 4.2), point(TODAY, 4.3)],
    today: TODAY,
    targetWeightKg: null,
  });
  assert.equal(threeDays.state, "gaining");
  assert.equal(threeDays.note, "Weight is up 2.4% over 3 days (4.2 kg → 4.3 kg).");
});

test("a future-dated reading is kept in the document but never becomes 'now'", () => {
  // A clock jump leaves a reading dated 2027 in the log. It must not hijack the
  // current weight, stretch the span to 223 days, or switch staleness off.
  const points = [point("2026-10-21", 5.0), point("2027-06-01", 2.0)];
  const here = summary(points);
  assert.equal(here.state, "stale", "the last reading as of today is 13 days old");
  assert.equal(here.note, "No weight logged in 13 days (last 2026-10-21: 5 kg).");
  assert.doesNotMatch(growthSummaryText(here), /2027|2 kg|60\.0%/);
  assert.equal(here.headline, null);
});

// --- the headline pair -----------------------------------------------------

test("a monthly weigh-in is a 30-day comparison, not 'too short'", () => {
  // The 14-day slice holds only the latest reading, so the headline falls back
  // to the last two readings and states the span they actually have.
  const monthly = summary([point("2026-10-04", 5.0), point(TODAY, 5.4)]);
  assert.equal(monthly.state, "gaining");
  assert.equal(monthly.headline?.spanDays, 30);
  assert.equal(monthly.note, "Weight is up 8.0% over 30 days (5 kg → 5.4 kg).");
});

test("the headline prefers the 14-day slice, and falls back to the last two readings", () => {
  // Readings 20 and 40 days back: the 14-day slice has one reading, so the
  // headline is the most recent pair (20 days), not the whole history.
  const points = [point("2026-09-24", 4.0), point("2026-10-14", 4.6), point(TODAY, 4.7)];
  const here = summary(points);
  assert.equal(here.headline?.from.localDate, "2026-10-14");
  assert.equal(here.headline?.spanDays, 20);
  assert.equal(here.note, "Weight is up 2.2% over 20 days (4.6 kg → 4.7 kg).");

  // A daily-ish history inside the window compares the oldest of the slice.
  const daily = summary([point("2026-10-21", 5.0), point("2026-10-28", 5.1), point(TODAY, 5.2)]);
  assert.equal(daily.headline?.from.localDate, "2026-10-21");
  assert.equal(daily.headline?.spanDays, 13);
});

test("a slice is a chart radius of calendar dates: it names what is missing and reports the real span", () => {
  // The last 7 calendar dates are 10-28 … 11-03, so six days back is inside and
  // seven is not. The label says 7 days; the data is those 7 dates.
  const six = growthWindow([point("2026-10-28", 5.0), point(TODAY, 5.2)], TODAY, 7);
  assert.equal(six.available, true);
  if (six.available) {
    assert.equal(six.spanDays, 6);
    assert.equal(six.pct, 4);
  }
  assert.deepEqual(growthWindow([point("2026-10-27", 5.0), point(TODAY, 5.2)], TODAY, 7), {
    days: 7,
    available: false,
    reason: "one_reading",
    }, "a reading seven days back is outside the 7-day slice");
  assert.equal(growthWindow([point("2026-10-20", 5.0)], TODAY, 7).available, false);
  assert.deepEqual(growthWindow([point("2026-10-20", 5.0)], TODAY, 7), {
    days: 7,
    available: false,
    reason: "no_readings",
  });
  assert.deepEqual(growthWindow([point(TODAY, 5.0)], TODAY, 7), {
    days: 7,
    available: false,
    reason: "one_reading",
  });
  assert.deepEqual(growthWindow([point("2026-11-02", 5.0), point(TODAY, 5.2)], TODAY, 7), {
    days: 7,
    available: false,
    reason: "too_short",
  });

  // A 29-day pair is inside the 30-date slice; the 30-day pair is not, and the
  // chart entry never changes the headline's copy (the headline is its own pair).
  const inside = growthWindow([point("2026-10-05", 5.0), point(TODAY, 5.4)], TODAY, 30);
  assert.equal(inside.available, true);
  const outside = growthWindow([point("2026-10-04", 5.0), point(TODAY, 5.4)], TODAY, 30);
  assert.deepEqual(outside, { days: 30, available: false, reason: "one_reading" });
  const here = summary([point("2026-10-04", 5.0), point(TODAY, 5.4)]);
  assert.equal(here.headline?.spanDays, 30, "the headline is not slice-limited");
});

test("a recent pair closer than three days is too short even with a long history", () => {
  // Documented choice (PLAN P3-02 decision 10): the headline is the *recent*
  // trend. The 11% loss over two months is real and stays in the chart/series,
  // but the copy does not claim a trend from two readings a day apart.
  const points = [point("2026-09-01", 5.0), point("2026-11-02", 4.5), point(TODAY, 4.45)];
  const here = summary(points);
  assert.equal(here.state, "too_short");
  assert.equal(here.note, "The last two weights are only 1 day apart; a trend needs readings at least 3 days apart.");
  assert.equal(here.windows.find((window) => window.days === 30)?.available, false, "a 1-day pair is too short in every slice");
});

// --- the target and the rendering ------------------------------------------

test("the target distance is the profile's, and a reached target says so", () => {
  const points = [point("2026-10-25", 4.2), point(TODAY, 4.6)];
  const toGo = summary(points, 10);
  assert.deepEqual(toGo.target, { targetKg: 10, latestKg: 4.6, remainingKg: 5.4, reached: false });
  assert.match(growthSummaryText(toGo), /Target 10 kg — 5.4 kg to go\./);

  const reached = summary(points, 4.6);
  assert.deepEqual(reached.target, { targetKg: 4.6, latestKg: 4.6, remainingKg: 0, reached: true });
  assert.match(growthSummaryText(reached), /Target 4.6 kg reached \(4\.6 kg\)\./);

  // Past the target is still reached; no target and no reading are `null`.
  assert.equal(targetProgress(point(TODAY, 4.6), 4.0)?.reached, true);
  assert.equal(targetProgress(point(TODAY, 4.6), null), null);
  assert.equal(targetProgress(undefined, 10), null);
  assert.equal(summary(points, null).target, null);
});

test("the disclaimer says what it must, in words the test pins", () => {
  assert.equal(GROWTH_DISCLAIMER, "Trends are arithmetic over the logged weights, not veterinary advice.");
  assert.match(GROWTH_DISCLAIMER, /not veterinary advice/);
});

test("the rendering is the note, the target and the disclaimer — no second quieter sentence", () => {
  const text = growthSummaryText(summary(pair(5.0, 5.1), 10));
  assert.deepEqual(text.split("\n"), [
    "Weight is up 2.0% over 13 days (5 kg → 5.1 kg).",
    "Target 10 kg — 4.9 kg to go.",
    GROWTH_DISCLAIMER,
  ]);
});

test("a bad 'today' fails with the value, not an arithmetic error", () => {
  assert.throws(
    () => growthSummary({ points: [], today: "2026-02-30", targetWeightKg: null }),
    /not a local date: 2026-02-30/,
  );
});

test("every note is arithmetic: no dose, no range, no diagnosis, no 'should'", () => {
  const summaries = [
    summary(pair(5.0, 4.9), 10),
    summary(pair(5.0, 5.1)),
    summary(pair(5.0, 5.5)),
    summary(pair(5.0, 5.05)),
    summary([point("2026-10-04", 5.0), point(TODAY, 5.4)]),
    growthSummary({ points: [point("2026-10-20", 5.0)], today: TODAY, targetWeightKg: 10 }),
    growthSummary({ points: [point("2026-10-21", 5.0), point("2026-10-24", 5.0)], today: TODAY, targetWeightKg: 10 }),
    growthSummary({ points: [point("2026-11-02", 4.2), point(TODAY, 4.3)], today: TODAY, targetWeightKg: 10 }),
    growthSummary({ points: [], today: TODAY, targetWeightKg: null }),
  ];
  for (const here of summaries) {
    // The note and the whole rendering, because the target line lives only there.
    for (const text of [here.note, growthSummaryText(here)]) {
      for (const forbidden of [
        "should",
        "must",
        "dose",
        "dosage",
        "mg",
        "diagnos",
        "underweight",
        "overweight",
        "healthy",
        "normal",
        "abnormal",
        "urgent",
        "emergency",
        "diet",
        "calorie",
        "treat",
        "% of",
        "range",
      ]) {
        assert.doesNotMatch(text, new RegExp(forbidden, "i"), `${forbidden} in ${JSON.stringify(text)}`);
      }
    }
  }
});
