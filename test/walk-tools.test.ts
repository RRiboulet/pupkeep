// P2-07: the walk agent tools (PLAN §10.2, §10.3, §9.2, §8.5).
//
// Covers `start_walk`/`end_walk` as thin wrappers over the domain service: the
// task id as the action id, `replay: "safe"`, the speaker resolved from the
// thread (household fallback here) and cached after the commit, the committed
// truth in the answer, and the refusals the model must read (already-open,
// stale, already-ended, nothing open).

import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createWalkTools } from "../src/server/agent/walk-tools.ts";
import { createProfileTools } from "../src/server/agent/tools.ts";
import { ActivityDoc } from "../src/server/domain/docs.ts";
import { readWalks } from "../src/server/domain/walks.ts";
import {
  conversationIdOf as sharedConversationId,
  resultText,
  startTestApp,
  toolApi,
  type TestApp,
} from "./support/app.ts";

const context = BACKGROUND_CONTEXT;
const T0 = Date.parse("2026-10-30T08:00:00.000Z");

type Fixture = TestApp;

function startWalkToolApp(): Promise<Fixture> {
  return startTestApp({ prefix: "pupkeep-walk-tools-", now: T0 });
}

function tools() {
  const walk = createWalkTools().tools ?? [];
  const profile = createProfileTools().tools ?? [];
  return new Map([...walk, ...profile].map((tool) => [tool.name, tool]));
}

test("start_walk and end_walk commit through the thread with the speaker attributed", async () => {
  const fixture = await startWalkToolApp();
  try {
    const conversationId = await sharedConversationId(fixture);
    const start = tools().get("start_walk");
    const end = tools().get("end_walk");
    assert.ok(start && end);
    assert.equal(start.replay, "safe");
    assert.equal(end.replay, "safe");
    const memos = new Map<string, unknown>();

    const started = await start.execute({}, toolApi(fixture, conversationId, "task-start", memos), context);
    assert.equal(started.isError, undefined);
    assert.match(resultText(started), /^Started: a walk by "Household" at 08:00\./);
    const walks = await readWalks(fixture.app.app, context);
    assert.equal(walks.walks.length, 1);
    assert.equal(walks.walks[0]?.startedBy, null, "no chat entry: the household fallback");
    assert.equal(walks.walks[0]?.startedActionId, "tool:task-start");
    assert.deepEqual(memos.get("actor"), { id: null, label: "Household" });

    const replay = await start.execute({}, toolApi(fixture, conversationId, "task-start", memos), context);
    assert.match(resultText(replay), /^Already started\./);
    assert.equal((await readWalks(fixture.app.app, context)).walks.length, 1, "no second walk");

    const ended = await end.execute(
      { pee: 1, mood: "happy", notes: "park loop" },
      toolApi(fixture, conversationId, "task-end", memos, T0 + 35 * 60_000),
      context,
    );
    assert.equal(ended.isError, undefined);
    assert.match(resultText(ended), /^Ended: a walk by "Household" at 08:00, ended at 08:35 — 35 minutes \(1 pee, mood "happy", notes "park loop"\)\./);
    const closed = (await readWalks(fixture.app.app, context)).walks[0];
    assert.equal(closed?.endedAt, new Date(T0 + 35 * 60_000).toISOString());
    assert.equal(closed?.pee, 1);
    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.ok(activity?.entries.some((entry) => entry.summary === "Household ended a walk (35 minutes)"));

    const startReplay = await start.execute({}, toolApi(fixture, conversationId, "task-start", memos), context);
    assert.match(resultText(startReplay), /^Already started\. Ended:/, "a replay after the end reports the closed walk");

    const replayEnd = await end.execute(
      { pee: 1, mood: "happy", notes: "park loop" },
      toolApi(fixture, conversationId, "task-end", memos, T0 + 36 * 60_000),
      context,
    );
    assert.match(resultText(replayEnd), /^Already ended\./);
    const again = await end.execute({}, toolApi(fixture, conversationId, "task-end-2", memos, T0 + 40 * 60_000), context);
    assert.equal(again.isError, true);
    assert.match(resultText(again), /^Not ended: "Household" already ended this walk at/);
  } finally {
    await fixture.stop();
  }
});

test("a start on an open walk or a stale one is a refusal with the walk described", async () => {
  const fixture = await startWalkToolApp();
  try {
    const conversationId = await sharedConversationId(fixture);
    const start = tools().get("start_walk");
    assert.ok(start);
    await start.execute({}, toolApi(fixture, conversationId, "task-1"), context);

    const second = await start.execute({}, toolApi(fixture, conversationId, "task-2"), context);
    assert.equal(second.isError, true);
    assert.match(resultText(second), /^Not started: "Household" is already walking; end that walk before starting another\./);

    const stale = await start.execute(
      {},
      toolApi(fixture, conversationId, "task-3", new Map(), T0 + 9 * 60 * 60_000),
      context,
    );
    assert.equal(stale.isError, true);
    assert.match(resultText(stale), /has had a walk open for over 8 hours/);
    assert.equal((await readWalks(fixture.app.app, context)).walks.length, 1, "a refusal writes nothing");
  } finally {
    await fixture.stop();
  }
});

test("an invalid observation is refused with the rule, and nothing is ended", async () => {
  const fixture = await startWalkToolApp();
  try {
    const conversationId = await sharedConversationId(fixture);
    const start = tools().get("start_walk");
    const end = tools().get("end_walk");
    assert.ok(start && end);
    await start.execute({}, toolApi(fixture, conversationId, "task-1"), context);

    const invalid = await end.execute({ pee: 21 }, toolApi(fixture, conversationId, "task-bad"), context);
    assert.equal(invalid.isError, true);
    assert.match(resultText(invalid), /^Not ended: a walk's observations are optional/);
    assert.equal((await readWalks(fixture.app.app, context)).walks[0]?.endedAt, undefined);
  } finally {
    await fixture.stop();
  }
});

test("get_context reports the open walk and no longer lists walks as untracked", async () => {
  const fixture = await startWalkToolApp();
  try {
    const conversationId = await sharedConversationId(fixture);
    const getContext = tools().get("get_context");
    const start = tools().get("start_walk");
    assert.ok(getContext && start);

    const before = resultText(await getContext.execute({}, toolApi(fixture, conversationId), context));
    assert.match(before, /Walk: none open/);
    assert.doesNotMatch(before, /Not tracked by this build yet: [^\n]*walks/);

    await start.execute({}, toolApi(fixture, conversationId, "task-start"), context);
    const after = resultText(await getContext.execute({}, toolApi(fixture, conversationId), context));
    assert.match(after, /Walk: open, started by "Household" at 08:00 \(under a minute ago\)/);
    // Growth left that list with P3-03, showers with P3-07 and appointments
    // with P4-02; nothing is untracked any more, so the line is gone entirely.
    assert.doesNotMatch(after, /Not tracked by this build yet/);
    assert.match(after, /^Next appointment: none scheduled\.$/m);
  } finally {
    await fixture.stop();
  }
});
