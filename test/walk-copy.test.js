// The Today walk card's "Started …" line (P5-… browser walk).
//
// The line used to be two template expressions on separate lines:
//
//     Started ${sameDay ? "at" : `on ${date} at`}
//     ${walkTimeText(open.startedAt, timezone)}…
//
// htm drops the whitespace between them, so the card read
// "Started at22:18 (UTC)" — the same defect the appointment detail had. The
// sentence is now composed in `startedText()`, which makes the separator part
// of the text; these assertions fail if it is ever split again.
//
// Plain JavaScript because `web/` is excluded from `tsc`; Node runs the module
// directly, and `dateText` is pinned by `test/client.test.js`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { startedText } from "../web/walks.js";

test("the same household day reads 'Started at HH:MM' with a space", () => {
  assert.equal(startedText("2026-11-12T22:18:00.000Z", "UTC", "2026-11-12"), "Started at 22:18 (UTC)");
});

test("an earlier day is named in the text, not left as a stored ISO date", () => {
  assert.equal(
    startedText("2026-11-11T18:00:00.000Z", "UTC", "2026-11-12"),
    "Started on 11 Nov 2026 at 18:00 (UTC)",
  );
});

test("the household zone decides the day boundary", () => {
  // 23:30Z on the 11th is 00:30 on the 12th in Paris: same day as "today".
  assert.equal(
    startedText("2026-11-11T23:30:00.000Z", "Europe/Paris", "2026-11-12"),
    "Started at 00:30 (Europe/Paris)",
  );
  assert.equal(
    startedText("2026-11-11T22:30:00.000Z", "Europe/Paris", "2026-11-12"),
    "Started on 11 Nov 2026 at 23:30 (Europe/Paris)",
  );
});

test("no household zone yet means an unknown time, never a doubled 'at'", () => {
  // The profile read and the walks read race on mount; the meals card says
  // "times are unknown" in the same window rather than falling back to UTC.
  assert.equal(startedText("2026-11-12T22:18:00.000Z", null, null), "Started at an unknown time");
});

test("a malformed instant keeps localTimeText's sentence, with one 'at'", () => {
  assert.equal(startedText("not-a-time", "UTC", "2026-11-12"), "Started at an unknown time");
});
