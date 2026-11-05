// P3-07: the shower copy and caps are written twice — once for the model
// (`src/server/agent/shower-text.ts`) and once for the no-build browser card
// (`web/showers.js`) — so this test pins the two together.
//
// The two registers genuinely differ (the card writes "15 Nov 2026 — due today.";
// the model writes "next due 2026-11-15 (due today)"), so this asserts the
// *classification* they share: the same `daysUntilDue` produces the same answer
// to "is it due, overdue or in N days", and the caps the card sends are the
// document's caps. A server limit or a branch change that breaks one side now
// fails here instead of drifting silently.
//
// Plain JavaScript because `web/` is excluded from `tsc`; Node runs the
// TypeScript imports directly through type stripping.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SHAMPOO_LIMIT, SHOWER_NOTES_LIMIT } from "../src/shared/showers.ts";
import { showerStatusText } from "../src/server/agent/shower-text.ts";
import { NOTES_MAX, SHAMPOO_MAX, dueText, intervalText } from "../web/showers.js";

const LAST = {
  id: "s-1",
  localDate: "2026-10-25",
  at: "2026-10-24T22:30:00.000Z",
  byUserId: null,
  byLabel: "Household",
  source: "ui",
  actionId: "http:s-1",
};

function viewFor(daysUntilDue) {
  return {
    history: [],
    status: {
      last: daysUntilDue === null ? null : LAST,
      nextDue: daysUntilDue === null ? null : "2026-11-15",
      daysUntilDue,
    },
    intervalDays: 21,
  };
}

test("the card's text caps are the document's caps", () => {
  assert.equal(SHAMPOO_MAX, SHAMPOO_LIMIT, "the card must not send a shampoo the domain refuses");
  assert.equal(NOTES_MAX, SHOWER_NOTES_LIMIT, "the card must not send a note the domain refuses");
});

test("the model and the card classify the same due state the same way", () => {
  const cases = [
    [null, /none logged yet/i, /no showers logged yet/i],
    [0, /due today/, /due today/i],
    [-3, /3 days overdue/, /3 days overdue/i],
    [5, /in 5 days/, /in 5 days/i],
  ];
  for (const [days, modelCopy, cardCopy] of cases) {
    const view = viewFor(days);
    assert.match(showerStatusText(view), modelCopy, `the model's copy for ${days}`);
    assert.match(dueText(view.status), cardCopy, `the card's copy for ${days}`);
    assert.match(showerStatusText(view), /every 21 days/);
    assert.equal(intervalText(view.intervalDays), "every 21 days");
  }
});

test("a status without a due date does not leave a dangling clause", () => {
  // `showerStatus()` never produces this pair; the copy must still be a
  // sentence if a future shape does.
  const view = { ...viewFor(null), status: { last: LAST, nextDue: null, daysUntilDue: null } };
  assert.doesNotMatch(showerStatusText(view), /,\s*\./);
  assert.match(showerStatusText(view), /^Showers: last 2026-10-25 by "Household"\. Interval: every 21 days\.$/);
});
