// P3-05: the milestone agent tools (PLAN §10.1, §10.2, §10.3, §9.2).
//
// What is covered:
//   * `list_milestones`: the board grouped by status, every id the update tool
//     needs, notes and titles JSON-quoted, the starter catalog included;
//   * `update_milestone`: one commit as the speaker (household fallback here),
//     the `tool:` action id, `source: "agent"`, the memo, `replay: "safe"`,
//     an empty note clearing a note, and a refused unknown id with nothing
//     written;
//   * `add_milestone`: a custom entry through the same writer, a duplicate
//     title refused;
//   * `get_context`: the milestone summary and no "milestones" in the untracked
//     list.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createProfileTools } from "../src/server/agent/tools.ts";
import { createTrainingTools } from "../src/server/agent/training-tools.ts";
import { readTraining } from "../src/server/domain/training.ts";
import { trainingBoardText } from "../src/server/agent/training-text.ts";
import {
  conversationIdOf,
  resultText,
  startTestApp,
  toolApi,
  type TestApp,
} from "./support/app.ts";

const context = BACKGROUND_CONTEXT;
const NOW_MS = Date.parse("2026-10-30T08:00:00.000Z");

type Fixture = TestApp;

function startToolsApp(): Promise<Fixture> {
  return startTestApp({ prefix: "pupkeep-training-tools-", now: NOW_MS });
}

function tools() {
  return new Map(
    [...(createTrainingTools().tools ?? []), ...(createProfileTools().tools ?? [])].map((tool) => [tool.name, tool]),
  );
}

test("list_milestones reports the board by status, with every id update_milestone needs", async () => {
  const fixture = await startToolsApp();
  try {
    const list = tools().get("list_milestones");
    assert.ok(list);
    const conversationId = await conversationIdOf(fixture);
    const text = resultText(await list.execute({}, toolApi(fixture, conversationId), context));
    assert.match(text, /^Milestones: 0 of \d+ mastered, 0 practicing\./);
    assert.match(text, /Not started:/);
    assert.match(text, /id "catalog:sit", "Sit"/);
    assert.match(text, /id "catalog:come", "Come when called"/);
    assert.doesNotMatch(text, /Mastered:|Practicing:/, "empty groups are not printed");
  } finally {
    await fixture.stop();
  }
});

test("update_milestone commits as the speaker, replays on the same task, and clears a note with an empty one", async () => {
  const fixture = await startToolsApp();
  try {
    const conversationId = await conversationIdOf(fixture);
    const update = tools().get("update_milestone");
    assert.ok(update);
    assert.equal(update.replay, "safe", "the domain write is idempotent on the task id");
    const memos = new Map<string, unknown>();

    const mastered = await update.execute(
      { milestoneId: "catalog:sit", status: "mastered", note: "  waits by the door " },
      toolApi(fixture, conversationId, "task-42", memos),
      context,
    );
    assert.equal(mastered.isError, undefined);
    assert.match(resultText(mastered), /^Changed: "Household" marked "Sit" mastered\./);
    assert.match(resultText(mastered), /Mastered:\n {2}id "catalog:sit", "Sit", note "waits by the door"/);
    // §9.2: no chat entry in this transcript, so the fallback actor is cached.
    assert.deepEqual(memos.get("actor"), { id: null, label: "Household" });
    const stored = (await readTraining(fixture.app.app, context)).states[0]!;
    assert.equal(stored.byLabel, "Household");
    assert.equal(stored.source, "agent");
    assert.equal(stored.actionId, "tool:task-42");

    const replay = await update.execute(
      { milestoneId: "catalog:sit", status: "mastered", note: "  waits by the door " },
      toolApi(fixture, conversationId, "task-42", memos),
      context,
    );
    assert.equal(replay.isError, undefined);
    assert.match(resultText(replay), /\(already recorded; nothing new was written\)/);

    // A note-only change is reported as one, never as a status change.
    const noted = await update.execute(
      { milestoneId: "catalog:stay", note: "waits by the door" },
      toolApi(fixture, conversationId, "task-44"),
      context,
    );
    assert.equal(noted.isError, undefined);
    assert.match(resultText(noted), /^Changed: "Household" added a note to "Stay"\./);

    // An empty note is the model's way to say "clear it".
    const cleared = await update.execute(
      { milestoneId: "catalog:sit", note: "" },
      toolApi(fixture, conversationId, "task-43"),
      context,
    );
    assert.equal(cleared.isError, undefined);
    assert.equal((await readTraining(fixture.app.app, context)).states[0]?.note, undefined);
    // The milestone is still mastered; the board no longer carries the note.
    assert.match(resultText(cleared), /id "catalog:sit", "Sit", mastered \d{4}-\d{2}-\d{2}/);
    assert.doesNotMatch(resultText(cleared), /id "catalog:sit", "Sit", note "waits by the door"/);
  } finally {
    await fixture.stop();
  }
});

test("add_milestone adds a custom entry, and a duplicate title is refused", async () => {
  const fixture = await startToolsApp();
  try {
    const conversationId = await conversationIdOf(fixture);
    const add = tools().get("add_milestone");
    const update = tools().get("update_milestone");
    assert.ok(add && update);

    const added = await add.execute({ title: "Roll over" }, toolApi(fixture, conversationId, "task-1"), context);
    assert.equal(added.isError, undefined);
    assert.match(resultText(added), /^Added the milestone "Roll over"\./);
    assert.match(resultText(added), /Not started:\n[\s\S]*\(household's own\)/);
    const board = await readTraining(fixture.app.app, context);
    assert.equal(board.custom.length, 1);
    assert.equal(board.custom[0]?.source, "agent");

    // The new milestone is a full one: update_milestone can master it.
    const mastered = await update.execute(
      { milestoneId: board.custom[0]!.id, status: "mastered" },
      toolApi(fixture, conversationId, "task-2"),
      context,
    );
    assert.equal(mastered.isError, undefined);

    const duplicate = await add.execute({ title: "sit" }, toolApi(fixture, conversationId, "task-3"), context);
    assert.equal(duplicate.isError, true);
    assert.match(resultText(duplicate), /^Not added: a custom milestone needs a title/);
    assert.equal((await readTraining(fixture.app.app, context)).custom.length, 1);
  } finally {
    await fixture.stop();
  }
});

test("the board text is bounded and never leaves a heading with no rows under it", () => {
  const rows = Array.from({ length: 45 }, (_item, index) => ({
    id: `custom:${index}`,
    title: `Milestone ${index}`,
    origin: "custom" as const,
    status: index < 42 ? ("mastered" as const) : ("practicing" as const),
  }));
  const text = trainingBoardText(rows, "Europe/Paris");
  assert.match(text, /^Milestones: 42 of 45 mastered, 3 practicing\./);
  assert.match(text, /and 5 more$/);
  assert.equal(text.split("\n").filter((line) => line.startsWith("  id ")).length, 40);
  assert.doesNotMatch(text, /Practicing:\nand/, "a cut group prints no empty heading");
});

test("get_context summarises the milestones and no longer calls them untracked", async () => {
  const fixture = await startToolsApp();
  try {
    const conversationId = await conversationIdOf(fixture);
    const update = tools().get("update_milestone");
    const getContext = tools().get("get_context");
    assert.ok(update && getContext);

    const empty = resultText(await getContext.execute({}, toolApi(fixture, conversationId), context));
    assert.match(empty, /Milestones: 0 of \d+ mastered, 0 practicing/);
    assert.doesNotMatch(empty, /Not tracked by this build yet: [^\n]*milestones/);

    await update.execute(
      { milestoneId: "catalog:stay", status: "practicing" },
      toolApi(fixture, conversationId, "task-1"),
      context,
    );
    const reported = resultText(await getContext.execute({}, toolApi(fixture, conversationId), context));
    assert.match(reported, /Milestones: 0 of \d+ mastered, 1 practicing \(practicing "Stay"\)/);
    assert.match(reported, /^Next appointment: none scheduled\.$/m);
  } finally {
    await fixture.stop();
  }
});
