// P3-05: the milestone HTTP surface (PLAN §7.3, §7.4, §9.4, §14.2, §16 P3-05).
//
// What is covered:
//   * GET /api/training: the committed board, `no-store`, a session;
//   * POST /api/training/milestone: a status change and a note change in one
//     idempotent commit, the committed board in the answer, replay, key
//     conflict, the unknown-milestone 409 carrying the board, and the one
//     no-op refusal;
//   * POST /api/training/custom: a new milestone, a duplicate title refused;
//   * the shared mutation guards (session, origin, request header, JSON, key);
//   * Gate G3's line: the UI route and the agent tool produce the same domain
//     result and read the same board.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SESSION_COOKIE, Auth } from "../src/server/auth.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { dataStores } from "../src/server/config.ts";
import { readTraining, readTrainingView } from "../src/server/domain/training.ts";
import { HouseholdDoc } from "../src/server/domain/docs.ts";
import { createTrainingTools } from "../src/server/agent/training-tools.ts";
import { createLogger } from "../src/server/log.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { MILESTONE_NOOP_RULE, MILESTONE_TITLE_RULE, type MilestoneView } from "../src/shared/training.ts";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Household } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;

const T0 = new Date("2026-10-30T08:00:00.000Z");

interface Fixture {
  dir: string;
  app: AppHandle;
  url: string;
  alexCookie: string;
}

async function startTrainingApp(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-training-routes-"));
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const stores = dataStores(dir);
  await stores.config.ensure();
  const createdAt = "2026-10-29T10:00:00.000Z";
  await stores.config.update((current) => ({
    ...current,
    members: [{ id: "owner", role: "owner", displayName: "Alex", createdAt, sessions: [] }],
  }));

  const result = await startApp(
    { dataDir: dir, host: "127.0.0.1", port: 0, models, now: () => T0.getTime() },
    { logger: createLogger({ scope: "test", sink: () => undefined }) },
  );
  assert.ok(result.ok, "the app must start");
  const auth = new Auth({ config: stores.config });
  const ownerToken = await auth.mintOwner("http://127.0.0.1").then((m) => m.token);
  const alexCookie = await auth.login(ownerToken).then((l) => l.token);
  return { dir, app: result.app, url: result.app.url, alexCookie };
}

async function stop(fixture: Fixture): Promise<void> {
  await fixture.app.close();
  await rm(fixture.dir, { recursive: true, force: true });
}

interface MutateOptions {
  body?: Record<string, unknown>;
  key?: string;
  omitOrigin?: boolean;
  omitHeader?: boolean;
  omitKey?: boolean;
  contentType?: string;
}

async function post(fixture: Fixture, path: string, token: string, options: MutateOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": options.contentType ?? "application/json",
    ...(options.omitHeader ? {} : { [REQUEST_HEADER]: REQUEST_HEADER_VALUE }),
    Cookie: `${SESSION_COOKIE}=${token}`,
    ...(options.omitOrigin ? {} : { Origin: fixture.url }),
  };
  if (!options.omitKey && options.key !== undefined) headers["Idempotency-Key"] = options.key;
  return fetch(`${fixture.url}${path}`, { method: "POST", headers, body: JSON.stringify(options.body ?? {}) });
}

async function getBoard(fixture: Fixture, token = fixture.alexCookie): Promise<{ status: number; milestones: MilestoneView[] }> {
  const response = await fetch(`${fixture.url}/api/training`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
  const body = (await response.json()) as { milestones: MilestoneView[] };
  return { status: response.status, milestones: body.milestones };
}

function row(rows: readonly MilestoneView[], id: string): MilestoneView {
  const found = rows.find((entry) => entry.id === id);
  assert.ok(found, `${id} is on the board`);
  return found;
}

/** Committed reads and one commit for a tool, with a fixed task id and a memo. */
function toolApi(fixture: Fixture, conversationId: number, taskId = "task-1", memos = new Map<string, unknown>()): ToolExecutionApi {
  const api = {
    taskId,
    conversationId: conversationId as ConversationId,
    now: () => T0.getTime(),
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

function trainingTools() {
  return new Map((createTrainingTools().tools ?? []).map((tool) => [tool.name, tool]));
}

function resultText(result: { output?: unknown }): string {
  return (result.output as { text: string }[])[0]!.text;
}

// --- the board --------------------------------------------------------------

test("GET /api/training answers the board, and needs a session", async () => {
  const fixture = await startTrainingApp();
  try {
    assert.equal((await fetch(`${fixture.url}/api/training`)).status, 401);
    const { status, milestones } = await getBoard(fixture);
    assert.equal(status, 200);
    assert.equal(milestones.length > 0, true, "the starter catalog is on the board");
    assert.equal(row(milestones, "catalog:sit").status, "not_started");
    assert.equal(row(milestones, "catalog:sit").origin, "catalog");
    const response = await fetch(`${fixture.url}/api/training`, {
      headers: { Cookie: `${SESSION_COOKIE}=${fixture.alexCookie}` },
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await stop(fixture);
  }
});

// --- status and note --------------------------------------------------------

test("a status change is one commit, replayed by the same key, and the answer is the board", async () => {
  const fixture = await startTrainingApp();
  try {
    const first = await post(fixture, "/api/training/milestone", fixture.alexCookie, {
      key: "m-1",
      body: { milestoneId: "catalog:sit", status: "mastered" },
    });
    assert.equal(first.status, 200);
    const logged = (await first.json()) as { milestones: MilestoneView[]; replayed: boolean };
    assert.equal(logged.replayed, false);
    const sit = row(logged.milestones, "catalog:sit");
    assert.equal(sit.status, "mastered");
    assert.equal(sit.byLabel, "Alex");
    assert.ok(sit.masteredAt);
    // The answer is the board the next read serves.
    assert.deepEqual((await getBoard(fixture)).milestones, logged.milestones);

    const replay = await post(fixture, "/api/training/milestone", fixture.alexCookie, {
      key: "m-1",
      body: { milestoneId: "catalog:sit", status: "mastered" },
    });
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);
    assert.equal((await readTraining(fixture.app.app, context)).states.length, 1);

    const conflict = await post(fixture, "/api/training/milestone", fixture.alexCookie, {
      key: "m-1",
      body: { milestoneId: "catalog:sit", status: "practicing" },
    });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: string }).error, "idempotency_conflict");
  } finally {
    await stop(fixture);
  }
});

test("a note is set with text and cleared with an explicit null, not an absent key", async () => {
  const fixture = await startTrainingApp();
  try {
    const noted = await post(fixture, "/api/training/milestone", fixture.alexCookie, {
      key: "n-1",
      body: { milestoneId: "catalog:sit", note: "  waits by the door " },
    });
    assert.equal(noted.status, 200);
    const afterSet = row(((await noted.json()) as { milestones: MilestoneView[] }).milestones, "catalog:sit");
    assert.equal(afterSet.note, "waits by the door");
    assert.equal(afterSet.status, "not_started", "a note change is not a status change");

    // Absent note keeps it: only the status moves.
    const advanced = await post(fixture, "/api/training/milestone", fixture.alexCookie, {
      key: "n-2",
      body: { milestoneId: "catalog:sit", status: "practicing" },
    });
    assert.equal(row(((await advanced.json()) as { milestones: MilestoneView[] }).milestones, "catalog:sit").note, "waits by the door");

    // Explicit null clears it.
    const cleared = await post(fixture, "/api/training/milestone", fixture.alexCookie, {
      key: "n-3",
      body: { milestoneId: "catalog:sit", note: null },
    });
    assert.equal(cleared.status, 200);
    assert.equal(row(((await cleared.json()) as { milestones: MilestoneView[] }).milestones, "catalog:sit").note, undefined);
  } finally {
    await stop(fixture);
  }
});

test("an unknown milestone is a 409 carrying the board; a no-op change is refused", async () => {
  const fixture = await startTrainingApp();
  try {
    const unknown = await post(fixture, "/api/training/milestone", fixture.alexCookie, {
      key: "u-1",
      body: { milestoneId: "catalog:nope", status: "mastered" },
    });
    assert.equal(unknown.status, 409);
    const body = (await unknown.json()) as { error: string; milestones: MilestoneView[] };
    assert.match(body.error, /not on the board/);
    assert.ok(Array.isArray(body.milestones) && body.milestones.length > 0, "the answer carries the board");

    // A clear with no note changes nothing: the domain refuses it.
    const noop = await post(fixture, "/api/training/milestone", fixture.alexCookie, {
      key: "u-2",
      body: { milestoneId: "catalog:sit", note: null },
    });
    assert.equal(noop.status, 409);
    assert.equal(((await noop.json()) as { error: string }).error, MILESTONE_NOOP_RULE);
    assert.deepEqual((await readTraining(fixture.app.app, context)).states, []);
  } finally {
    await stop(fixture);
  }
});

// --- a custom milestone -----------------------------------------------------

test("a custom milestone is added once, and a duplicate title is refused", async () => {
  const fixture = await startTrainingApp();
  try {
    const added = await post(fixture, "/api/training/custom", fixture.alexCookie, {
      key: "c-1",
      body: { title: " Roll over " },
    });
    assert.equal(added.status, 200);
    const board = (await added.json()) as { milestones: MilestoneView[]; replayed: boolean };
    assert.equal(board.replayed, false);
    assert.equal(board.milestones.at(-1)?.title, "Roll over");
    assert.equal(board.milestones.at(-1)?.origin, "custom");

    const duplicate = await post(fixture, "/api/training/custom", fixture.alexCookie, {
      key: "c-2",
      body: { title: "sit" },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(((await duplicate.json()) as { error: string }).error, MILESTONE_TITLE_RULE);
    assert.equal((await readTraining(fixture.app.app, context)).custom.length, 1);
  } finally {
    await stop(fixture);
  }
});

// --- the shared guards ------------------------------------------------------

test("the milestone routes need a session, an origin, the request header, JSON and a key", async () => {
  const fixture = await startTrainingApp();
  try {
    const body = { milestoneId: "catalog:sit", status: "mastered" };
    assert.equal((await post(fixture, "/api/training/milestone", "", { key: "k", body })).status, 401);
    assert.equal((await post(fixture, "/api/training/milestone", fixture.alexCookie, { key: "k", body, omitOrigin: true })).status, 403);
    assert.equal((await post(fixture, "/api/training/milestone", fixture.alexCookie, { key: "k", body, omitHeader: true })).status, 403);
    assert.equal(
      (await post(fixture, "/api/training/milestone", fixture.alexCookie, { key: "k", body, contentType: "text/plain" })).status,
      415,
    );
    const noKey = await post(fixture, "/api/training/milestone", fixture.alexCookie, { body });
    assert.equal(noKey.status, 409);
    assert.match(((await noKey.json()) as { error: string }).error, /Idempotency-Key/);
    // A status the domain does not know is a shape refusal, not a write.
    const badStatus = await post(fixture, "/api/training/milestone", fixture.alexCookie, {
      key: "k",
      body: { milestoneId: "catalog:sit", status: "done" },
    });
    assert.equal(badStatus.status, 409);
    assert.deepEqual((await readTraining(fixture.app.app, context)).states, []);
  } finally {
    await stop(fixture);
  }
});

// --- Gate G3: the route and the tool produce one result --------------------

test("the UI route and the agent tool change the same document and read the same board", async () => {
  const fixture = await startTrainingApp();
  try {
    // The UI path.
    const viaRoute = await post(fixture, "/api/training/milestone", fixture.alexCookie, {
      key: "gate-route",
      body: { milestoneId: "catalog:sit", status: "mastered" },
    });
    assert.equal(viaRoute.status, 200);
    const routeBoard = ((await viaRoute.json()) as { milestones: MilestoneView[] }).milestones;

    // The agent path, on another milestone, through the same domain function.
    const household = (await fixture.app.app.snapshot(HouseholdDoc, context)) as Household;
    const tool = trainingTools().get("update_milestone");
    assert.ok(tool);
    const viaTool = await tool.execute(
      { milestoneId: "catalog:stay", status: "practicing" },
      toolApi(fixture, household.conversationId, "task-9"),
      context,
    );
    assert.equal(viaTool.isError, undefined);
    assert.match(resultText(viaTool), /Changed: "Household" started practicing "Stay"/);

    // One document, one board: the committed states are what both surfaces read.
    const committed = await readTrainingView(fixture.app.app, context);
    assert.equal(row(committed, "catalog:sit").status, "mastered");
    assert.equal(row(committed, "catalog:stay").status, "practicing");
    const record = await readTraining(fixture.app.app, context);
    assert.equal(record.states.find((state) => state.id === "catalog:sit")?.source, "ui");
    assert.equal(record.states.find((state) => state.id === "catalog:stay")?.source, "agent");
    assert.deepEqual((await getBoard(fixture)).milestones, committed);
    // The route's earlier answer differs only by the tool's later change.
    assert.equal(row(routeBoard, "catalog:sit").status, "mastered");
    assert.equal(row(routeBoard, "catalog:stay").status, "not_started");
    // The tool's text reports the same board the route serves.
    assert.match(resultText(viaTool), /Milestones: \d+ of \d+ mastered, 1 practicing/);
  } finally {
    await stop(fixture);
  }
});

test("the same input through the route and the tool differs only in provenance", async () => {
  const fixture = await startTrainingApp();
  try {
    // One milestone, one target status, two surfaces, two keys. The domain's
    // result must be the same apart from who/which channel/which key stamped it.
    const viaRoute = await post(fixture, "/api/training/milestone", fixture.alexCookie, {
      key: "same-route",
      body: { milestoneId: "catalog:stay", status: "mastered" },
    });
    assert.equal(viaRoute.status, 200);
    const household = (await fixture.app.app.snapshot(HouseholdDoc, context)) as Household;
    const tool = trainingTools().get("update_milestone");
    assert.ok(tool);
    const viaTool = await tool.execute(
      { milestoneId: "catalog:stay", status: "mastered" },
      toolApi(fixture, household.conversationId, "task-same"),
      context,
    );
    assert.equal(viaTool.isError, undefined);

    const record = await readTraining(fixture.app.app, context);
    // One state per milestone: the later (tool) commit is the current one, and
    // its shape is what the route's would have been.
    const states = record.states.filter((state) => state.id === "catalog:stay");
    assert.equal(states.length, 1);
    const current = states[0]!;
    assert.equal(current.status, "mastered");
    assert.equal(current.source, "agent");
    const routeBoard = ((await viaRoute.json()) as unknown as { milestones: MilestoneView[] }).milestones;
    assert.equal(row(routeBoard, "catalog:stay").status, "mastered");
    // The route's answer and the tool's text read the same board, one status each.
    assert.match(resultText(viaTool), /id "catalog:stay", "Stay", mastered /);
  } finally {
    await stop(fixture);
  }
});

// A guard: the domain's typed refusal still reaches the tool as a sentence.
test("an unknown milestone through the tool is a refusal, not a crash", async () => {
  const fixture = await startTrainingApp();
  try {
    const tool = trainingTools().get("update_milestone");
    assert.ok(tool);
    const result = await tool.execute(
      { milestoneId: "catalog:nope", status: "mastered" },
      toolApi(fixture, 1),
      context,
    );
    assert.equal(result.isError, true);
    assert.match(resultText(result), /^Not changed: that milestone is not on the board/);
  } finally {
    await stop(fixture);
  }
});
