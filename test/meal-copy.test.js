// P4-11: the meal-slot editor lives in `web/views/meal-slots.js`, which cannot
// import `src/shared` — the shell serves the browser modules as-is, with no
// build step and no import map — so `MEAL_SLOTS_MAX` is written twice. This
// test pins the two copies together: a web "Add a meal" button that offers a
// thirteenth slot, or a domain that starts refusing an eleventh, fails here
// instead of drifting silently until a caregiver hits the refusal.
//
// Plain JavaScript because `web/` is excluded from `tsc`; Node runs the
// TypeScript import directly through type stripping.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MEAL_SCHEDULE_RULE,
  MEAL_SLOTS_MAX as DOMAIN_MAX,
  SLOT_LABEL_LIMIT,
  SLOT_PORTION_LIMIT,
} from "../src/shared/feeding.ts";
import { MEAL_SLOTS_MAX, SLOT_LABEL_MAX, SLOT_PORTION_MAX } from "../web/views/meal-slots.js";

test("the web editor's slot cap is the domain's cap", () => {
  assert.equal(
    MEAL_SLOTS_MAX,
    DOMAIN_MAX,
    "the Add a meal button must stop exactly where the domain starts refusing",
  );
});

test("the editor's field caps are the domain's caps", () => {
  // `maxlength` too short hides a value the domain accepts; too long sends one
  // it refuses. Both directions are silent until a caregiver hits them.
  assert.equal(SLOT_LABEL_MAX, SLOT_LABEL_LIMIT, "the name input must accept exactly what the domain stores");
  assert.equal(SLOT_PORTION_MAX, SLOT_PORTION_LIMIT, "the portion input must accept exactly what the domain stores");
});

test("the refusal the caregiver reads names that same cap", () => {
  // The rule sentence hardcodes the numbers; if the cap moves and the sentence
  // does not, the server refuses at a limit the caregiver is not told about.
  assert.ok(
    MEAL_SCHEDULE_RULE.includes(`1 to ${DOMAIN_MAX} slots`),
    `the rule must name the cap it enforces, got: ${MEAL_SCHEDULE_RULE}`,
  );
});
