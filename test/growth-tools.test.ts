// P3-03: the growth agent tools (PLAN §10.1, §10.2, §10.3, §9.2).
//
// What is covered:
//   * `get_growth`: the committed measurements, P3-02's trend/target copy and
//     the non-veterinary disclaimer, before and after a measurement;
//   * `log_measurement`: one commit through P3-01's service, the task id as the
//     `tool:` action id, `source: "agent"`, the household fallback actor when
//     the transcript has no chat entry (cached in the task's memo), and a rerun
//     of the same call as success rather than a second measurement;
//   * the refusal the model must read (an invalid weight), with nothing written;
//   * `get_context` now reports the latest weight and no longer lists growth as
//     untracked.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { SESSION_COOKIE, Auth } from "../src/server/auth.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { createGrowthTools } from "../src/server/agent/growth-tools.ts";
import { createProfileTools } from "../src/server/agent/tools.ts";
import { dataStores } from "../src/server/config.ts";
import { ActivityDoc, CommandsDoc, HouseholdDoc } from "../src/server/domain/docs.ts";
import { readGrowth } from "../src/server/domain/growth.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { createLogger } from "../src/server/log.ts";

const context = BACKGROUND_CONTEXT;
/** 23:30Z is already the next day in Paris: a UTC date would answer 29 October. */
const NOW_MS = Date.parse("2026-10-29T23:30:00.000Z");
const TODAY = "2026-10-30";

interface Fixture {
  dir: string;
  app: AppHandle;
  url: string;
  alexCookie: string;
}

async function startGrowthToolsApp(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-growth-tools-"));
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
    { dataDir: dir, host: "127.0.0.1", port: 0, models, now: () => NOW_MS },
    { logger: createLogger({ scope: "test", sink: () => undefined }) },
  );
  assert.ok(result.ok, "the app must start");
  const auth = new Auth({ config: stores.config });
  const ownerToken = await auth.mintOwner("http://127.0.0.1").then((m) => m.token);
  const alexCookie = await auth.login(ownerToken).then((l) => l.token);

  // A zone where 23:30Z is already tomorrow, so the local date is not a guess.
  const zone = await fetch(`${result.app.url}/api/household`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      "Idempotency-Key": "zone-1",
      Cookie: `${SESSION_COOKIE}=${alexCookie}`,
      Origin: result.app.url,
    },
    body: JSON.stringify({ rev: 0, timezone: "Europe/Paris" }),
  });
  assert.equal(zone.status, 200, "the household zone is set for this fixture");
  return { dir, app: result.app, url: result.app.url, alexCookie };
}

async function stop(fixture: Fixture): Promise<void> {
  await fixture.app.close();
  await rm(fixture.dir, { recursive: true, force: true });
}

/** Committed reads, one commit, a fixed task id, an in-memory memo and a pinned clock. */
function toolApi(
  fixture: Fixture,
  conversationId: number,
  taskId: string | number = "task-1",
  memos = new Map<string, unknown>(),
  nowMs = NOW_MS,
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
  const growth = createGrowthTools().tools ?? [];
  const profile = createProfileTools().tools ?? [];
  return new Map([...growth, ...profile].map((tool) => [tool.name, tool]));
}

function resultText(result: { output?: unknown }): string {
  return (result.output as { text: string }[])[0]!.text;
}

test("get_growth reports an empty series, the copy and the disclaimer", async () => {
  const fixture = await startGrowthToolsApp();
  try {
    const getGrowth = tools().get("get_growth");
    assert.ok(getGrowth);
    const result = await getGrowth.execute({}, toolApi(fixture, await sharedConversationId(fixture)), context);
    const text = resultText(result);
    assert.match(text, /^Measurements: none yet\./);
    assert.match(text, /No weight logged yet\./);
    assert.match(text, /not veterinary advice/);
  } finally {
    await stop(fixture);
  }
});

test("log_measurement commits one weight as the speaker, reports it, and replays on the same task", async () => {
  const fixture = await startGrowthToolsApp();
  try {
    const conversationId = await sharedConversationId(fixture);
    const logWeight = tools().get("log_measurement");
    assert.ok(logWeight);
    assert.equal(logWeight.replay, "safe", "the domain write is idempotent on the task id");
    const memos = new Map<string, unknown>();

    const saved = await logWeight.execute(
      { weightKg: 4.25, heightCm: 31.5, note: 'after a "nap"' },
      toolApi(fixture, conversationId, "task-42", memos),
      context,
    );
    assert.equal(saved.isError, undefined);
    // No chat entry in this transcript: the actor is the household fallback,
    // never a name the model supplied.
    assert.match(resultText(saved), /^Logged 4\.25 kg on 2026-10-30, by "Household"\./);
    assert.match(resultText(saved), /Measurements \(oldest first\):\n2026-10-30 4\.25 kg, 31\.5 cm/);
    assert.match(resultText(saved), /One weight logged/);
    assert.match(resultText(saved), /not veterinary advice/);

    const growth = await readGrowth(fixture.app.app, context);
    assert.equal(growth.measurements.length, 1);
    const measurement = growth.measurements[0]!;
    assert.equal(measurement.localDate, TODAY, "the household's date, not the UTC one");
    assert.equal(measurement.heightCm, 31.5);
    assert.equal(measurement.note, 'after a "nap"');
    assert.equal(measurement.source, "agent");
    assert.equal(measurement.actionId, "tool:task-42", "the task id is the durable identity of the call");
    assert.equal(measurement.byUserId, null);
    assert.equal(measurement.byLabel, "Household");

    // §9.2: the resolved actor is cached in the task's memo after the commit.
    assert.deepEqual(memos.get("actor"), { id: null, label: "Household" });
    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.deepEqual(
      activity?.entries.filter((entry) => entry.kind === "growth.measurement").map((entry) => entry.summary),
      ["Household logged a weight of 4.25 kg"],
    );
    const commands = await fixture.app.app.snapshot(CommandsDoc, context);
    assert.ok(commands?.entries.some((entry) => entry.key === "tool:task-42"));

    const replay = await logWeight.execute(
      { weightKg: 4.25, heightCm: 31.5, note: 'after a "nap"' },
      toolApi(fixture, conversationId, "task-42", memos),
      context,
    );
    assert.equal(replay.isError, undefined, "a rerun of the same call is success");
    assert.match(resultText(replay), /\(already logged; nothing new was written\)/);
    assert.equal((await readGrowth(fixture.app.app, context)).measurements.length, 1, "no second measurement");
  } finally {
    await stop(fixture);
  }
});

test("an invalid weight is refused with the rule and writes nothing", async () => {
  const fixture = await startGrowthToolsApp();
  try {
    const conversationId = await sharedConversationId(fixture);
    const logWeight = tools().get("log_measurement");
    assert.ok(logWeight);
    const result = await logWeight.execute({ weightKg: 0 }, toolApi(fixture, conversationId, "task-7"), context);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /^Not logged: a measurement is a weight in kilograms/);
    assert.match(resultText(result), /Nothing was written\./);
    assert.equal((await readGrowth(fixture.app.app, context)).measurements.length, 0);
    // The fixture's own timezone save is the only activity entry.
    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.deepEqual(
      activity?.entries.filter((entry) => entry.kind === "growth.measurement"),
      [],
    );
  } finally {
    await stop(fixture);
  }
});

test("get_context reports the latest weight and no longer lists growth as untracked", async () => {
  const fixture = await startGrowthToolsApp();
  try {
    const conversationId = await sharedConversationId(fixture);
    const logWeight = tools().get("log_measurement");
    const getContext = tools().get("get_context");
    assert.ok(logWeight && getContext);

    const empty = await getContext.execute({}, toolApi(fixture, conversationId), context);
    assert.match(resultText(empty), /Latest weight: none logged yet/);
    assert.doesNotMatch(resultText(empty), /growth/);

    await logWeight.execute({ weightKg: 4.2 }, toolApi(fixture, conversationId, "task-1"), context);
    const reported = await getContext.execute({}, toolApi(fixture, conversationId), context);
    // The state rides along, so "latest" is never reported as "current" when
    // the series is stale (P3-02's rule).
    assert.match(resultText(reported), /Latest weight: 4\.2 kg on 2026-10-30$/m);
    assert.doesNotMatch(resultText(reported), /Not tracked by this build yet: .*growth/);
  } finally {
    await stop(fixture);
  }
});
