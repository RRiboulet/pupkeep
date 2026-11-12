// The session-document checkpoint policy (P5-07).
//
// `checkpointWhen` answers "store this change as a base instead of a delta".
// This storage writes a delta as the **whole document value**, so the window is
// a direct multiplier on the file size and on the cold read — `docs/data-growth.md`
// measured 26x the file and 11x the first read at a window of 100 for no
// saving in commit cost. These assertions pin the window at "at most one delta
// between bases", so a future edit cannot widen it back without an argument.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActivityDoc,
  ApprovalsDoc,
  CalendarDoc,
  CommandsDoc,
  FeedingDoc,
  GrowthDoc,
  HouseholdDoc,
  NotificationsDoc,
  PuppyDoc,
  ShowersDoc,
  TrainingDoc,
  UsageDoc,
  WalksDoc,
  checkpointEvery,
} from "../src/server/domain/docs.ts";

/** The shape these assertions need from a document token. */
interface PolicyDoc {
  readonly definition: {
    initial(): unknown;
    checkpointWhen(value: unknown, ops: readonly unknown[], info: { deltasSinceBase: number }): boolean;
  };
}

const DOCS: ReadonlyArray<readonly [string, PolicyDoc]> = [
  ["app.activity", ActivityDoc as unknown as PolicyDoc],
  ["app.approvals", ApprovalsDoc as unknown as PolicyDoc],
  ["app.calendar", CalendarDoc as unknown as PolicyDoc],
  ["app.commands", CommandsDoc as unknown as PolicyDoc],
  ["app.feeding", FeedingDoc as unknown as PolicyDoc],
  ["app.growth", GrowthDoc as unknown as PolicyDoc],
  ["app.household", HouseholdDoc as unknown as PolicyDoc],
  ["app.notifications", NotificationsDoc as unknown as PolicyDoc],
  ["app.puppy", PuppyDoc as unknown as PolicyDoc],
  ["app.showers", ShowersDoc as unknown as PolicyDoc],
  ["app.training", TrainingDoc as unknown as PolicyDoc],
  ["app.usage", UsageDoc as unknown as PolicyDoc],
  ["app.walks", WalksDoc as unknown as PolicyDoc],
];

test("the helper checkpoints at its window, not before", () => {
  const everyThree = checkpointEvery(3);
  assert.equal(everyThree(undefined, [], { deltasSinceBase: 2 }), false);
  assert.equal(everyThree(undefined, [], { deltasSinceBase: 3 }), true);
  assert.equal(everyThree(undefined, [], { deltasSinceBase: 4 }), true);
});

test("every session document keeps at most one delta between bases", () => {
  for (const [name, doc] of DOCS) {
    const policy = doc.definition.checkpointWhen;
    assert.equal(
      policy(doc.definition.initial(), [], { deltasSinceBase: 0 }),
      false,
      `${name}: the first change after a base is a delta`,
    );
    assert.equal(
      policy(doc.definition.initial(), [], { deltasSinceBase: 1 }),
      true,
      `${name}: the second change is a base, so at most one full copy piles up`,
    );
  }
});
