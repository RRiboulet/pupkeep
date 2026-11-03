// P2-07: the walk agent tools (PLAN §10.2, §10.3, §9.2, §8.5).
//
// Covers `start_walk`/`end_walk` as thin wrappers over the domain service: the
// task id as the action id, `replay: "safe"`, the speaker resolved from the
// thread (household fallback here) and cached after the commit, the committed
// truth in the answer, and the refusals the model must read (already-open,
// stale, already-ended, nothing open).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { SESSION_COOKIE, Auth, hashToken, newToken } from "../src/server/auth.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { createWalkTools } from "../src/server/agent/walk-tools.ts";
import { createProfileTools } from "../src/server/agent/tools.ts";
import { dataStores } from "../src/server/config.ts";
import { createLogger } from "../src/server/log.ts";
import { ActivityDoc, HouseholdDoc } from "../src/server/domain/docs.ts";
import { readWalks } from "../src/server/domain/walks.ts";

const context = BACKGROUND_CONTEXT;
const T0 = Date.parse("2026-10-30T08:00:00.000Z");

interface Fixture {
  dir: string;
  app: AppHandle;
  url: string;
  alexCookie: string;
  samCookie: string;
}

async function startWalkToolApp(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-walk-tools-"));
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] });
  faux.setResponses([() => fauxAssistantMessage("Done.")]);
  const models = createModels();
  models.setProvider(faux.provider);

  const stores = dataStores(dir);
  await stores.config.ensure();
  const samToken = newToken();
  const createdAt = "2026-10-29T10:00:00.000Z";
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  await stores.config.update((current) => ({
    ...current,
    members: [
      { id: "owner", role: "owner", displayName: "Alex", createdAt, sessions: [] },
      {
        id: "partner",
        role: "member",
        displayName: "Sam",
        createdAt,
        sessions: [{ tokenHash: hashToken(samToken), createdAt, expiresAt: expires }],
      },
    ],
  }));

  const result = await startApp(
    { dataDir: dir, host: "127.0.0.1", port: 0, models },
    { logger: createLogger({ scope: "test", sink: () => undefined }) },
  );
  assert.ok(result.ok, "the app must start");
  const auth = new Auth({ config: stores.config });
  const ownerToken = await auth.mintOwner("http://127.0.0.1").then((m) => m.token);
  const alexCookie = await auth.login(ownerToken).then((l) => l.token);
  return { dir, app: result.app, url: result.app.url, alexCookie, samCookie: samToken };
}

async function stop(fixture: Fixture): Promise<void> {
  await fixture.app.close();
  await rm(fixture.dir, { recursive: true, force: true });
}

function toolApi(
  fixture: Fixture,
  conversationId: number,
  taskId: string | number = "task-1",
  memos = new Map<string, unknown>(),
  nowMs = T0,
): ToolExecutionApi {
  const api = {
    taskId,
    conversationId: conversationId as ConversationId,
    now: () => nowMs,
    snapshot: (token: never, ctx: never) => fixture.app.app.snapshot(token, ctx),
    commit: (change: never, ctx: never) => fixture.app.app.commit(change, ctx),
    memo: async (name: string, candidateOrContext: unknown, maybeContext?: unknown) => {
      if (maybeContext === undefined) return memos.get(name);
      if (!memos.has(name)) memos.set(name, candidateOrContext);
      return memos.get(name);
    },
  };
  return api as unknown as ToolExecutionApi;
}

async function sharedConversationId(fixture: Fixture): Promise<number> {
  const household = await fixture.app.app.snapshot(HouseholdDoc, context);
  return household!.conversationId;
}

function tools() {
  const walk = createWalkTools().tools ?? [];
  const profile = createProfileTools().tools ?? [];
  return new Map([...walk, ...profile].map((tool) => [tool.name, tool]));
}

function resultText(result: { output?: unknown }): string {
  return (result.output as { text: string }[])[0]!.text;
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
    await stop(fixture);
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
    await stop(fixture);
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
    await stop(fixture);
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
    assert.match(after, /Not tracked by this build yet: growth/);
  } finally {
    await stop(fixture);
  }
});
