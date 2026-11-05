// P3-01: `app.growth` and its service (PLAN §8.1, §8.3, §8.4, §8.5, §9.2, §7.3).
//
// What is covered, in the order the code is layered:
//   * the shape: one unit per number (kg with gram precision, cm with a tenth),
//     the §9.2 pairing, the note bounds, and a document that refuses a stored
//     value a caregiver could not have entered;
//   * the derived series: several measurements a day are kept, the day's latest
//     is the day's reading, and a clock jump cannot reorder history;
//   * the service over a real SQLite harness: one commit (measurement, activity,
//     idempotency record), replay, key conflict, the household-local date, and
//     the household fallback actor;
//   * the target weight: it stays on `app.puppy` (P1-11) — this document never
//     copies it;
//   * bootstrap: a database that predates P3-01 gets `app.growth`, a malformed
//     one refuses boot, and a measurement survives a reopen.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { emptyConfig, type MemberRecord } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import {
  ActivityDoc,
  CommandsDoc,
  GrowthDoc,
  PuppyDoc,
  emptyGrowth,
  parseGrowth,
  parsePuppy,
} from "../src/server/domain/docs.ts";
import { DomainConflictError } from "../src/server/domain/errors.ts";
import { GrowthUnavailableError, logMeasurement, readGrowth } from "../src/server/domain/growth.ts";
import { updatePuppyProfile } from "../src/server/domain/profile.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import {
  MEASUREMENT_RULE,
  formatWeightKg,
  growthSeries,
  latestMeasurement,
  parseGrowthMeasurement,
  parseGrowthMeasurements,
  parseMeasurementFields,
} from "../src/shared/growth.ts";
import type { GrowthMeasurement } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
const NOON = new Date("2026-10-29T12:00:00.000Z");
const CREATED = "2026-10-29T10:00:00.000Z";

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "owner",
    role: "owner",
    displayName: "Alex",
    createdAt: CREATED,
    sessions: [],
    ...overrides,
  };
}

const owner = member();
const partner = member({ id: "partner", role: "member", displayName: "Sam" });

const alex = async () => ({ id: "owner", label: "Alex" });
const householdActor = async () => ({ id: null, label: "Household" });

function measurement(overrides: Partial<GrowthMeasurement> = {}): GrowthMeasurement {
  return {
    id: "measurement-1",
    localDate: "2026-10-29",
    at: NOON.toISOString(),
    weightKg: 4.25,
    byUserId: "owner",
    byLabel: "Alex",
    source: "ui",
    actionId: "http:weigh-1",
    ...overrides,
  };
}

async function withGrowthHarness(run: (opened: OpenedHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-growth-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
  try {
    await bootstrapSession(opened.harness, {
      config: { ...emptyConfig(), members: [owner, partner] },
      context,
      timezone: "Europe/Paris",
      now: () => NOON,
    });
    await run(opened);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

async function activity(harness: OpenedHarness["harness"]): Promise<string[]> {
  return ((await harness.snapshot(ActivityDoc, context))?.entries ?? []).map((entry) => entry.summary);
}

// --- the shape --------------------------------------------------------------

test("a measurement is kilograms with gram precision and centimetres with a tenth", () => {
  assert.deepEqual(parseGrowthMeasurement(measurement()), measurement());
  assert.deepEqual(parseGrowthMeasurement(measurement({ heightCm: 31.5, note: "after breakfast " })), {
    ...measurement(),
    heightCm: 31.5,
    note: "after breakfast",
  });

  assert.equal(parseGrowthMeasurement({ ...measurement(), extra: true }), undefined, "an unknown key is refused");
  assert.equal(parseGrowthMeasurement({ ...measurement(), id: "" }), undefined);
  assert.equal(parseGrowthMeasurement({ ...measurement(), id: "a b" }), undefined);
  assert.equal(parseGrowthMeasurement({ ...measurement(), localDate: "2026-02-30" }), undefined);
  assert.equal(parseGrowthMeasurement({ ...measurement(), at: "2026-10-29T12:00:00" }), undefined, "no zone-less instants");
  assert.equal(parseGrowthMeasurement({ ...measurement(), source: "email" }), undefined);
  assert.equal(parseGrowthMeasurement({ ...measurement(), actionId: "http:weigh 1" }), undefined);

  // The unit is the number: zero, a negative, a non-number and a ton of puppy
  // are all refused, and so is sub-gram precision — a document only holds a
  // weight a caregiver could have typed.
  assert.equal(parseGrowthMeasurement({ ...measurement(), weightKg: 0 }), undefined);
  assert.equal(parseGrowthMeasurement({ ...measurement(), weightKg: -1 }), undefined);
  assert.equal(parseGrowthMeasurement({ ...measurement(), weightKg: "4.25" }), undefined);
  assert.equal(parseGrowthMeasurement({ ...measurement(), weightKg: 200.001 }), undefined);
  assert.equal(parseGrowthMeasurement({ ...measurement(), weightKg: 4.2374 }), undefined, "more precision than a gram");
  assert.ok(parseGrowthMeasurement({ ...measurement(), weightKg: 4.237 }), "three decimals are whole grams");

  assert.equal(parseGrowthMeasurement({ ...measurement(), heightCm: 0 }), undefined);
  assert.equal(parseGrowthMeasurement({ ...measurement(), heightCm: 31.55 }), undefined, "more precision than a tenth");
  assert.ok(parseGrowthMeasurement({ ...measurement(), heightCm: 200 }));

  assert.equal(parseGrowthMeasurement({ ...measurement(), note: "" }), undefined, "an empty note is absent, not stored");
  assert.equal(parseGrowthMeasurement({ ...measurement(), note: "x".repeat(281) }), undefined);
  assert.equal(parseGrowthMeasurement({ ...measurement(), note: "two\nlines" }), undefined);

  // §9.2's fence: no member id always travels with the household label.
  assert.equal(parseGrowthMeasurement({ ...measurement(), byUserId: null }), undefined);
  assert.ok(parseGrowthMeasurement({ ...measurement(), byUserId: null, byLabel: "Household" }));
});

test("the write parser rounds to the stored precision and refuses a typo", () => {
  assert.deepEqual(parseMeasurementFields({ weightKg: 4.2374 }), { weightKg: 4.237 });
  assert.deepEqual(parseMeasurementFields({ weightKg: 4.2, heightCm: 31.46 }), { weightKg: 4.2, heightCm: 31.5 });
  assert.deepEqual(parseMeasurementFields({ weightKg: 4.2, heightCm: null }), { weightKg: 4.2 });
  // An empty or padded note is the same request as no note.
  assert.deepEqual(parseMeasurementFields({ weightKg: 4.2, note: "   " }), { weightKg: 4.2 });
  assert.deepEqual(parseMeasurementFields({ weightKg: 4.2, note: "  after a nap " }), {
    weightKg: 4.2,
    note: "after a nap",
  });

  assert.equal(parseMeasurementFields(undefined), undefined);
  assert.equal(parseMeasurementFields([]), undefined);
  assert.equal(parseMeasurementFields({}), undefined, "a weight is required");
  assert.equal(parseMeasurementFields({ weightKg: 4.2, grams: 4200 }), undefined, "an unknown key is refused");
  assert.equal(parseMeasurementFields({ weightKg: 4.2, note: "a\nb" }), undefined);
  assert.equal(parseMeasurementFields({ weightKg: 0.0004 }), undefined, "a weight below half a gram rounds to zero");
  assert.equal(parseMeasurementFields({ weightKg: 201 }), undefined);

  // The one formatter the activity line and, later, the UI share.
  assert.equal(formatWeightKg(4.25), "4.25 kg");
  assert.equal(formatWeightKg(4.2), "4.2 kg");
  assert.equal(formatWeightKg(4), "4 kg");
  assert.equal(formatWeightKg(0.3), "0.3 kg");
});

test("several measurements a day are kept, and the day's latest is the day's reading", () => {
  const morning = measurement({ id: "m-1", at: "2026-10-29T08:00:00.000Z", weightKg: 4.2 });
  const evening = measurement({ id: "m-2", at: "2026-10-29T20:00:00.000Z", weightKg: 4.25, heightCm: 31.5 });
  const yesterday = measurement({ id: "m-3", localDate: "2026-10-28", at: "2026-10-28T09:00:00.000Z", weightKg: 4.1 });

  // Append order is not a document rule; a reader sorts. A duplicate id is.
  assert.deepEqual(growthSeries({ measurements: [evening, yesterday, morning] }), [
    { localDate: "2026-10-28", at: yesterday.at, weightKg: 4.1, measurementId: "m-3" },
    { localDate: "2026-10-29", at: evening.at, weightKg: 4.25, heightCm: 31.5, measurementId: "m-2" },
  ]);
  assert.equal(latestMeasurement({ measurements: [evening, yesterday, morning] })?.id, "m-2");

  // A backward clock append must not reorder the days: the stored local date is
  // the day the household lived, not a value re-derived from `at` today.
  const backward = measurement({
    id: "m-4",
    localDate: "2026-10-27",
    at: "2026-10-27T09:00:00.000Z",
    weightKg: 4.0,
  });
  assert.deepEqual(
    growthSeries({ measurements: [evening, backward, morning] }).map((point) => point.localDate),
    ["2026-10-27", "2026-10-29"],
  );

  assert.deepEqual(parseGrowthMeasurements([morning, evening]), [morning, evening]);
  assert.equal(
    parseGrowthMeasurements([morning, { ...evening, id: "m-1" }]),
    undefined,
    "a repeated id is a bug, not a document",
  );
  assert.deepEqual(emptyGrowth(), { schemaVersion: 1, measurements: [], createdAt: "" });
});

// --- the service ------------------------------------------------------------

test("logging a measurement is one commit: the record, one activity line, the key", async () => {
  await withGrowthHarness(async (opened) => {
    const before = (await opened.harness.snapshot(CommandsDoc, context))?.entries.length ?? 0;
    const outcome = await logMeasurement(opened.harness, context, {
      actor: alex,
      actionId: "http:weigh-1",
      weightKg: 4.2374,
      note: "  after a nap ",
      source: "ui",
      now: NOON,
      id: "measurement-1",
    });
    assert.equal(outcome.kind, "logged");
    assert.deepEqual(outcome.measurement, {
      id: "measurement-1",
      localDate: "2026-10-29",
      at: NOON.toISOString(),
      weightKg: 4.237,
      note: "after a nap",
      byUserId: "owner",
      byLabel: "Alex",
      source: "ui",
      actionId: "http:weigh-1",
    });
    assert.deepEqual((await readGrowth(opened.harness, context)).measurements, [outcome.measurement]);
    assert.deepEqual(await activity(opened.harness), ["Alex logged a weight of 4.237 kg"]);
    const commands = (await opened.harness.snapshot(CommandsDoc, context))?.entries ?? [];
    assert.equal(commands.length, before + 1);
    assert.equal(commands.at(-1)?.key, "http:weigh-1");
  });
});

test("the same action replays as success, and a different body is a key conflict", async () => {
  await withGrowthHarness(async (opened) => {
    const input = {
      actor: alex,
      actionId: "http:weigh-1",
      weightKg: 4.2,
      note: "  4.2 kg  ",
      source: "ui",
      now: NOON,
    } as const;
    const first = await logMeasurement(opened.harness, context, input);
    assert.equal(first.kind, "logged");

    // A retry whose note is the same text without the padding is one request:
    // the hash is over the normalised fields (§7.3).
    const replay = await logMeasurement(opened.harness, context, { ...input, note: "4.2 kg" });
    assert.equal(replay.kind, "replayed");
    assert.deepEqual(replay.measurement, first.measurement);
    assert.equal((await readGrowth(opened.harness, context)).measurements.length, 1, "a replay writes nothing");
    assert.equal((await activity(opened.harness)).length, 1);

    // Dropping the note is a different measurement, not a retry of the same one.
    const conflict = await logMeasurement(opened.harness, context, { ...input, note: undefined });
    assert.equal(conflict.kind, "key-conflict");

    // And an empty note *is* no note: the same request under a fresh key.
    const noNote = await logMeasurement(opened.harness, context, {
      actor: alex,
      actionId: "http:weigh-2",
      weightKg: 4.2,
      source: "ui",
      now: NOON,
    });
    assert.equal(noNote.kind, "logged");
    const paddedEmpty = await logMeasurement(opened.harness, context, {
      actor: alex,
      actionId: "http:weigh-2",
      weightKg: 4.2,
      note: "   ",
      source: "ui",
      now: NOON,
    });
    assert.equal(paddedEmpty.kind, "replayed");
  });
});

test("the local date is the household's, and an invalid measurement writes nothing", async () => {
  await withGrowthHarness(async (opened) => {
    // 23:30Z is already tomorrow in Paris: the day the household lived.
    const lateNight = new Date("2026-10-29T23:30:00.000Z");
    const logged = await logMeasurement(opened.harness, context, {
      actor: alex,
      actionId: "http:weigh-late",
      weightKg: 4.3,
      source: "ui",
      now: lateNight,
    });
    assert.equal(logged.kind, "logged");
    assert.equal(logged.measurement.localDate, "2026-10-30");

    const activityBefore = (await activity(opened.harness)).length;
    await assert.rejects(
      logMeasurement(opened.harness, context, {
        actor: alex,
        actionId: "http:weigh-bad",
        weightKg: Number.NaN,
        source: "ui",
        now: NOON,
      }),
      (error: unknown) => error instanceof DomainConflictError && error.message === MEASUREMENT_RULE,
    );
    assert.equal((await activity(opened.harness)).length, activityBefore, "a refused measurement writes nothing");
    assert.equal(
      ((await opened.harness.snapshot(CommandsDoc, context))?.entries ?? []).some(
        (entry) => entry.key === "http:weigh-bad",
      ),
      false,
      "a refused measurement does not burn the key",
    );
    assert.equal((await readGrowth(opened.harness, context)).measurements.length, 1);
  });
});

test("a caregiver the household does not carry writes as the household fallback", async () => {
  await withGrowthHarness(async (opened) => {
    const outcome = await logMeasurement(opened.harness, context, {
      actor: householdActor,
      actionId: "tool:task-1",
      weightKg: 4.4,
      source: "agent",
      now: NOON,
    });
    assert.equal(outcome.kind, "logged");
    assert.equal(outcome.measurement.byUserId, null);
    assert.equal(outcome.measurement.byLabel, "Household");
    assert.equal(outcome.measurement.source, "agent");
    assert.deepEqual(await activity(opened.harness), ["Household logged a weight of 4.4 kg"]);
  });
});

test("a missing growth document is unavailable, not an empty history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-growth-empty-"));
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite") });
  try {
    await assert.rejects(readGrowth(opened.harness, context), GrowthUnavailableError);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

// --- the target weight and bootstrap ---------------------------------------

test("the target weight stays on the puppy profile; growth never copies it", async () => {
  await withGrowthHarness(async (opened) => {
    const saved = await updatePuppyProfile(opened.harness, context, {
      actor: alex,
      actionId: "http:profile-1",
      rev: 0,
      patch: { targetWeightKg: 12.5 },
      now: NOON,
    });
    assert.equal(saved.kind, "updated");
    await logMeasurement(opened.harness, context, {
      actor: alex,
      actionId: "http:weigh-1",
      weightKg: 4.2,
      source: "ui",
      now: NOON,
    });

    const puppy = parsePuppy(await opened.harness.snapshot(PuppyDoc, context));
    assert.equal(puppy?.targetWeightKg, 12.5, "the profile keeps the target");
    const growth = await readGrowth(opened.harness, context);
    assert.equal("targetWeightKg" in growth, false, "one source of truth for the target");
    assert.equal(growth.measurements.length, 1);
  });
});

test("boot creates app.growth for a database that predates it and refuses a malformed one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-growth-boot-"));
  const path = join(dir, "pupkeep.sqlite");
  try {
    // A household that predates P3-01: boot repairs the missing document.
    const first = await openHarness({ path });
    try {
      await bootstrapSession(first.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => NOON,
      });
      await first.harness.commit(async (tx) => {
        await tx.retireDoc(GrowthDoc);
      }, context);
    } finally {
      await first.harness.close(context);
    }

    const second = await openHarness({ path });
    try {
      const boot = await bootstrapSession(second.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => NOON,
      });
      assert.equal(boot.created, false);
      assert.ok(boot.docsCreated.includes("app.growth"));
      assert.deepEqual((await readGrowth(second.harness, context)).measurements, []);

      // A malformed document must refuse boot, never be reset.
      await second.harness.commit(async (tx) => {
        const draft = await tx.doc(GrowthDoc);
        draft.measurements = [{ id: "x" } as never];
      }, context);
      await assert.rejects(
        bootstrapSession(second.harness, {
          config: { ...emptyConfig(), members: [owner] },
          context,
          timezone: "Europe/Paris",
          now: () => NOON,
        }),
        /app\.growth is not a shape/,
      );
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a household-less database carrying growth is refused, not reset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-growth-partial-"));
  const path = join(dir, "pupkeep.sqlite");
  try {
    const first = await openHarness({ path });
    try {
      await first.harness.commit(async (tx) => {
        Object.assign(await tx.doc(GrowthDoc), { ...emptyGrowth(), createdAt: NOON.toISOString() });
      }, context);
    } finally {
      await first.harness.close(context);
    }

    const second = await openHarness({ path });
    try {
      await assert.rejects(
        bootstrapSession(second.harness, {
          config: { ...emptyConfig(), members: [owner] },
          context,
          timezone: "Europe/Paris",
          now: () => NOON,
        }),
        /app\.household is missing but app\.growth exists/,
      );
      assert.deepEqual(
        await second.harness.snapshot(GrowthDoc, context),
        { ...emptyGrowth(), createdAt: NOON.toISOString() },
        "the document is left alone, not reset",
      );
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a measurement survives a reopen of the database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-growth-durable-"));
  const path = join(dir, "pupkeep.sqlite");
  try {
    const first = await openHarness({ path });
    try {
      await bootstrapSession(first.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => NOON,
      });
      await logMeasurement(first.harness, context, {
        actor: alex,
        actionId: "http:weigh-1",
        weightKg: 4.2,
        source: "ui",
        now: NOON,
        id: "measurement-1",
      });
    } finally {
      await first.harness.close(context);
    }

    const second = await openHarness({ path });
    try {
      const growth = await readGrowth(second.harness, context);
      assert.equal(growth.measurements.length, 1);
      assert.equal(growth.measurements[0]?.weightKg, 4.2);
      assert.equal(growth.measurements[0]?.byLabel, "Alex");
      assert.deepEqual(parseGrowth(growth), growth);
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
