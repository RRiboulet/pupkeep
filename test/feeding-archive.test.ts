// P5-07: the monthly feed archive.
//
// Every feed commit rewrites the whole `app.feeding` document, so its cost is
// linear in the history it holds (`docs/data-growth.md`: 53 ms at 1 500 events
// on the host). The fix is not a cap that loses history: events older than the
// current + previous household month move into one committed document per
// month. These tests pin the window, the move (one commit, nothing dropped) and
// the boot seam that does it for a phone that ran for a month.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Harness } from "@earendil-works/pi-durable";
import { startApp } from "../src/server/app.ts";
import { FeedingArchiveDoc, FeedingDoc, parseFeeding } from "../src/server/domain/docs.ts";
import {
  FEEDING_ARCHIVE_KEEP_MONTHS,
  archiveOldFeeds,
  archivableFeedEvents,
  logFeed,
  readFeeding,
  updateMealSlots,
} from "../src/server/domain/feeding.ts";
import { archiveCutoff, monthOf, shiftMonth } from "../src/shared/dates.ts";
import { parseFeedingArchive } from "../src/shared/feeding.ts";
import type { FeedingArchive, MealSlot } from "../src/shared/domain.ts";
import { startTestApp } from "./support/app.ts";

const ACTOR = { id: "owner", label: "Owner" } as const;
const SLOTS: MealSlot[] = [
  { id: "slot-breakfast", label: "Breakfast", timeLocal: "07:00", active: true },
  { id: "slot-lunch", label: "Lunch", timeLocal: "12:00", active: true },
  { id: "slot-dinner", label: "Dinner", timeLocal: "18:00", active: true },
];
/** The pinned "today": 15 March 2026, UTC household. */
const TODAY = Date.parse("2026-03-15T12:00:00.000Z");
const CONTEXT: Context = BACKGROUND_CONTEXT;

/** One instant in a month, 10th, at the slot's hour (UTC household). */
function instantIn(month: string, slotIndex: number): Date {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNumber! - 1, 10, 7 + slotIndex * 5, 5));
}

/** Seed three scheduled meals for each month, through the real writer. */
async function seedMonths(harness: Harness, months: readonly string[]): Promise<void> {
  await updateMealSlots(harness, CONTEXT, {
    actor: async () => ACTOR,
    actionId: "seed:slots",
    rev: 0,
    slots: SLOTS,
    now: instantIn(months[0]!, 0),
  });
  for (const month of months) {
    for (const [index, slot] of SLOTS.entries()) {
      await logFeed(harness, CONTEXT, {
        actor: async () => ACTOR,
        actionId: `seed:feed:${month}:${index}`,
        slotId: slot.id,
        amount: "40 g",
        source: "ui",
        now: instantIn(month, index),
      });
    }
  }
}

test("months shift without a Date, and the archive window is the current and previous month", () => {
  assert.equal(monthOf("2026-03-15"), "2026-03");
  assert.equal(monthOf("2026-03"), undefined, "a month is not a local date");
  assert.equal(monthOf("2026-13-01"), undefined);

  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-03", -3), "2025-12");
  assert.equal(shiftMonth("0000-01", -1), undefined);

  assert.equal(FEEDING_ARCHIVE_KEEP_MONTHS, 2);
  assert.equal(archiveCutoff("2026-03-15"), "2026-02");
  assert.equal(archiveCutoff("2026-01-01", 3), "2025-11");
  assert.equal(archiveCutoff("2026-03-15", 0), undefined);
});

test("an archived month is validated against its own address", () => {
  const event = {
    id: "e1",
    slotId: "slot-breakfast",
    localDate: "2026-01-10",
    at: "2026-01-10T07:05:00.000Z",
    byUserId: "owner",
    byLabel: "Owner",
    source: "ui" as const,
    actionId: "seed:1",
  };
  const month = { schemaVersion: 1, month: "2026-01", events: [event], createdAt: "2026-02-01T00:00:00.000Z" };
  assert.ok(parseFeedingArchive(month, "2026-01"));
  assert.equal(parseFeedingArchive(month, "2026-02"), undefined, "a document cannot hold another month");
  assert.equal(parseFeedingArchive({ ...month, month: "2026-1" }, "2026-1"), undefined, "not a YYYY-MM address");
  assert.equal(
    parseFeedingArchive({ ...month, events: [{ ...event, localDate: "2026-02-10" }] }, "2026-01"),
    undefined,
    "every event belongs to the addressed month",
  );
  assert.equal(
    parseFeedingArchive({ ...month, events: [event, { ...event }] }, "2026-01"),
    undefined,
    "duplicate ids are refused like any other feed list",
  );
  assert.equal(parseFeedingArchive({ ...month, extra: true }, "2026-01"), undefined, "unknown keys are refused");
});

test("old months move to their archives in one commit, and nothing is dropped", async () => {
  const fixture = await startTestApp({ prefix: "pupkeep-archive-", now: TODAY });
  const harness = fixture.app.app;
  try {
    const months = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03"];
    await seedMonths(harness, months);
    const before = await readFeeding(harness, CONTEXT);
    assert.equal(before.events.length, months.length * SLOTS.length);
    assert.equal(before.rev, 1, "the schedule revision is not the feed list's");

    const cutoff = archiveCutoff("2026-03-15")!;
    const expected = archivableFeedEvents(before, cutoff);
    assert.equal(expected.length, 9, "three full months are older than the window");

    const result = await archiveOldFeeds(harness, CONTEXT, new Date(TODAY));
    assert.deepEqual(result.months, ["2025-11", "2025-12", "2026-01"]);
    assert.equal(result.moved, 9);

    const hot = await readFeeding(harness, CONTEXT);
    assert.equal(hot.rev, 1, "archiving events does not touch the schedule revision");
    assert.deepEqual(new Set(hot.events.map((event) => monthOf(event.localDate))), new Set(["2026-02", "2026-03"]));
    assert.equal(hot.slots.length, SLOTS.length, "the schedule stays hot");

    // Every event is still there, in its month's committed document.
    const keptIds = new Set(hot.events.map((event) => event.id));
    let archived = 0;
    for (const month of ["2025-11", "2025-12", "2026-01"]) {
      const snapshot = await harness.snapshot(FeedingArchiveDoc, month, CONTEXT);
      assert.ok(snapshot, `${month} has an archive document`);
      const parsed = parseFeedingArchive(snapshot, month);
      assert.ok(parsed, `${month} reads back as a valid archive`);
      assert.equal(parsed.events.length, 3);
      for (const event of parsed.events) {
        assert.equal(monthOf(event.localDate), month);
        assert.ok(!keptIds.has(event.id), "an archived event is not also in the hot document");
        assert.equal(event.amount, "40 g");
        archived += 1;
      }
    }
    assert.equal(archived + hot.events.length, before.events.length, "no event was lost");

    // Idempotent: nothing left to move is not a commit.
    const again = await archiveOldFeeds(harness, CONTEXT, new Date(TODAY));
    assert.deepEqual(again, { moved: 0, months: [] });
    const after = await readFeeding(harness, CONTEXT);
    assert.equal(after.events.length, hot.events.length);
  } finally {
    await fixture.stop();
  }
});

test("a boot archives an aged document, so a phone that ran for months shrinks on restart", async () => {
  const fixture = await startTestApp({ prefix: "pupkeep-archive-boot-", now: TODAY });
  const months = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"];
  await seedMonths(fixture.app.app, months);
  const seeded = (await readFeeding(fixture.app.app, CONTEXT)).events.length;
  assert.equal(seeded, 18);

  // Close without removing the directory, then boot it again: the boot seam,
  // not a test call, is what has to do the move.
  await fixture.app.close();
  const rebooted = await startApp(
    { dataDir: fixture.dir, host: "127.0.0.1", port: 0, models: createModels(), now: () => TODAY },
    { logger: { debug() {}, info() {}, warn() {}, error() {} } as never },
  );
  assert.ok(rebooted.ok);
  if (!rebooted.ok) return;
  try {
    const hot = await readFeeding(rebooted.app.app, CONTEXT);
    const hotMonths = new Set(hot.events.map((event) => monthOf(event.localDate)));
    assert.deepEqual(hotMonths, new Set(["2026-02", "2026-03"]));
    let archived = 0;
    for (const month of ["2025-10", "2025-11", "2025-12", "2026-01"]) {
      const archivedDoc: FeedingArchive | undefined = await rebooted.app.app.snapshot(
        FeedingArchiveDoc,
        month,
        CONTEXT,
      );
      assert.ok(archivedDoc, `${month} was archived at boot`);
      archived += parseFeedingArchive(archivedDoc, month)?.events.length ?? 0;
    }
    assert.equal(archived + hot.events.length, seeded, "the boot move kept every event");
    assert.ok(parseFeeding(await rebooted.app.app.snapshot(FeedingDoc, CONTEXT)), "the hot document still parses");
  } finally {
    await rebooted.app.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
