// P3-07: the shower HTTP surface, its live care frame and Gate G3 (PLAN §7.3,
// §7.4, §8.4, §9.4, §14.2, §16 P3-07).
//
// What is covered:
//   * GET /api/showers: the history, the derived next due date and the interval,
//     `no-store`, a session, and the household-local today;
//   * POST /api/showers: one commit, a *bounded* answer (the history is
//     unbounded), replay under the same key, the one key-conflict answer, and the
//     domain's refusal for text it would not store — nothing written;
//   * the shared mutation guards (session, origin, request header, JSON, key);
//   * the care frame: a shower moves no document revision, and still reaches the
//     other caregiver's screen;
//   * Gate G3: the route and the tool append the same domain record, apart from
//     provenance, and a DST-boundary day renders the same next-due date from both
//     paths.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { SESSION_COOKIE, Auth } from "../src/server/auth.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { watchProfileState } from "../src/server/agent/state.ts";
import { createShowerTools } from "../src/server/agent/shower-tools.ts";
import { dataStores, emptyConfig } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import { ActivityDoc, HouseholdDoc, ShowersDoc, parseShowers } from "../src/server/domain/docs.ts";
import { openHarness } from "../src/server/harness.ts";
import { createLogger } from "../src/server/log.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { SHAMPOO_LIMIT, SHOWER_RULE, type ShowerView } from "../src/shared/showers.ts";
import type { Shower } from "../src/shared/domain.ts";
import type { Household } from "../src/shared/domain.ts";
import type { PuppyProfile } from "../src/shared/profile.ts";

const context = BACKGROUND_CONTEXT;

/**
 * 22:30Z on 24 October is already 00:30 on 25 October in Paris — a household
 * that logged its shower on the autumn DST day, not the UTC date before it.
 */
const T0 = new Date("2026-10-24T22:30:00.000Z");
/** 25 October + the default 21-day interval, in calendar dates, across the DST change. */
const NEXT_DUE = "2026-11-15";

interface Fixture {
  dir: string;
  app: AppHandle;
  url: string;
  alexCookie: string;
  profile: () => Promise<PuppyProfile>;
}

async function startShowerApp(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-shower-routes-"));
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const stores = dataStores(dir);
  await stores.config.ensure();
  const createdAt = "2026-10-23T10:00:00.000Z";
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
  const fixture: Fixture = {
    dir,
    app: result.app,
    url: result.app.url,
    alexCookie,
    profile: async () => {
      const response = await fetch(`${result.app.url}/api/puppy`, {
        headers: { Cookie: `${SESSION_COOKIE}=${alexCookie}` },
      });
      assert.equal(response.status, 200);
      return (await response.json()) as PuppyProfile;
    },
  };
  // The DST case needs a zone that changes offset inside the interval; the
  // container's own zone is whatever the host chose.
  const current = await fixture.profile();
  const patched = await fetch(`${result.app.url}/api/household`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      Cookie: `${SESSION_COOKIE}=${alexCookie}`,
      Origin: result.app.url,
      "Idempotency-Key": "tz-setup",
    },
    body: JSON.stringify({ rev: current.household.rev, timezone: "Europe/Paris" }),
  });
  assert.equal(patched.status, 200, "the household timezone is set for the fixture");
  return fixture;
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

interface ShowerWriteAnswer {
  shower: Shower;
  replayed: boolean;
}

async function getShowers(fixture: Fixture, token = fixture.alexCookie): Promise<{ status: number; body: ShowerView }> {
  const response = await fetch(`${fixture.url}/api/showers`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
  return { status: response.status, body: (await response.json()) as ShowerView };
}

/** Committed reads and one commit for a tool, with a fixed task id and a memo. */
function toolApi(
  fixture: Fixture,
  conversationId: number,
  taskId = "task-1",
  memos = new Map<string, unknown>(),
): ToolExecutionApi {
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

function showerTools() {
  return new Map((createShowerTools().tools ?? []).map((tool) => [tool.name, tool]));
}

function resultText(result: { output?: unknown }): string {
  return (result.output as { text: string }[])[0]!.text;
}

async function conversationIdOf(fixture: Fixture): Promise<number> {
  return (await fixture.app.app.snapshot(HouseholdDoc, context))!.conversationId;
}

async function committedShowers(fixture: Fixture): Promise<readonly Shower[]> {
  const snapshot = await fixture.app.app.snapshot(ShowersDoc, context);
  const showers = snapshot === undefined ? undefined : parseShowers(snapshot);
  assert.ok(showers, "app.showers is readable");
  return showers.showers;
}

// --- the read ---------------------------------------------------------------

test("GET /api/showers answers the empty view, and needs a session", async () => {
  const fixture = await startShowerApp();
  try {
    const unauthenticated = await fetch(`${fixture.url}/api/showers`);
    assert.equal(unauthenticated.status, 401);

    const { status, body } = await getShowers(fixture);
    assert.equal(status, 200);
    assert.deepEqual(body.history, []);
    assert.equal(body.status.last, null);
    assert.equal(body.status.nextDue, null);
    assert.equal(body.status.daysUntilDue, null);
    assert.equal(body.intervalDays, 21, "the household's one interval setting");

    const response = await fetch(`${fixture.url}/api/showers`, {
      headers: { Cookie: `${SESSION_COOKIE}=${fixture.alexCookie}` },
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await stop(fixture);
  }
});

// --- the write --------------------------------------------------------------

test("POST /api/showers commits one shower and answers a bounded record", async () => {
  const fixture = await startShowerApp();
  try {
    const logged = await post(fixture, "/api/showers", fixture.alexCookie, {
      key: "s-1",
      body: { shampoo: "  Oatmeal  ", notes: " towel dry " },
    });
    assert.equal(logged.status, 200);
    const answer = (await logged.json()) as ShowerWriteAnswer;
    assert.equal(answer.replayed, false);
    assert.equal(answer.shower.localDate, "2026-10-25", "the household-local date, not the UTC date");
    assert.equal(answer.shower.at, T0.toISOString());
    assert.equal(answer.shower.shampoo, "Oatmeal");
    assert.equal(answer.shower.notes, "towel dry");
    assert.equal(answer.shower.source, "ui");
    assert.equal(answer.shower.byLabel, "Alex");
    assert.equal("history" in (answer as unknown as Record<string, unknown>), false, "a write's answer is bounded");

    const { body } = await getShowers(fixture);
    assert.equal(body.history.length, 1);
    assert.equal(body.status.last?.id, answer.shower.id);
    assert.equal(body.status.nextDue, NEXT_DUE);
    assert.equal(body.status.daysUntilDue, 21);

    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries.at(-1)?.kind, "shower.logged");
    assert.equal(activity?.entries.at(-1)?.summary, "Alex logged a shower");
    assert.equal(activity?.entries.at(-1)?.summary.includes("Oatmeal"), false, "the shampoo stays off the feed");
  } finally {
    await stop(fixture);
  }
});

test("a repeated key with the same body replays, and a different body is the key conflict", async () => {
  const fixture = await startShowerApp();
  try {
    const first = await post(fixture, "/api/showers", fixture.alexCookie, {
      key: "s-repeat",
      body: { shampoo: "Oatmeal" },
    });
    assert.equal(first.status, 200);
    const recorded = ((await first.json()) as ShowerWriteAnswer).shower;

    const replay = await post(fixture, "/api/showers", fixture.alexCookie, {
      key: "s-repeat",
      body: { shampoo: " Oatmeal " },
    });
    assert.equal(replay.status, 200);
    const replayed = (await replay.json()) as ShowerWriteAnswer;
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.shower.id, recorded.id, "the recorded shower, not a second one");
    assert.equal((await committedShowers(fixture)).length, 1);

    const conflict = await post(fixture, "/api/showers", fixture.alexCookie, {
      key: "s-repeat",
      body: { shampoo: "Medicated" },
    });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: string }).error, "idempotency_conflict");
    assert.equal((await committedShowers(fixture)).length, 1);
  } finally {
    await stop(fixture);
  }
});

test("a second shower on the same day is legitimate, and a refused shape writes nothing", async () => {
  const fixture = await startShowerApp();
  try {
    for (const [key, body] of [
      ["s-1", {}],
      ["s-2", { notes: "Muddy paws" }],
    ] as const) {
      const response = await post(fixture, "/api/showers", fixture.alexCookie, { key, body });
      assert.equal(response.status, 200);
    }
    const { body } = await getShowers(fixture);
    assert.equal(body.history.length, 2, "two showers in one day are two observations");
    assert.ok(
      body.history.some((row) => row.notes === "Muddy paws"),
      "both observations are in the history (same instant, so the document order decides)",
    );

    const tooLong = await post(fixture, "/api/showers", fixture.alexCookie, {
      key: "s-bad-1",
      body: { shampoo: "x".repeat(SHAMPOO_LIMIT + 1) },
    });
    assert.equal(tooLong.status, 409);
    assert.equal(((await tooLong.json()) as { error: string }).error, SHOWER_RULE);

    const typo = await post(fixture, "/api/showers", fixture.alexCookie, {
      key: "s-bad-2",
      body: { shampoo: "Oatmeal", shampooBrand: "x" },
    });
    assert.equal(typo.status, 409);
    assert.match(((await typo.json()) as { error: string }).error, /does not accept "shampooBrand"/);

    const number = await post(fixture, "/api/showers", fixture.alexCookie, {
      key: "s-bad-3",
      body: { notes: 42 },
    });
    assert.equal(number.status, 409);
    assert.match(((await number.json()) as { error: string }).error, /notes is text/);

    assert.equal((await committedShowers(fixture)).length, 2, "a refused shower writes nothing");
    // The refused requests never burnt a key: the first one now logs.
    const retried = await post(fixture, "/api/showers", fixture.alexCookie, {
      key: "s-bad-1",
      body: { shampoo: "Gentle" },
    });
    assert.equal(retried.status, 200);
    assert.equal(((await retried.json()) as ShowerWriteAnswer).replayed, false);
  } finally {
    await stop(fixture);
  }
});

test("the shower routes need a session, an origin, the request header, JSON and a key", async () => {
  const fixture = await startShowerApp();
  try {
    assert.equal((await post(fixture, "/api/showers", "", { key: "k", body: {} })).status, 401);
    assert.equal(
      (await post(fixture, "/api/showers", fixture.alexCookie, { key: "k", body: {}, omitOrigin: true })).status,
      403,
    );
    assert.equal(
      (await post(fixture, "/api/showers", fixture.alexCookie, { key: "k", body: {}, omitHeader: true })).status,
      403,
    );
    assert.equal(
      (await post(fixture, "/api/showers", fixture.alexCookie, {
        key: "k",
        body: {},
        contentType: "text/plain",
      })).status,
      415,
    );
    const noKey = await post(fixture, "/api/showers", fixture.alexCookie, { body: {} });
    assert.equal(noKey.status, 409);
    assert.match(((await noKey.json()) as { error: string }).error, /Idempotency-Key/);
    assert.deepEqual((await committedShowers(fixture)), []);
  } finally {
    await stop(fixture);
  }
});

// --- the live frame ---------------------------------------------------------

test("a shower publishes a care signal, and the frame carries no shower data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-shower-frame-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models });
  try {
    await bootstrapSession(opened.harness, {
      config: {
        ...emptyConfig(),
        members: [
          { id: "owner", role: "owner", displayName: "Alex", createdAt: T0.toISOString(), sessions: [] },
        ],
      },
      context,
      timezone: "Europe/Paris",
      now: () => T0,
    });
    const frames: PuppyProfile[] = [];
    const watch = watchProfileState({
      harness: opened.harness,
      context,
      bus: { publishState: (profile: unknown) => frames.push(profile as PuppyProfile) },
      logger: createLogger({ scope: "test", sink: () => undefined }),
      now: () => T0,
    });
    try {
      const { logShower } = await import("../src/server/domain/showers.ts");
      await logShower(opened.harness, context, {
        actor: async () => ({ id: "owner", label: "Alex" }),
        actionId: "http:shower-frame",
        shampoo: "Oatmeal",
        source: "ui",
        now: T0,
      });
      const deadline = Date.now() + 2000;
      while (frames.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(frames.length > 0, "app.showers is one of the documents behind the care frame");
      // P2-05: the frame is a signal, not data. `applyCareView` bumps `careSeq`,
      // and the Pup screen re-reads GET /api/showers on the change.
      const frame = frames[frames.length - 1]!;
      assert.equal("showers" in (frame as unknown as Record<string, unknown>), false, "no shower data on the frame");
    } finally {
      watch.stop();
    }
    // The live read the screen re-fetches does carry it.
    const { readShowerView } = await import("../src/server/domain/showers.ts");
    const view = await readShowerView(opened.harness, context, T0);
    assert.equal(view.history.length, 1, "the shower the frame signalled is on the live read");
    assert.equal(view.history[0]?.shampoo, "Oatmeal");
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Gate G3 ---------------------------------------------------------------

test("the UI route and the agent tool append the same shower, apart from provenance", async () => {
  const fixture = await startShowerApp();
  try {
    const viaRoute = await post(fixture, "/api/showers", fixture.alexCookie, {
      key: "gate-route",
      body: { shampoo: "Oatmeal", notes: "towel dry" },
    });
    assert.equal(viaRoute.status, 200);

    const logTool = showerTools().get("log_shower");
    assert.ok(logTool);
    const viaTool = await logTool.execute(
      { shampoo: "Oatmeal", notes: "towel dry" },
      toolApi(fixture, await conversationIdOf(fixture), "task-gate"),
      context,
    );
    assert.equal(viaTool.isError, undefined);
    assert.match(resultText(viaTool), /^Logged a shower on 2026-10-25 by "Household"\./);

    const showers = await committedShowers(fixture);
    assert.equal(showers.length, 2, "each surface appended its own observation");
    const [ui, agent] = showers as [Shower, Shower];
    // The domain result is the same record; only id/actor/source/key differ.
    for (const record of [ui, agent]) {
      assert.equal(record.localDate, "2026-10-25");
      assert.equal(record.at, T0.toISOString());
      assert.equal(record.shampoo, "Oatmeal");
      assert.equal(record.notes, "towel dry");
    }
    assert.equal(ui.source, "ui");
    assert.equal(agent.source, "agent");
    assert.match(ui.actionId, /^http:/);
    assert.match(agent.actionId, /^tool:/);
    assert.equal(ui.byLabel, "Alex");
    assert.equal(agent.byLabel, "Household", "a model-less tool call is the household fallback (§9.2)");
    assert.notEqual(ui.id, agent.id);
  } finally {
    await stop(fixture);
  }
});

test("a DST-boundary day renders the same next-due date from the route and the tool", async () => {
  const fixture = await startShowerApp();
  try {
    // Paris ends DST on 25 October. The shower is logged at 00:30 local on that
    // day; the interval counts calendar dates, so the due date is 15 November —
    // never 14 or 16 because an instant gained or lost an hour in between.
    const logged = await post(fixture, "/api/showers", fixture.alexCookie, {
      key: "dst-route",
      body: { notes: "After the muddy walk" },
    });
    assert.equal(logged.status, 200);

    const viaRoute = await getShowers(fixture);
    assert.equal((await fixture.profile()).household.timezone, "Europe/Paris");
    assert.equal(viaRoute.body.status.last?.localDate, "2026-10-25");
    assert.equal(viaRoute.body.status.nextDue, NEXT_DUE);
    assert.equal(viaRoute.body.status.daysUntilDue, 21);

    // The agent's own log on the same household day derives the same due date.
    const logTool = showerTools().get("log_shower");
    const listTool = showerTools().get("list_showers");
    assert.ok(logTool && listTool);
    const conversationId = await conversationIdOf(fixture);
    const viaTool = await logTool.execute(
      { shampoo: "Oatmeal" },
      toolApi(fixture, conversationId, "task-dst"),
      context,
    );
    assert.equal(viaTool.isError, undefined);
    assert.match(resultText(viaTool), /next due 2026-11-15 \(in 21 days\)/);

    const listed = await listTool.execute({}, toolApi(fixture, conversationId, "task-dst-list"), context);
    assert.match(
      resultText(listed),
      /Showers: last 2026-10-25 by "(?:Alex|Household)", next due 2026-11-15 \(in 21 days\)\./,
    );
    assert.match(resultText(listed), /History \(newest first\):/);
    assert.match(resultText(listed), /2026-10-25 00:30, by "Household", shampoo "Oatmeal"/);

    // And the route still answers the same date after the tool's commit.
    const after = await getShowers(fixture);
    assert.equal(after.body.status.nextDue, NEXT_DUE);
    assert.equal(after.body.history.length, 2);
  } finally {
    await stop(fixture);
  }
});
