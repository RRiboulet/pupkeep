// P3-04: `app.training` and its service (PLAN §8.1, §7.3, §7.4, §9.2, §16 P3-04).
//
// What is covered:
//   * the catalog: stable `catalog:` ids, unique titles, and a checklist that
//     carries no advice or schedule — the task's guardrail is a test;
//   * the shapes: `masteredAt` iff mastered, the §9.2 pairing, note bounds,
//     prefix discipline (a catalog id for a catalog state, `custom:<uuid>` for
//     a custom one), and a retired catalog state that stays in the document
//     instead of failing boot;
//   * the board (`milestoneView`): catalog order, untouched = not_started,
//     custom after catalog, retired ids not shown;
//   * the service: one commit per change (state + activity + key), status
//     transitions with who/when, mastery and its undo as a real commit, notes
//     set/cleared/kept, custom milestones with a unique title, replay, key
//     conflict, the household fallback actor and no write on a refusal;
//   * bootstrap and durability: a database that predates P3-04 is repaired, a
//     malformed one is refused, and the board survives a reopen.

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
  TrainingDoc,
  emptyTraining,
  parseTraining,
} from "../src/server/domain/docs.ts";
import {
  MilestoneUnknownError,
  TrainingUnavailableError,
  addCustomMilestone,
  readTraining,
  readTrainingView,
  updateMilestone,
} from "../src/server/domain/training.ts";
import { watchProfileState } from "../src/server/agent/state.ts";
import { createLogger } from "../src/server/log.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import {
  MILESTONE_CATALOG,
  MILESTONE_NOOP_RULE,
  MILESTONE_RULE,
  MILESTONE_TITLE_RULE,
  catalogEntry,
  milestoneView,
  parseCustomMilestone,
  parseMilestoneState,
  parseTrainingList,
} from "../src/shared/training.ts";
import type { MilestoneState, Training } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
const NOON = new Date("2026-10-29T12:00:00.000Z");
const SIT = "catalog:sit";

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
const householdActor = async () => ({ id: null, label: "Household" });

function state(overrides: Partial<MilestoneState> = {}): MilestoneState {
  return {
    id: SIT,
    status: "practicing",
    updatedAt: NOON.toISOString(),
    byUserId: "owner",
    byLabel: "Alex",
    actionId: "http:m-1",
    source: "ui",
    ...overrides,
  };
}

function training(overrides: Partial<Training> = {}): Training {
  return { ...emptyTraining(), createdAt: NOON.toISOString(), ...overrides };
}

async function withTrainingHarness(run: (opened: OpenedHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-training-"));
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
  return ((await harness.snapshot(ActivityDoc, context))?.entries ?? [])
    .filter((entry) => entry.kind === "training.milestone")
    .map((entry) => entry.summary);
}

// --- the catalog and the shapes --------------------------------------------

test("the catalog is a stable checklist, not a curriculum", () => {
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const entry of MILESTONE_CATALOG) {
    assert.match(entry.id, /^catalog:[a-z0-9-]+$/, `${entry.id} is a stable catalog id`);
    assert.ok(!ids.has(entry.id), `${entry.id} is unique`);
    assert.ok(!titles.has(entry.title.trim().toLowerCase()), `${entry.title} is unique`);
    ids.add(entry.id);
    titles.add(entry.title.trim().toLowerCase());
    assert.equal(catalogEntry(entry.id)?.title, entry.title);
  }
  assert.equal(catalogEntry("catalog:nope"), undefined);
  // The guardrail: no schedule, no age, no "should", no advice.
  for (const entry of MILESTONE_CATALOG) {
    assert.doesNotMatch(entry.title, /should|must|by \d|weeks?|months?|always|never|advice|train/i);
  }
});

test("a state is masteredAt iff mastered, and the §9.2 pairing is fenced", () => {
  assert.deepEqual(parseMilestoneState(state()), state());
  assert.deepEqual(parseMilestoneState(state({ note: "  waits at the door  " })), {
    ...state(),
    note: "waits at the door",
  });
  const mastered = state({
    status: "mastered",
    masteredAt: NOON.toISOString(),
  });
  assert.deepEqual(parseMilestoneState(mastered), mastered);

  assert.equal(parseMilestoneState({ ...state(), extra: true }), undefined);
  assert.equal(parseMilestoneState({ ...state(), status: "done" }), undefined);
  assert.equal(parseMilestoneState({ ...state(), id: "" }), undefined);
  assert.equal(parseMilestoneState({ ...state(), updatedAt: "yesterday" }), undefined);
  assert.equal(parseMilestoneState({ ...state(), actionId: "http:m 1" }), undefined);
  // `masteredAt` may not exist outside `mastered`, nor be missing inside it.
  assert.equal(parseMilestoneState({ ...mastered, status: "practicing" }), undefined);
  assert.equal(parseMilestoneState({ ...mastered, masteredAt: undefined }), undefined);
  assert.equal(parseMilestoneState({ ...state(), note: "two\nlines" }), undefined);
  assert.equal(parseMilestoneState({ ...state(), note: "x".repeat(281) }), undefined);
  // §9.2: no id always travels with the household label.
  assert.equal(parseMilestoneState({ ...state(), byUserId: null }), undefined);
  assert.ok(parseMilestoneState({ ...state(), byUserId: null, byLabel: "Household" }));
});

test("a custom milestone is custom-prefixed and titled, and states must be backed", () => {
  const custom = {
    id: "custom:8f1c0c2a-0000-4000-8000-000000000001",
    title: "Roll over",
    createdAt: NOON.toISOString(),
    byUserId: "owner",
    byLabel: "Alex",
    actionId: "http:c-1",
    source: "ui",
  };
  assert.deepEqual(parseCustomMilestone(custom), custom);
  assert.equal(parseCustomMilestone({ ...custom, id: "catalog:roll-over" }), undefined, "custom ids are custom-prefixed");
  assert.equal(parseCustomMilestone({ ...custom, title: "  " }), undefined);
  assert.equal(parseCustomMilestone({ ...custom, title: "x".repeat(61) }), undefined);
  assert.equal(parseCustomMilestone({ ...custom, title: "roll\nover" }), undefined);
  assert.equal(parseCustomMilestone({ ...custom, extra: true }), undefined);
  assert.equal(parseCustomMilestone({ ...custom, source: "email" }), undefined);

  assert.deepEqual(parseTrainingList({ states: [], custom: [custom] }), { states: [], custom: [custom] });
  // A custom state must have its entry; a retired catalog state is kept.
  assert.equal(
    parseTrainingList({ states: [state({ id: custom.id })], custom: [] }),
    undefined,
    "a custom state without its milestone is a bug",
  );
  const retired = state({ id: "catalog:retired-skill" });
  assert.deepEqual(parseTrainingList({ states: [retired], custom: [] }), { states: [retired], custom: [] });
  // A bare (unprefixed) id is neither.
  assert.equal(parseTrainingList({ states: [state({ id: "sit" })], custom: [] }), undefined);
  // Duplicate ids and titles are refused, including a title the catalog owns.
  assert.equal(parseTrainingList({ states: [state(), state()], custom: [] }), undefined);
  // The *parser* only enforces custom-title uniqueness: a custom titled like a
  // catalog entry is refused at write time, so a future build that ships that
  // title cannot turn a legal document into a boot failure (the board would show
  // both rows, and the service never creates that pair).
  const sitCustom = { ...custom, title: "sit", id: "custom:2" };
  assert.equal(parseTrainingList({ states: [], custom: [sitCustom] })?.custom.length, 1);
  const other = { ...custom, id: "custom:2", title: "Spin" };
  assert.equal(parseTrainingList({ states: [], custom: [custom, other] })?.custom.length, 2, "two distinct customs are fine");
  assert.equal(parseTrainingList({ states: [], custom: [custom, { ...other, id: custom.id }] }), undefined);
  assert.equal(
    parseTrainingList({ states: [], custom: [custom, { ...other, title: "  roll over " }] }),
    undefined,
    "titles are unique case-insensitively",
  );
});

test("the board is the catalog in order, untouched as not_started, custom last", () => {
  const board = milestoneView(
    training({
      states: [state({ id: "catalog:stay", status: "mastered", masteredAt: NOON.toISOString() })],
      custom: [
        {
          id: "custom:roll",
          title: "Roll over",
          createdAt: NOON.toISOString(),
          byUserId: "owner",
          byLabel: "Alex",
          actionId: "http:c-1",
          source: "ui",
        },
      ],
    }),
  );
  assert.deepEqual(
    board.map((row) => row.id),
    [...MILESTONE_CATALOG.map((entry) => entry.id), "custom:roll"],
  );
  assert.equal(board.find((row) => row.id === "catalog:sit")?.status, "not_started", "untouched reads as not started");
  const stay = board.find((row) => row.id === "catalog:stay");
  assert.equal(stay?.status, "mastered");
  assert.equal(stay?.masteredAt, NOON.toISOString());
  assert.equal(board.find((row) => row.id === "custom:roll")?.title, "Roll over");
  assert.equal(board.find((row) => row.id === "custom:roll")?.status, "not_started");

  // A retired catalog state is not on the board: there is no title to show.
  const retired = milestoneView(training({ states: [state({ id: "catalog:retired-skill" })] }));
  assert.equal(retired.length, MILESTONE_CATALOG.length);

});

test("an unknown schemaVersion and a malformed board fail boot rather than reset", () => {
  assert.deepEqual(parseTraining(training()), training());
  assert.equal(parseTraining({ ...training(), schemaVersion: 2 }), undefined);
  assert.equal(parseTraining({ ...training(), createdAt: "yesterday" }), undefined);
  assert.equal(parseTraining({ ...training(), states: [{ id: "x" }] }), undefined);
  assert.deepEqual(emptyTraining(), { schemaVersion: 1, states: [], custom: [], createdAt: "" });
});

// --- the service -----------------------------------------------------------

test("a status change is one commit: the state, one activity line and the key", async () => {
  await withTrainingHarness(async (opened) => {
    const outcome = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-1",
      milestoneId: SIT,
      status: "mastered",
      source: "ui",
      now: NOON,
    });
    assert.equal(outcome.kind, "updated");
    assert.deepEqual(outcome.state, {
      id: SIT,
      status: "mastered",
      updatedAt: NOON.toISOString(),
      byUserId: "owner",
      byLabel: "Alex",
      actionId: "http:m-1",
      source: "ui",
      masteredAt: NOON.toISOString(),
    });
    assert.deepEqual((await readTraining(opened.harness, context)).states, [outcome.state]);
    assert.deepEqual(await activity(opened.harness), ['Alex marked "Sit" mastered']);
    const commands = (await opened.harness.snapshot(CommandsDoc, context))?.entries ?? [];
    assert.deepEqual(commands.map((entry) => entry.key), ["http:m-1"]);
  });
});

test("practicing, mastery and its undo are three real commits with who and when", async () => {
  await withTrainingHarness(async (opened) => {
    const start = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-1",
      milestoneId: SIT,
      status: "practicing",
      source: "ui",
      now: NOON,
    });
    assert.equal(start.kind, "updated");
    assert.equal(start.state.masteredAt, undefined, "practicing is not mastered");

    const later = new Date(NOON.getTime() + 60_000);
    const done = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-2",
      milestoneId: SIT,
      status: "mastered",
      source: "ui",
      now: later,
    });
    assert.equal(done.kind, "updated");
    assert.equal(done.state.masteredAt, later.toISOString());

    const undo = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-3",
      milestoneId: SIT,
      status: "practicing",
      source: "ui",
      now: later,
    });
    assert.equal(undo.kind, "updated");
    assert.equal(undo.state.masteredAt, undefined, "an undo leaves no 'done at' behind");
    assert.equal((await readTraining(opened.harness, context)).states.length, 1, "one state per milestone");
    assert.deepEqual(await activity(opened.harness), [
      'Alex started practicing "Sit"',
      'Alex marked "Sit" mastered',
      'Alex started practicing "Sit"',
    ]);
  });
});

test("a note is set, kept across a status change, and cleared as its own commit", async () => {
  await withTrainingHarness(async (opened) => {
    const noted = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-1",
      milestoneId: SIT,
      note: "  waits by the door ",
      source: "ui",
      now: NOON,
    });
    assert.equal(noted.kind, "updated");
    assert.equal(noted.state.status, "not_started", "a note-only edit is not a status change");
    assert.equal(noted.state.note, "waits by the door");
    // Further commits keep the note.
    const advanced = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-2",
      milestoneId: SIT,
      status: "practicing",
      source: "ui",
      now: NOON,
    });
    assert.equal(advanced.kind, "updated");
    if (advanced.kind === "updated") {
      assert.equal(advanced.state.note, "waits by the door", "an absent note keeps what is there");
    }
    const cleared = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-3",
      milestoneId: SIT,
      note: null,
      source: "ui",
      now: NOON,
    });
    assert.equal(cleared.kind, "updated");
    assert.equal(cleared.state.note, undefined);
    assert.deepEqual(await activity(opened.harness), [
      'Alex added a note to "Sit"',
      'Alex started practicing "Sit"',
      'Alex cleared the note on "Sit"',
    ]);
  });
});

test("a call that changes nothing is refused, and a re-assert is not", async () => {
  await withTrainingHarness(async (opened) => {
    // A clear on a milestone with no note changes nothing: no state, no line.
    await assert.rejects(
      updateMilestone(opened.harness, context, {
        actor: alex,
        actionId: "http:m-clear",
        milestoneId: SIT,
        note: null,
        source: "ui",
        now: NOON,
      }),
      (error: unknown) => error instanceof Error && error.message === MILESTONE_NOOP_RULE,
    );
    assert.deepEqual((await readTraining(opened.harness, context)).states, []);
    assert.deepEqual(await activity(opened.harness), []);

    // An explicit status re-assert *is* an action (it restamps who/when), and
    // its sentence is the status, never a note edit.
    await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-1",
      milestoneId: SIT,
      status: "mastered",
      source: "ui",
      now: NOON,
    });
    await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-2",
      milestoneId: SIT,
      status: "mastered",
      source: "ui",
      now: NOON,
    });
    assert.deepEqual(await activity(opened.harness), ['Alex marked "Sit" mastered', 'Alex marked "Sit" mastered']);
  });
});

test("a write on a document whose createdAt is empty repairs it instead of bricking boot", async () => {
  await withTrainingHarness(async (opened) => {
    // Simulate a partial restore: the document exists but carries the initial
    // empty timestamp a boot-less write would leave.
    await opened.harness.commit(async (tx) => {
      const draft = await tx.doc(TrainingDoc);
      draft.createdAt = "";
    }, context);
    const outcome = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-1",
      milestoneId: SIT,
      status: "practicing",
      source: "ui",
      now: NOON,
    });
    assert.equal(outcome.kind, "updated");
    const stored = await readTraining(opened.harness, context);
    assert.equal(stored.createdAt, NOON.toISOString(), "the writer seeded the timestamp");
    assert.deepEqual(parseTraining(stored), stored, "the document parses, so the next boot is safe");
  });
});

test("re-marking a mastered milestone keeps the first mastery instant", async () => {
  await withTrainingHarness(async (opened) => {
    const first = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-1",
      milestoneId: SIT,
      status: "mastered",
      source: "ui",
      now: NOON,
    });
    assert.equal(first.kind, "updated");
    const later = new Date(NOON.getTime() + 86_400_000);
    const again = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-2",
      milestoneId: SIT,
      status: "mastered",
      source: "ui",
      now: later,
    });
    assert.equal(again.kind, "updated");
    if (again.kind !== "updated") return;
    // "Mastered at" is when it was mastered; `updatedAt` is the last change.
    assert.equal(again.state.masteredAt, NOON.toISOString());
    assert.equal(again.state.updatedAt, later.toISOString());
    assert.equal((await activity(opened.harness)).length, 2, "the repeat is still an explicit action");
  });
});

test("the board view is one builder, and a milestone change publishes the care signal", async () => {
  await withTrainingHarness(async (opened) => {
    const empty = await readTrainingView(opened.harness, context);
    assert.equal(empty.length, MILESTONE_CATALOG.length);
    assert.equal(empty[0]?.origin, "catalog");
    assert.equal(empty[0]?.status, "not_started");

    const frames: unknown[] = [];
    const watch = watchProfileState({
      harness: opened.harness,
      context,
      bus: { publishState: (profile: unknown) => frames.push(profile) },
      logger: createLogger({ scope: "test", sink: () => undefined }),
      now: () => NOON,
    });
    try {
      await updateMilestone(opened.harness, context, {
        actor: alex,
        actionId: "http:m-1",
        milestoneId: SIT,
        status: "mastered",
        source: "ui",
        now: NOON,
      });
      const deadline = Date.now() + 2000;
      while (frames.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(frames.length > 0, "app.training is one of the documents behind the care frame");
      // The frame is a signal, not data (P2-05): the board re-reads its own route.
      assert.equal("training" in (frames.at(-1) as Record<string, unknown>), false);
    } finally {
      watch.stop();
    }

    const board = await readTrainingView(opened.harness, context);
    assert.equal(board.find((row) => row.id === SIT)?.status, "mastered");
    assert.equal(board.find((row) => row.id === SIT)?.byLabel, "Alex");
  });
});

test("an unknown milestone is refused with a sentence and writes nothing", async () => {
  await withTrainingHarness(async (opened) => {
    await assert.rejects(
      updateMilestone(opened.harness, context, {
        actor: alex,
        actionId: "http:m-bad",
        milestoneId: "catalog:nope",
        status: "mastered",
        source: "ui",
      now: NOON,
      }),
      MilestoneUnknownError,
    );
    assert.deepEqual((await readTraining(opened.harness, context)).states, []);
    assert.deepEqual(await activity(opened.harness), []);
    assert.deepEqual((await opened.harness.snapshot(CommandsDoc, context))?.entries, [], "the key is not burnt");
  });
});

test("an empty change is refused, and a replay returns the recorded state", async () => {
  await withTrainingHarness(async (opened) => {
    await assert.rejects(
      updateMilestone(opened.harness, context, {
        actor: alex,
        actionId: "http:m-empty",
        milestoneId: SIT,
        source: "ui",
      now: NOON,
      }),
      (error: unknown) => error instanceof Error && error.message === MILESTONE_NOOP_RULE,
    );

    const first = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-1",
      milestoneId: SIT,
      status: "mastered",
      source: "ui",
      now: NOON,
    });
    assert.equal(first.kind, "updated");
    const replay = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-1",
      milestoneId: SIT,
      status: "mastered",
      source: "ui",
      now: NOON,
    });
    assert.equal(replay.kind, "replayed");
    if (replay.kind === "replayed" && first.kind === "updated") assert.deepEqual(replay.state, first.state);
    assert.equal((await activity(opened.harness)).length, 1, "a replay writes nothing");

    const conflict = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-1",
      milestoneId: SIT,
      status: "practicing",
      source: "ui",
      now: NOON,
    });
    assert.equal(conflict.kind, "key-conflict");
  });
});

test("a custom milestone is added once, attributed, and joins the board", async () => {
  await withTrainingHarness(async (opened) => {
    const added = await addCustomMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:c-1",
      title: "Roll over",
      id: "custom:roll",
      source: "ui",
      now: NOON,
    });
    assert.equal(added.kind, "added");
    assert.equal(added.milestone.id, "custom:roll");
    assert.equal(added.milestone.byLabel, "Alex");
    assert.deepEqual(await activity(opened.harness), ['Alex added the milestone "Roll over"']);
    const board = milestoneView(await readTraining(opened.harness, context));
    assert.equal(board.at(-1)?.id, "custom:roll");
    assert.equal(board.at(-1)?.status, "not_started");

    // It is a full milestone: it can be practised and mastered.
    const done = await updateMilestone(opened.harness, context, {
      actor: alex,
      actionId: "http:m-1",
      milestoneId: "custom:roll",
      status: "mastered",
      source: "ui",
      now: NOON,
    });
    assert.equal(done.kind, "updated");
    assert.equal(done.state.id, "custom:roll");

    // A duplicate title is refused (case-insensitive), with nothing written.
    await assert.rejects(
      addCustomMilestone(opened.harness, context, {
        actor: alex,
        actionId: "http:c-2",
        title: "  ROLL OVER ",
        source: "ui",
        now: NOON,
      }),
      (error: unknown) => error instanceof Error && error.message === MILESTONE_TITLE_RULE,
    );
    await assert.rejects(
      addCustomMilestone(opened.harness, context, {
        actor: alex,
        actionId: "http:c-3",
        title: "sit",
        source: "ui",
      now: NOON,
      }),
      (error: unknown) => error instanceof Error && error.message === MILESTONE_TITLE_RULE,
    );
    assert.equal((await readTraining(opened.harness, context)).custom.length, 1);
    const commands = (await opened.harness.snapshot(CommandsDoc, context))?.entries ?? [];
    const keys = commands.map((entry) => entry.key);
    assert.ok(keys.includes("http:c-1"));
    assert.equal(keys.includes("http:c-2"), false, "a refused duplicate does not burn its key");
    assert.equal(keys.includes("http:c-3"), false);
  });
});

test("a caregiver the household does not carry writes as the household fallback", async () => {
  await withTrainingHarness(async (opened) => {
    const outcome = await updateMilestone(opened.harness, context, {
      actor: householdActor,
      actionId: "tool:task-1",
      milestoneId: SIT,
      status: "practicing",
      source: "agent",
      now: NOON,
    });
    assert.equal(outcome.kind, "updated");
    assert.equal(outcome.state.byUserId, null);
    assert.equal(outcome.state.byLabel, "Household");
    assert.deepEqual(await activity(opened.harness), ['Household started practicing "Sit"']);
  });
});

test("a missing training document is unavailable, not an empty board", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-training-empty-"));
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite") });
  try {
    await assert.rejects(readTraining(opened.harness, context), TrainingUnavailableError);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

// --- bootstrap and durability ---------------------------------------------

test("boot repairs a pre-P3-04 database and refuses a malformed board", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-training-boot-"));
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
      await first.harness.commit(async (tx) => {
        await tx.retireDoc(TrainingDoc);
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
      assert.ok(boot.docsCreated.includes("app.training"));
      assert.deepEqual((await readTraining(second.harness, context)).states, []);

      await second.harness.commit(async (tx) => {
        const draft = await tx.doc(TrainingDoc);
        draft.states = [{ id: "x" } as never];
      }, context);
      await assert.rejects(
        bootstrapSession(second.harness, {
          config: { ...emptyConfig(), members: [owner] },
          context,
          timezone: "Europe/Paris",
          now: () => NOON,
        }),
        /app\.training is not a shape/,
      );
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the board survives a reopen of the database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-training-durable-"));
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
      await updateMilestone(first.harness, context, {
        actor: alex,
        actionId: "http:m-1",
        milestoneId: SIT,
        status: "mastered",
        source: "ui",
      now: NOON,
      });
      await addCustomMilestone(first.harness, context, {
        actor: alex,
        actionId: "http:c-1",
        title: "Roll over",
        source: "ui",
      now: NOON,
      });
    } finally {
      await first.harness.close(context);
    }

    const second = await openHarness({ path });
    try {
      const restored = await readTraining(second.harness, context);
      assert.equal(restored.states.length, 1);
      assert.equal(restored.states[0]?.status, "mastered");
      assert.equal(restored.custom.length, 1);
      assert.equal(restored.custom[0]?.title, "Roll over");
      assert.deepEqual(parseTraining(restored), restored);
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
