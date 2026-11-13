// P5-07: the monthly walk archive.
//
// A walk start or end rewrites the whole `app.walks` document (the open walk and
// the whole history), so its cost is linear in the history it holds — the same
// measured problem as `app.feeding` (`docs/data-growth.md`). Closed walks older
// than the current + previous household month move into one committed document
// per month; an open walk never moves, whatever its age.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Harness } from "@earendil-works/pi-durable";
import { startApp } from "../src/server/app.ts";
import { WalksArchiveDoc, WalksDoc, parseWalks } from "../src/server/domain/docs.ts";
import {
  WALKS_ARCHIVE_KEEP_MONTHS,
  archiveOldWalks,
  archivableWalks,
  endWalk,
  readWalks,
  startWalk,
} from "../src/server/domain/walks.ts";
import { archiveCutoff } from "../src/shared/dates.ts";
import { parseWalksArchive } from "../src/shared/walks.ts";
import type { Walks, WalksArchive } from "../src/shared/domain.ts";
import { startTestApp } from "./support/app.ts";

const ACTOR = { id: "owner", label: "Owner" } as const;
const TODAY = Date.parse("2026-03-15T12:00:00.000Z");
const CONTEXT: Context = BACKGROUND_CONTEXT;

/** 10th of the month, 09:00 UTC, for a walk started and ended in that month. */
function instantIn(month: string): Date {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNumber! - 1, 10, 9, 0));
}

async function seedWalks(harness: Harness, months: readonly string[]): Promise<void> {
  for (const month of months) {
    const started = instantIn(month);
    const start = await startWalk(harness, CONTEXT, {
      actor: async () => ACTOR,
      actionId: `seed:walk:${month}`,
      now: started,
    });
    assert.equal(start.kind, "started");
    const walk = start.kind === "started" ? start.walk : undefined;
    const end = await endWalk(harness, CONTEXT, {
      actor: async () => ACTOR,
      actionId: `seed:walk-end:${month}`,
      ...(walk ? { walkId: walk.id } : {}),
      observations: { pee: 1, poop: 1 },
      now: new Date(started.getTime() + 25 * 60 * 1000),
    });
    assert.equal(end.kind, "ended");
  }
}

test("an archived month is validated against its own address and holds no open walk", () => {
  const month = {
    schemaVersion: 1,
    month: "2026-01",
    createdAt: "2026-02-01T00:00:00.000Z",
    walks: [
      {
        id: "w1",
        startedAt: "2026-01-10T09:00:00.000Z",
        endedAt: "2026-01-10T09:25:00.000Z",
        startedActionId: "seed:1",
        endActionId: "seed:2",
        startedBy: "owner",
        startedByLabel: "Owner",
        endedBy: "owner",
        endedByLabel: "Owner",
      },
    ],
  };
  assert.ok(parseWalksArchive(month, "2026-01"));
  assert.equal(parseWalksArchive(month, "2026-02"), undefined, "a document cannot answer for another month");
  assert.equal(parseWalksArchive({ ...month, extra: true }, "2026-01"), undefined);
  assert.equal(
    parseWalksArchive({ ...month, walks: [{ ...month.walks[0], endedAt: undefined }] }, "2026-01"),
    undefined,
    "an open walk is never archived",
  );
  assert.equal(
    parseWalksArchive({ ...month, walks: [month.walks[0], { ...month.walks[0] }] }, "2026-01"),
    undefined,
    "duplicate ids are refused like any walk list",
  );
});

test("closed walks older than the window move to their archives, and an open walk stays", async () => {
  const fixture = await startTestApp({ prefix: "pupkeep-walks-archive-", now: TODAY });
  const harness = fixture.app.app;
  try {
    const months = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03"];
    await seedWalks(harness, months);
    // An open walk started long ago is still state to resolve, not history.
    const openStart = await startWalk(harness, CONTEXT, {
      actor: async () => ACTOR,
      actionId: "seed:open",
      now: instantIn("2025-12"),
    });
    assert.equal(openStart.kind, "started");

    const before = await readWalks(harness, CONTEXT);
    assert.equal(before.walks.length, months.length + 1);
    const cutoff = archiveCutoff("2026-03-15")!;
    const expected = archivableWalks(before, cutoff, "UTC");
    assert.equal(expected.length, 3, "three closed months are older than the window");
    assert.ok(
      expected.every((walk) => walk.endedAt !== undefined),
      "the open walk is never among them",
    );

    const result = await archiveOldWalks(harness, CONTEXT, new Date(TODAY));
    assert.deepEqual(result.months, ["2025-11", "2025-12", "2026-01"]);
    assert.equal(result.moved, 3);

    const hot = await readWalks(harness, CONTEXT);
    assert.equal(hot.walks.filter((walk) => walk.endedAt === undefined).length, 1, "the open walk stays");
    assert.deepEqual(
      new Set(hot.walks.filter((walk) => walk.endedAt !== undefined).map((walk) => walk.startedAt.slice(0, 7))),
      new Set(["2026-02", "2026-03"]),
    );

    const keptIds = new Set(hot.walks.map((walk) => walk.id));
    let archived = 0;
    for (const month of ["2025-11", "2025-12", "2026-01"]) {
      const snapshot = await harness.snapshot(WalksArchiveDoc, month, CONTEXT);
      assert.ok(snapshot, `${month} has an archive document`);
      const parsed = parseWalksArchive(snapshot, month);
      assert.ok(parsed, `${month} reads back as a valid archive`);
      assert.equal(parsed.walks.length, 1);
      assert.equal(month, parsed.walks[0]!.startedAt.slice(0, 7));
      assert.ok(!keptIds.has(parsed.walks[0]!.id), "an archived walk is not also in the hot document");
      archived += 1;
    }
    assert.equal(archived + hot.walks.length, before.walks.length, "no walk was lost");

    const again = await archiveOldWalks(harness, CONTEXT, new Date(TODAY));
    assert.deepEqual(again, { moved: 0, months: [] });
  } finally {
    await fixture.stop();
  }
});

test("a boot archives closed walks and keeps the open one", async () => {
  const fixture = await startTestApp({ prefix: "pupkeep-walks-boot-", now: TODAY });
  const months = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"];
  await seedWalks(fixture.app.app, months);
  const openStart = await startWalk(fixture.app.app, CONTEXT, {
    actor: async () => ACTOR,
    actionId: "seed:open-boot",
    now: instantIn("2025-10"),
  });
  assert.equal(openStart.kind, "started");

  await fixture.app.close();
  const rebooted = await startApp(
    { dataDir: fixture.dir, host: "127.0.0.1", port: 0, models: createModels(), now: () => TODAY },
    { logger: { debug() {}, info() {}, warn() {}, error() {} } as never },
  );
  assert.ok(rebooted.ok);
  if (!rebooted.ok) return;
  try {
    const hot = await readWalks(rebooted.app.app, CONTEXT);
    assert.equal(hot.walks.filter((walk) => walk.endedAt === undefined).length, 1);
    assert.deepEqual(
      new Set(hot.walks.filter((walk) => walk.endedAt !== undefined).map((walk) => walk.startedAt.slice(0, 7))),
      new Set(["2026-02", "2026-03"]),
    );
    let archived = 0;
    for (const month of ["2025-10", "2025-11", "2025-12", "2026-01"]) {
      const archivedDoc: WalksArchive | undefined = await rebooted.app.app.snapshot(WalksArchiveDoc, month, CONTEXT);
      assert.ok(archivedDoc, `${month} was archived at boot`);
      archived += parseWalksArchive(archivedDoc, month)?.walks.length ?? 0;
    }
    assert.equal(archived + hot.walks.length, months.length + 1, "the boot move kept every walk");
    assert.ok(parseWalks(await rebooted.app.app.snapshot(WalksDoc, CONTEXT)), "the hot document still parses");
  } finally {
    await rebooted.app.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
