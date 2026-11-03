// P2-06: `app.walks` and its service (PLAN §8.3, §7.3, §8.5, §9.2, §7.4).
//
// What is covered, in the order the code is layered:
//   * the shape: one open walk, server timestamps, the §9.2 pairing, the
//     observation bounds and the eight-hour stale predicate;
//   * the service over a real SQLite harness: start, end, replay, key conflict,
//     an already-open walk (and its stale form), ending nothing, and ending an
//     ended walk — each with one activity entry and no partial write;
//   * durability: a walk opened before a process restart is still open after it,
//     and can be ended by the other caregiver;
//   * bootstrap: a database that predates P2-06 gets `app.walks`, and a
//     malformed one refuses boot instead of being reset.

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
import { ActivityDoc, CommandsDoc, WalksDoc, emptyWalks, parseWalks } from "../src/server/domain/docs.ts";
import { DomainConflictError } from "../src/server/domain/errors.ts";
import { WalksUnavailableError, discardWalk, endWalk, readWalks, startWalk } from "../src/server/domain/walks.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import {
  WALK_OBSERVATION_RULE,
  WALK_STALE_AFTER_MS,
  openWalk,
  parseWalk,
  parseWalkList,
  parseWalkObservations,
  walkIsStale,
} from "../src/shared/walks.ts";
import type { Walk } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
const NOON = new Date("2026-10-29T12:00:00.000Z");
const HOUR = 3_600_000;

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "owner",
    role: "owner",
    displayName: "Alex",
    createdAt: "2026-10-29T10:00:00.000Z",
    sessions: [],
    ...overrides,
  };
}

const owner = member();
const partner = member({ id: "partner", role: "member", displayName: "Sam" });

const alex = async () => ({ id: "owner", label: "Alex" });
const sam = async () => ({ id: "partner", label: "Sam" });
const householdActor = async () => ({ id: null, label: "Household" });

function walk(overrides: Partial<Walk> = {}): Walk {
  return {
    id: "walk-1",
    startedAt: NOON.toISOString(),
    startedActionId: "http:start-1",
    startedBy: "owner",
    startedByLabel: "Alex",
    ...overrides,
  };
}

async function withWalksHarness(run: (opened: OpenedHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-walks-"));
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

test("a walk is a server-timestamped record, and only one walk can be open", () => {
  assert.deepEqual(parseWalk(walk()), walk());
  assert.equal(parseWalk({ ...walk(), extra: true }), undefined, "an unknown key is refused");
  assert.equal(parseWalk({ ...walk(), startedAt: "yesterday" }), undefined);
  assert.equal(
    parseWalk({ ...walk(), startedAt: NOON.toISOString(), endedAt: new Date(NOON.getTime() - HOUR).toISOString() }),
    undefined,
    "a walk cannot end before it starts",
  );
  // §9.2: no member id always travels with the household label (the writer
  // never pairs a real id with it; the parser, like the feed document's, only
  // refuses the impossible pairing).
  assert.equal(parseWalk({ ...walk(), startedBy: null, startedByLabel: "Alex" }), undefined);
  assert.ok(parseWalk(walk({ startedBy: null, startedByLabel: "Household" })));

  const ended = walk({
    id: "walk-2",
    endedAt: new Date(NOON.getTime() + HOUR).toISOString(),
    endActionId: "http:end-1",
    endedBy: "owner",
    endedByLabel: "Alex",
    pee: 1,
    poop: 0,
    dogsMet: "a beagle",
    mood: "happy",
    notes: "park loop",
  });
  assert.equal(parseWalk({ ...ended, notes: "  padded  " })?.notes, "padded", "observations are trimmed");
  assert.equal(parseWalk({ ...ended, pee: 21 }), undefined, "a typo of 21 is refused");
  assert.equal(parseWalk({ ...ended, mood: "x".repeat(41) }), undefined);
  assert.equal(parseWalk({ ...walk(), endActionId: "http:end-1" }), undefined, "an open walk carries no end fields");

  assert.deepEqual(parseWalkList([walk(), ended]), [walk(), ended]);
  // The shared opaque-id charset is enforced, not just the length.
  assert.equal(parseWalk({ ...walk(), id: "walk 1 with spaces" }), undefined);
  assert.equal(parseWalk({ ...walk(), startedActionId: "http:k\n1" }), undefined);

  assert.deepEqual(parseWalkObservations({ noteTypo: 1 }), undefined, "an unknown observation is refused, not dropped");
  assert.deepEqual(parseWalkObservations({ pee: 21 }), undefined);
  assert.deepEqual(parseWalkObservations({ notes: "two\nlines" }), undefined, "observations are one line");
  assert.deepEqual(parseWalkObservations({ dogsMet: "  a beagle  ", pee: 0 }), { dogsMet: "a beagle", pee: 0 });
  assert.deepEqual(parseWalkObservations(undefined), {}, "nothing noted is an empty observation, not invalid");

  assert.equal(parseWalkList([walk(), walk()]), undefined, "a repeated id is refused");
  assert.equal(
    parseWalkList([walk(), { ...walk({ id: "walk-2" }), endedAt: undefined }]),
    undefined,
    "two open walks are refused",
  );
});

test("a walk is stale after eight hours, and an ended walk never is", () => {
  const started = walk();
  assert.equal(walkIsStale(started, new Date(NOON.getTime() + WALK_STALE_AFTER_MS - 1)), false);
  assert.equal(walkIsStale(started, new Date(NOON.getTime() + WALK_STALE_AFTER_MS)), true);
  assert.equal(
    walkIsStale(
      { ...started, endedAt: new Date(NOON.getTime() + 2 * HOUR).toISOString() },
      new Date(NOON.getTime() + 20 * HOUR),
    ),
    false,
    "an ended walk is history, not a stale banner",
  );
  assert.deepEqual(
    openWalk([walk(), walk({ id: "walk-2", endedAt: new Date(NOON.getTime() + HOUR).toISOString() })]),
    walk(),
    "the open record is the one without an end",
  );
});

// --- the service ------------------------------------------------------------

test("starting a walk is one commit: the record, one activity entry, the key", async () => {
  await withWalksHarness(async ({ harness }) => {
    assert.deepEqual((await readWalks(harness, context)).walks, []);
    const outcome = await startWalk(harness, context, { actor: alex, actionId: "http:start-1", now: NOON });
    assert.equal(outcome.kind, "started");
    const started = outcome.kind === "started" ? outcome.walk : undefined;
    assert.ok(started);
    assert.equal(started.startedAt, NOON.toISOString(), "the server clock, never the device's");
    assert.equal(started.startedBy, "owner");
    assert.equal(started.startedByLabel, "Alex");
    assert.equal(started.endedAt, undefined);

    const walks = await readWalks(harness, context);
    assert.deepEqual(walks.walks, [started]);
    assert.deepEqual(await activity(harness), ["Alex started a walk"]);
    const commands = await harness.snapshot(CommandsDoc, context);
    assert.ok(commands?.entries.some((entry) => entry.key === "http:start-1"));
  });
});

test("a second start is refused with the open walk, and a stale one says so", async () => {
  await withWalksHarness(async ({ harness }) => {
    const first = await startWalk(harness, context, { actor: alex, actionId: "http:start-1", now: NOON });
    assert.equal(first.kind, "started");
    const open = first.kind === "started" ? first.walk : undefined;
    assert.ok(open);

    const second = await startWalk(harness, context, {
      actor: sam,
      actionId: "http:start-2",
      now: new Date(NOON.getTime() + 10 * 60_000),
    });
    assert.equal(second.kind, "open");
    assert.deepEqual(second.kind === "open" ? second.walk : undefined, open, "the caller can show the open walk");

    const stale = await startWalk(harness, context, {
      actor: sam,
      actionId: "http:start-3",
      now: new Date(NOON.getTime() + WALK_STALE_AFTER_MS + 1),
    });
    assert.equal(stale.kind, "stale", "past eight hours, the banner needs a resolution");
    assert.equal((await readWalks(harness, context)).walks.length, 1, "a refused start writes no second walk");
    assert.deepEqual(await activity(harness), ["Alex started a walk"], "and adds no activity");
  });
});

test("ending a walk records the caregiver's observations and a server duration", async () => {
  await withWalksHarness(async ({ harness }) => {
    const started = await startWalk(harness, context, { actor: alex, actionId: "http:start-1", now: NOON });
    assert.equal(started.kind, "started");
    const endedAt = new Date(NOON.getTime() + 35 * 60_000);
    const ended = await endWalk(harness, context, {
      actor: sam,
      actionId: "http:end-1",
      observations: { pee: 1, poop: 0, dogsMet: " a beagle ", mood: "happy", notes: " park loop " },
      now: endedAt,
    });
    assert.equal(ended.kind, "ended");
    const record = ended.kind === "ended" ? ended.walk : undefined;
    assert.ok(record);
    assert.equal(record.endedAt, endedAt.toISOString());
    assert.equal(record.endedBy, "partner");
    assert.equal(record.endedByLabel, "Sam");
    assert.equal(record.dogsMet, "a beagle");
    assert.equal(record.notes, "park loop");
    assert.equal(record.pee, 1);
    assert.equal(record.poop, 0);
    assert.deepEqual(parseWalks(await harness.snapshot(WalksDoc, context))?.walks, [record]);
    assert.deepEqual(await activity(harness), ["Alex started a walk", "Sam ended a walk (35 minutes)"]);
    assert.equal(openWalk((await readWalks(harness, context)).walks), undefined, "nothing is left open");
  });
});

test("a replay is success, and a different action cannot end an ended walk", async () => {
  await withWalksHarness(async ({ harness }) => {
    await startWalk(harness, context, { actor: alex, actionId: "http:start-1", now: NOON });
    const firstEnd = await endWalk(harness, context, {
      actor: alex,
      actionId: "http:end-1",
      observations: { mood: "happy" },
      now: new Date(NOON.getTime() + HOUR),
    });
    assert.equal(firstEnd.kind, "ended");

    const replay = await endWalk(harness, context, {
      actor: alex,
      actionId: "http:end-1",
      observations: { mood: "happy" },
      now: new Date(NOON.getTime() + 2 * HOUR),
    });
    assert.equal(replay.kind, "replayed", "a lost response replays instead of conflicting");
    assert.equal(replay.kind === "replayed" ? replay.walk.endedAt : undefined, firstEnd.kind === "ended" ? firstEnd.walk.endedAt : undefined);

    const walkId = firstEnd.kind === "ended" ? firstEnd.walk.id : "walk-1";
    const again = await endWalk(harness, context, {
      actor: sam,
      actionId: "http:end-2",
      walkId,
      now: new Date(NOON.getTime() + 3 * HOUR),
    });
    assert.equal(again.kind, "ended-already", "someone else's end is a conflict carrying the record");
    assert.equal(again.kind === "ended-already" ? again.walk.endedBy : undefined, "owner");

    // A retry of the same observations, spelled with padding and empty strings
    // instead of omitted fields, is the same request (§7.3).
    const normalised = await endWalk(harness, context, {
      actor: alex,
      actionId: "http:end-1",
      observations: { mood: "  happy  ", dogsMet: "", notes: "   " },
      now: new Date(NOON.getTime() + 2 * HOUR + 60_000),
    });
    assert.equal(normalised.kind, "replayed", "padding is not a different request");

    const conflict = await endWalk(harness, context, {
      actor: alex,
      actionId: "http:end-1",
      observations: { mood: "changed" },
      now: new Date(NOON.getTime() + 4 * HOUR),
    });
    assert.equal(conflict.kind, "key-conflict", "one key, one request");

    // With no id, a lost race (or a retry past the key's TTL) explains itself
    // with the record instead of "no open walk" (§7.3: who/when).
    // An explicit id that does not exist says so, rather than blaming the
    // absence of an open walk.
    const unknown = await endWalk(harness, context, { actor: sam, actionId: "http:end-9", walkId: "walk-nope", now: NOON });
    assert.equal(unknown.kind, "no-open");
    assert.equal(unknown.kind === "no-open" ? unknown.message : "", "there is no walk with that id");

    const nothing = await endWalk(harness, context, { actor: sam, actionId: "http:end-3", now: NOON });
    assert.equal(nothing.kind, "ended-already");
    assert.equal(nothing.kind === "ended-already" ? nothing.walk.endedBy : undefined, "owner");
    assert.match(nothing.kind === "ended-already" ? nothing.message : "", /"Alex" already ended this walk at/);
    assert.deepEqual(await activity(harness), ["Alex started a walk", "Alex ended a walk (60 minutes)"]);
  });
});

test("a nested or model-less start records the household actor with a null id", async () => {
  await withWalksHarness(async ({ harness }) => {
    const started = await startWalk(harness, context, { actor: householdActor, actionId: "tool:task-1", now: NOON });
    assert.equal(started.kind, "started");
    assert.equal(started.kind === "started" ? started.walk.startedBy : "x", null);
    assert.equal(started.kind === "started" ? started.walk.startedByLabel : "", "Household");
  });
});

// --- the document and boot --------------------------------------------------

test("a missing or malformed walk document is unavailable, not an empty walk", async () => {
  await withWalksHarness(async ({ harness }) => {
    const malformed = { schemaVersion: 2, createdAt: NOON.toISOString(), walks: [{ id: "walk-1" }] };
    await harness.commit(async (tx) => {
      Object.assign(await tx.doc(WalksDoc), malformed);
    }, context);
    await assert.rejects(readWalks(harness, context), WalksUnavailableError);
    // Boot is the real gate for a malformed document (asserted below); a reader
    // refuses it instead of answering "no walks".
  });
});

test("a walk survives a reopen of the database, and the other caregiver can end it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-walks-restart-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  try {
    const first = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
    let started: Walk;
    try {
      await bootstrapSession(first.harness, {
        config: { ...emptyConfig(), members: [owner, partner] },
        context,
        timezone: "Europe/Paris",
        now: () => NOON,
      });
      const outcome = await startWalk(first.harness, context, { actor: alex, actionId: "http:start-1", now: NOON });
      assert.equal(outcome.kind, "started");
      started = outcome.kind === "started" ? outcome.walk : (undefined as never);
    } finally {
      // A restart, not a kill drill: `close` is graceful, and the harness-level
      // kill matrix is P5-01's. What this pins is that the open walk lives in
      // the database rather than the process, which is the P2-06 durability
      // claim; the SIGKILL variant was verified by hand during review.
      await first.harness.close(context);
    }

    const second = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
    try {
      const reopened = await readWalks(second.harness, context);
      assert.deepEqual(reopened.walks, [started!], "the open walk survived the restart");
      const ended = await endWalk(second.harness, context, {
        actor: sam,
        actionId: "http:end-1",
        observations: { notes: "finished after restart" },
        now: new Date(NOON.getTime() + 20 * 60_000),
      });
      assert.equal(ended.kind, "ended", "the other caregiver can close it after the restart");
      assert.deepEqual(await activity(second.harness), ["Alex started a walk", "Sam ended a walk (20 minutes)"]);
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("boot creates app.walks for a database that predates it and refuses a malformed one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-walks-boot-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  try {
    const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
    try {
      const boot = await bootstrapSession(opened.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => NOON,
      });
      assert.ok(boot.docsCreated.includes("app.walks"));
      const walks = await opened.harness.snapshot(WalksDoc, context);
      assert.deepEqual(walks, { schemaVersion: 2, walks: [], createdAt: NOON.toISOString() });

      // A document that exists but does not parse must refuse boot, not reset.
      await opened.harness.commit(async (tx) => {
        Object.assign(await tx.doc(WalksDoc), { schemaVersion: 2, walks: [{ id: "walk-1" }], createdAt: NOON.toISOString() });
      }, context);
    } finally {
      await opened.harness.close(context);
    }

    const reopened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
    try {
      await assert.rejects(
        bootstrapSession(reopened.harness, {
          config: { ...emptyConfig(), members: [owner] },
          context,
          timezone: "Europe/Paris",
          now: () => NOON,
        }),
        /app\.walks is not a shape this build understands/,
      );
    } finally {
      await reopened.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an invalid observation is refused with the one rule, before any write", async () => {
  await withWalksHarness(async ({ harness }) => {
    await startWalk(harness, context, { actor: alex, actionId: "http:start-1", now: NOON });
    for (const observations of [{ pee: 21 }, { notes: "two\nlines" }, { dog: "a beagle" }, { mood: "x".repeat(41) }]) {
      await assert.rejects(
        endWalk(harness, context, { actor: sam, actionId: "http:end-bad", observations, now: NOON }),
        (error) => error instanceof DomainConflictError && error.message === WALK_OBSERVATION_RULE,
      );
    }
    assert.equal((await readWalks(harness, context)).walks[0]?.endedAt, undefined, "the walk is still open");
    assert.equal((await activity(harness)).length, 1, "and no activity was written");
  });
});

test("two caregivers acting at once still produce one walk and one end", async () => {
  await withWalksHarness(async ({ harness }) => {
    const [first, second] = await Promise.all([
      startWalk(harness, context, { actor: alex, actionId: "http:start-a", now: NOON }),
      startWalk(harness, context, { actor: sam, actionId: "http:start-b", now: NOON }),
    ]);
    const kinds = [first.kind, second.kind].sort();
    assert.deepEqual(kinds, ["open", "started"], "exactly one start wins");
    assert.equal((await readWalks(harness, context)).walks.length, 1, "one open walk, never two");

    const [end1, end2] = await Promise.all([
      endWalk(harness, context, {
        actor: alex,
        actionId: "http:end-a",
        observations: { mood: "happy" },
        now: new Date(NOON.getTime() + 30 * 60_000),
      }),
      endWalk(harness, context, {
        actor: sam,
        actionId: "http:end-b",
        observations: { mood: "tired" },
        now: new Date(NOON.getTime() + 30 * 60_000),
      }),
    ]);
    assert.deepEqual([end1.kind, end2.kind].sort(), ["ended", "ended-already"], "one end wins, one learns who");
    const loser = [end1, end2].find((outcome) => outcome.kind === "ended-already");
    assert.ok(loser && loser.kind === "ended-already");
    assert.match(loser.message, /already ended this walk at/, "the loser gets who/when, not silence");
  });
});

test("a start replayed after the other caregiver ended it returns the current record", async () => {
  await withWalksHarness(async ({ harness }) => {
    const started = await startWalk(harness, context, { actor: alex, actionId: "http:start-1", now: NOON });
    assert.equal(started.kind, "started");
    await endWalk(harness, context, { actor: sam, actionId: "http:end-1", now: new Date(NOON.getTime() + HOUR) });

    const replay = await startWalk(harness, context, { actor: alex, actionId: "http:start-1", now: NOON });
    assert.equal(replay.kind, "replayed", "a lost start response replays");
    assert.ok(replay.kind === "replayed" && replay.walk.endedAt, "and reports the walk as it is now, ended");
    assert.equal((await readWalks(harness, context)).walks.length, 1, "no second walk was appended");
  });
});

test("discarding a stale walk marks it instead of inventing a ten-hour end", async () => {
  await withWalksHarness(async ({ harness }) => {
    const started = await startWalk(harness, context, { actor: alex, actionId: "http:start-1", now: NOON });
    assert.equal(started.kind, "started");
    const walkId = started.kind === "started" ? started.walk.id : "walk-1";
    const later = new Date(NOON.getTime() + 9 * HOUR);

    const discarded = await discardWalk(harness, context, {
      actor: sam,
      actionId: "http:discard-1",
      walkId,
      now: later,
    });
    assert.equal(discarded.kind, "discarded");
    const record = discarded.kind === "discarded" ? discarded.walk : undefined;
    assert.ok(record?.discarded);
    assert.equal(record?.endedAt, later.toISOString());
    assert.equal(record?.endedByLabel, "Sam");
    assert.equal(record?.pee, undefined, "a discard carries no observations");

    const replay = await discardWalk(harness, context, {
      actor: sam,
      actionId: "http:discard-1",
      walkId,
      now: later,
    });
    assert.equal(replay.kind, "replayed");
    assert.deepEqual(await activity(harness), ["Alex started a walk", "Sam discarded a walk that was left open"]);
    assert.deepEqual(parseWalks(await harness.snapshot(WalksDoc, context))?.walks[0]?.discarded, true);
  });
});

test("the walk document migrates version 1 to version 2 without losing a record", async () => {
  const migrate = WalksDoc.definition.migrate;
  assert.ok(migrate, "the document declares its migration");
  const legacy = {
    schemaVersion: 1,
    createdAt: NOON.toISOString(),
    walks: [
      {
        id: "walk-1",
        startedAt: NOON.toISOString(),
        startedActionId: "http:start-1",
        startedBy: "owner",
        startedByLabel: "Alex",
      },
    ],
  };
  const migrated = migrate(legacy as never, 1);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.walks[0]?.id, "walk-1", "the open walk survives the upgrade");
  assert.equal(migrated.walks[0]?.discarded, undefined);
  assert.deepEqual(emptyWalks().schemaVersion, 2, "a fresh document starts at the current version");
});
