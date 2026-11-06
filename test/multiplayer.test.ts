// P2-08: the Phase 2 multiplayer and durability tests (PLAN §15.3, §15.2, G2).
//
// Gate G2 is four claims, and each gets a test here over the real listener, a
// real SQLite file, the real agent task path and the one SSE stream:
//
//   * **one feed event under concurrency** — two caregivers POST the same slot
//     in flight; exactly one commits, the loser gets 409 `already_fed` with the
//     current day, and the partner intent is exactly one;
//   * **the same action is success** — the same key and body concurrently is one
//     commit and one replay, never two meals;
//   * **the agent and HTTP agree** — a model's tool call and the route race the
//     same slot; one commits and the other reads the committed truth (who/when)
//     in both directions;
//   * **a walk survives a process kill** — a child process commits the start and
//     is SIGKILLed without closing; a fresh app on the same data directory finds
//     the open walk and the other caregiver ends it;
//   * **both clients see the same state** — the partner's SSE stream receives a
//     care frame for a feed and for a walk start, while the long-poll fallback
//     is not woken by care writes (frames are not thread news).
//
// Interleavings are driven by `Promise.all`, the injected clock and a scripted
// faux provider — no sleep-based ordering.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { SESSION_COOKIE, Auth, hashToken, newToken } from "../src/server/auth.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { dataStores } from "../src/server/config.ts";
import { ActivityDoc, FeedingDoc, NotificationsDoc, WalksDoc } from "../src/server/domain/docs.ts";
import { createLogger } from "../src/server/log.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { WALK_STALE_AFTER_MS } from "../src/shared/walks.ts";
import type { FeedEvent, MealSlot, Walk } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
const T0 = Date.parse("2026-10-30T08:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const SLOTS: MealSlot[] = [
  { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true },
  { id: "slot-d", label: "Dinner", timeLocal: "18:00", active: true },
];

type ResponseStep = ReturnType<typeof fauxAssistantMessage> | (() => ReturnType<typeof fauxAssistantMessage>);

interface Fixture {
  dir: string;
  app: AppHandle;
  url: string;
  alexCookie: string;
  samCookie: string;
  setNow: (ms: number) => void;
}

async function startMultiplayerApp(options: {
  responses?: readonly ResponseStep[];
  now?: number;
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-multiplayer-"));
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] });
  faux.setResponses([...(options.responses ?? [() => fauxAssistantMessage("Done.")])]);
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

  let current = options.now ?? T0;
  const result = await startApp(
    { dataDir: dir, host: "127.0.0.1", port: 0, models, now: () => current },
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
    samCookie: samToken,
    setNow: (ms) => {
      current = ms;
    },
  };

  const slots = await post(fixture, "/api/feeding/slots", "PATCH", alexCookie, { rev: 0, slots: SLOTS }, "slots-1");
  if (slots.status !== 200) {
    // Every caller's `finally` starts after this returns, so close here rather
    // than leaking a listener and a database on a fixture failure.
    await result.app.close();
    await rm(dir, { recursive: true, force: true });
    assert.equal(slots.status, 200, "the schedule must be storable");
  }
  return fixture;
}

async function stop(fixture: Fixture): Promise<void> {
  await fixture.app.close();
  await rm(fixture.dir, { recursive: true, force: true });
}

function cookieFor(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

async function post(
  fixture: Fixture,
  path: string,
  method: "POST" | "PATCH",
  token: string,
  body: Record<string, unknown>,
  key: string,
): Promise<Response> {
  return fetch(`${fixture.url}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      "Idempotency-Key": key,
      Cookie: cookieFor(token),
      Origin: fixture.url,
    },
    body: JSON.stringify(body),
  });
}

async function getJson<T>(fixture: Fixture, path: string, token: string): Promise<T> {
  const response = await fetch(`${fixture.url}${path}`, { headers: { Cookie: cookieFor(token) } });
  assert.equal(response.status, 200);
  return (await response.json()) as T;
}

/** Poll until `probe` yields a value (or fail the test). */
async function until<T>(probe: () => Promise<T | undefined>, budgetMs = 8000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Read SSE frames until `predicate` matches one (or the budget expires). */
async function nextFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: string, data: unknown) => boolean,
  budgetMs = 5000,
): Promise<{ event: string; data: unknown }> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + budgetMs;
  let buffer = "";
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("no matching SSE frame in time");
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("no matching SSE frame in time")), remaining);
        timer.unref?.();
      }),
    ]);
    if (chunk.done) throw new Error("the SSE stream ended");
    buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) break;
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (event === undefined) continue;
      const parsed = data === undefined ? undefined : JSON.parse(data);
      if (predicate(event, parsed)) return { event, data: parsed };
    }
  }
}

function feedBody(slotId: string): Record<string, unknown> {
  return { slotId };
}

// --- one feed event under concurrency ---------------------------------------

test("two caregivers feeding one slot in flight commit exactly one meal", async () => {
  const fixture = await startMultiplayerApp();
  try {
    const [alex, sam] = await Promise.all([
      post(fixture, "/api/feeding/fed", "POST", fixture.alexCookie, feedBody("slot-b"), "alex-race"),
      post(fixture, "/api/feeding/fed", "POST", fixture.samCookie, feedBody("slot-b"), "sam-race"),
    ]);
    const statuses = [alex.status, sam.status].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one request wins");
    const winner = alex.status === 200 ? alex : sam;
    const loser = alex.status === 409 ? alex : sam;
    type DayView = {
      localDate: string;
      slots: { slot: { id: string }; feed: FeedEvent | null }[];
      events: FeedEvent[];
    };
    const won = (await winner.json()) as { feed: FeedEvent; day: DayView };
    const lost = (await loser.json()) as { error: string; message: string; feed: FeedEvent; day: DayView };
    assert.equal(lost.error, "already_fed");
    assert.equal(lost.feed.id, won.feed.id, "the loser is shown the committed meal");
    assert.equal(lost.day.events.length, 1, "the 409 carries the current day, one event");
    const claimed = won.day.slots.find((entry) => entry.slot.id === "slot-b")?.feed;
    assert.equal(claimed?.id, won.feed.id, "the current day marks the slot fed");
    assert.equal(lost.day.slots.find((entry) => entry.slot.id === "slot-b")?.feed?.id, won.feed.id);
    assert.match(lost.message, /already logged this meal at \d{2}:\d{2}/);
    assert.ok(lost.message.includes(won.feed.byLabel), "the 409 names who fed the slot");
    assert.equal(lost.feed.at, won.feed.at, "the conflict's feed is the committed record");
    assert.equal(lost.feed.byUserId, won.feed.byUserId);
    assert.equal(lost.feed.source, "ui");
    assert.equal(lost.day.localDate, won.feed.localDate);

    const feeding = await fixture.app.app.snapshot(FeedingDoc, context);
    assert.equal(feeding?.events.length, 1, "the document holds one event, never two");
    assert.equal(feeding?.events[0]?.source, "ui");

    // §12.3: exactly one `fed` intent, for the caregiver who did not feed. (A
    // reminder may have fired in this fixture, so filter by category.)
    const notifications = await fixture.app.app.snapshot(NotificationsDoc, context);
    const fed = (notifications?.items ?? []).filter((item) => item.category === "fed");
    assert.equal(fed.length, 1, "one meal, one partner intent");
    const feeder = won.feed.byUserId;
    assert.notEqual(fed[0]?.userId, feeder, "the actor is not notified");
    const intent = fed[0];
    const other = won.feed.byUserId === "owner" ? "partner" : "owner";
    assert.equal(intent?.userId, other, "the intent targets the other caregiver exactly");
    assert.equal(intent?.category, "fed");
    assert.equal(intent?.title, "A meal was logged", "the push body is category text only");
    assert.equal(
      intent?.dedupeKey,
      `fed|${won.feed.localDate}|slot|slot-b|${other}`,
      "§12.3's per-category dedupe key, not an event id",
    );
    assert.equal(intent?.readAt, null);
    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    const logged = activity?.entries.filter((entry) => entry.kind === "feed.logged") ?? [];
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.actorLabel, won.feed.byLabel, "the activity names the caregiver who fed");
  } finally {
    await stop(fixture);
  }
});

test("the same key and body arriving twice in flight is one meal and one replay", async () => {
  const fixture = await startMultiplayerApp();
  try {
    const [first, second] = await Promise.all([
      post(fixture, "/api/feeding/fed", "POST", fixture.alexCookie, feedBody("slot-b"), "one-key"),
      post(fixture, "/api/feeding/fed", "POST", fixture.alexCookie, feedBody("slot-b"), "one-key"),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const bodies = [(await first.json()) as { feed: FeedEvent; replayed: boolean }, (await second.json()) as { feed: FeedEvent; replayed: boolean }];
    assert.deepEqual(bodies.map((body) => body.replayed).sort(), [false, true], "one commit, one replay");
    assert.equal(bodies[0]?.feed.id, bodies[1]?.feed.id);
    assert.equal((await fixture.app.app.snapshot(FeedingDoc, context))?.events.length, 1);
  } finally {
    await stop(fixture);
  }
});

// --- the agent and the route race ------------------------------------------

function message(fixture: Fixture, token: string, text: string, clientMessageId: string): Promise<Response> {
  return fetch(`${fixture.url}/api/agent/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      Cookie: cookieFor(token),
      Origin: fixture.url,
    },
    body: JSON.stringify({ text, clientMessageId }),
  });
}

test("a model's log_feeding and the route cannot both claim one slot", async () => {
  const fixture = await startMultiplayerApp({
    responses: [
      () => fauxAssistantMessage([fauxToolCall("log_feeding", { slotId: "slot-b" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("Logged breakfast."),
    ],
  });
  try {
    // The agent commits the meal first, attributed to the caregiver who spoke.
    const posted = await message(fixture, fixture.alexCookie, "Log breakfast", "m-feed-agent");
    assert.equal(posted.status, 202);
    const event = await until(async () => (await fixture.app.app.snapshot(FeedingDoc, context))?.events[0]);
    assert.equal(event.byUserId, "owner", "the tool's actor is the thread speaker");
    assert.equal(event.byLabel, "Alex");
    assert.equal(event.source, "agent", "the record says which channel wrote it");
    assert.equal(event.actionId.startsWith("tool:"), true);
    const agentActivity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.ok(agentActivity?.entries.some((entry) => entry.summary === 'Alex fed "Breakfast"'));

    // The other caregiver's route call now reads the committed truth.
    const route = await post(fixture, "/api/feeding/fed", "POST", fixture.samCookie, feedBody("slot-b"), "sam-after-agent");
    assert.equal(route.status, 409);
    const conflict = (await route.json()) as { error: string; feed: FeedEvent; message: string };
    assert.equal(conflict.error, "already_fed");
    assert.equal(conflict.feed.id, event.id);
    assert.match(conflict.message, /Alex already logged this meal/);
    assert.equal((await fixture.app.app.snapshot(FeedingDoc, context))?.events.length, 1);

    // The tool card is readable through the household thread (asserted with
    // Alex's session; both caregivers share the conversation).
    const card = await until(async () => {
      const snapshot = await getJson<{ entries: { kind: string; toolName?: string; status?: string; text?: string }[] }>(
        fixture,
        "/api/agent/thread",
        fixture.alexCookie,
      );
      return snapshot.entries.find((entry) => entry.kind === "tool");
    });
    assert.equal(card.toolName, "log_feeding");
    assert.equal(card.status, "ok");
  } finally {
    await stop(fixture);
  }
});

test("an HTTP feed first makes the model read the conflict, not a second meal", async () => {
  const fixture = await startMultiplayerApp({
    responses: [
      () => fauxAssistantMessage([fauxToolCall("log_feeding", { slotId: "slot-b" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("Sam already fed breakfast."),
    ],
  });
  try {
    const route = await post(fixture, "/api/feeding/fed", "POST", fixture.alexCookie, feedBody("slot-b"), "alex-first");
    assert.equal(route.status, 200);

    const posted = await message(fixture, fixture.samCookie, "Log breakfast", "m-feed-late");
    assert.equal(posted.status, 202);
    const card = await until(async () => {
      const snapshot = await getJson<{ entries: { kind: string; toolName?: string; status?: string; text?: string }[] }>(
        fixture,
        "/api/agent/thread",
        fixture.samCookie,
      );
      return snapshot.entries.find((entry) => entry.kind === "tool");
    });
    assert.equal(card.status, "error", "the tool refuses instead of failing the task");
    assert.match(card.text ?? "", /Not logged: .*already logged this meal/);
    assert.equal((await fixture.app.app.snapshot(FeedingDoc, context))?.events.length, 1, "still one meal");
    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries.filter((entry) => entry.kind === "feed.logged").length, 1);
  } finally {
    await stop(fixture);
  }
});

test("the route and the agent started together still commit one meal", async () => {
  const fixture = await startMultiplayerApp({
    responses: [
      () => fauxAssistantMessage([fauxToolCall("log_feeding", { slotId: "slot-d" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("Dinner logged."),
    ],
  });
  try {
    // Both surfaces are set going in the same tick: the route is already on the
    // wire while the agent run starts and reaches its tool call. The commit line
    // decides the winner; the guarantee is that only one commits.
    const [route, posted] = await Promise.all([
      post(fixture, "/api/feeding/fed", "POST", fixture.samCookie, feedBody("slot-d"), "sim-route"),
      message(fixture, fixture.alexCookie, "Log dinner", "m-sim-agent"),
    ]);
    assert.equal(posted.status, 202);
    assert.ok(route.status === 200 || route.status === 409, `unexpected route status ${route.status}`);
    if (route.status === 409) assert.equal(((await route.json()) as { error: string }).error, "already_fed");

    const event = await until(async () => (await fixture.app.app.snapshot(FeedingDoc, context))?.events.find((candidate) => candidate.slotId === "slot-d"));
    assert.ok(event);
    const card = await until(async () => {
      const snapshot = await getJson<{ entries: { kind: string; toolName?: string; status?: string }[] }>(
        fixture,
        "/api/agent/thread",
        fixture.alexCookie,
      );
      return snapshot.entries.find((entry) => entry.kind === "tool");
    });
    const routeWon = route.status === 200;
    const toolWon = card.status === "ok";
    assert.notEqual(routeWon, toolWon, "exactly one surface commits; the other reads the refusal");
    assert.equal((await fixture.app.app.snapshot(FeedingDoc, context))?.events.length, 1, "one meal, whichever surface won");
    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries.filter((entry) => entry.kind === "feed.logged").length, 1);
  } finally {
    await stop(fixture);
  }
});

// --- a walk across a SIGKILL ------------------------------------------------

/**
 * Wait until the child writes its readiness marker (atomically, write-then-
 * rename). The child starts the real app and commits the walk over HTTP before
 * the marker exists, so the kill cannot land before the ack.
 */
async function waitForMarker(path: string, budgetMs = 20_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const stats = await stat(path);
      if (stats.isFile()) return (await readFile(path, "utf8")).trim();
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) throw new Error("the child never wrote its marker");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a walk committed before a SIGKILL survives, and so does the end after it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-multiplayer-kill-"));
  const stores = dataStores(dir);
  await stores.config.ensure();
  const createdAt = "2026-10-29T10:00:00.000Z";
  const alexToken = newToken();
  const samToken = newToken();
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  await stores.config.update((current) => ({
    ...current,
    members: [
      {
        id: "owner",
        role: "owner",
        displayName: "Alex",
        createdAt,
        sessions: [{ tokenHash: hashToken(alexToken), createdAt, expiresAt: expires }],
      },
      {
        id: "partner",
        role: "member",
        displayName: "Sam",
        createdAt,
        sessions: [{ tokenHash: hashToken(samToken), createdAt, expiresAt: expires }],
      },
    ],
  }));

  const marker = join(dir, "walk-ready");
  const childPath = fileURLToPath(new URL("../src/server/testing/walk-child.ts", import.meta.url));
  const child = spawn(process.execPath, [childPath, dir, marker, alexToken], {
    cwd: join(import.meta.dirname, ".."),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    const walkId = await waitForMarker(marker).catch((error) => {
      throw new Error(`${(error as Error).message}: ${stderr}`);
    });

    // The kill is the test: SIGKILL, no graceful close, no checkpoint. Capture
    // the exit promise before signalling so an already-dead child cannot hang
    // the suite.
    assert.equal(child.kill("SIGKILL"), true, "the child was alive to kill");
    const exit = await exited;
    assert.equal(exit.signal, "SIGKILL", `the child must die by SIGKILL (code ${exit.code}, stderr: ${stderr})`);

    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const started = await startApp(
      { dataDir: dir, host: "127.0.0.1", port: 0, models },
      { logger: createLogger({ scope: "test", sink: () => undefined }) },
    );
    assert.ok(started.ok, "the app restarts on the same data directory");
    const fixture: Fixture = {
      dir,
      app: started.app,
      url: started.app.url,
      alexCookie: alexToken,
      samCookie: samToken,
      setNow: () => {},
    };
    try {
      const walks = await getJson<{ open: Walk | null }>(fixture, "/api/walks", fixture.alexCookie);
      assert.equal(walks.open?.id, walkId, "the open walk survived the kill");
      assert.equal(walks.open?.startedBy, "owner");
      assert.equal(walks.open?.startedByLabel, "Alex");
      assert.equal((await started.app.app.snapshot(WalksDoc, context))?.walks.length, 1);

      const ended = await post(fixture, "/api/walks/end", "POST", fixture.samCookie, { walkId }, "end-after-kill");
      assert.equal(ended.status, 200, "the other caregiver can end it after the restart");
    } finally {
      await started.app.close();
    }

    // A third open proves the *end* is durable too, not just the start.
    const reopened = await startApp(
      { dataDir: dir, host: "127.0.0.1", port: 0, models },
      { logger: createLogger({ scope: "test", sink: () => undefined }) },
    );
    assert.ok(reopened.ok);
    try {
      const record = (await reopened.app.app.snapshot(WalksDoc, context))?.walks[0];
      assert.equal(record?.id, walkId);
      assert.ok(record?.endedAt, "the end written after the restart is durable");
      assert.equal(record?.endedByLabel, "Sam");
    } finally {
      await reopened.app.close();
    }
  } finally {
    child.kill("SIGKILL");
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- the stale walk and both resolutions ------------------------------------

test("a stale walk blocks a start until it is ended or discarded", async () => {
  const fixture = await startMultiplayerApp();
  try {
    const started = await post(fixture, "/api/walks/start", "POST", fixture.alexCookie, {}, "walk-1");
    assert.equal(started.status, 200);
    const { walk } = (await started.json()) as { walk: Walk };

    fixture.setNow(T0 + WALK_STALE_AFTER_MS + HOUR);
    const blocked = await post(fixture, "/api/walks/start", "POST", fixture.samCookie, {}, "walk-2");
    assert.equal(blocked.status, 409);
    assert.equal(((await blocked.json()) as { error: string }).error, "walk_stale");

    // Resolution one: end it (observations, server duration).
    const ended = await post(fixture, "/api/walks/end", "POST", fixture.samCookie, { walkId: walk.id, pee: 1 }, "end-1");
    assert.equal(ended.status, 200);
    const endedWalk = ((await ended.json()) as { walk: Walk }).walk;
    assert.equal(endedWalk.endedAt, new Date(T0 + WALK_STALE_AFTER_MS + HOUR).toISOString(), "the server stamps the end");
    assert.equal(endedWalk.endedByLabel, "Sam");
    assert.equal(endedWalk.pee, 1);
    // B ended it; A's next read sees the same closed record (G2 "both clients
    // see the same state" for the walk, not just the frame).
    const alexSees = await getJson<{ open: Walk | null }>(fixture, "/api/walks", fixture.alexCookie);
    assert.equal(alexSees.open, null);
    const alexWalks = await fixture.app.app.snapshot(WalksDoc, context);
    assert.equal(alexWalks?.walks.find((entry) => entry.id === walk.id)?.endedByLabel, "Sam");
    const afterEnd = await post(fixture, "/api/walks/start", "POST", fixture.samCookie, {}, "walk-3");
    assert.equal(afterEnd.status, 200, "ending resolves the block");

    // Resolution two: discard the next stale walk.
    const second = (await afterEnd.json()) as { walk: Walk };
    fixture.setNow(T0 + 2 * (WALK_STALE_AFTER_MS + HOUR));
    const discarded = await post(fixture, "/api/walks/discard", "POST", fixture.alexCookie, { walkId: second.walk.id }, "discard-1");
    assert.equal(discarded.status, 200);
    const discardedWalk = ((await discarded.json()) as { walk: Walk }).walk;
    assert.equal(discardedWalk.discarded, true, "the record says it was discarded");
    assert.equal(discardedWalk.pee, undefined, "a discard carries no observations");
    assert.equal((await post(fixture, "/api/walks/start", "POST", fixture.alexCookie, {}, "walk-4")).status, 200);
    assert.ok((await getJson<{ open: Walk | null }>(fixture, "/api/walks", fixture.alexCookie)).open);
    const history = await fixture.app.app.snapshot(WalksDoc, context);
    assert.equal(history?.walks.length, 3, "one ended, one discarded and one open: the discard is kept");
    assert.equal(history?.walks.filter((entry) => entry.discarded === true).length, 1);
  } finally {
    await stop(fixture);
  }
});

// --- both clients see the same state ---------------------------------------

test("a partner's stream receives a care frame for a feed and for a walk start", async () => {
  const fixture = await startMultiplayerApp();
  try {
    const response = await fetch(`${fixture.url}/api/agent/events`, {
      headers: { Cookie: cookieFor(fixture.samCookie) },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    await nextFrame(reader, (event) => event === "snapshot");

    const fed = await post(fixture, "/api/feeding/fed", "POST", fixture.alexCookie, feedBody("slot-b"), "live-feed");
    assert.equal(fed.status, 200);
    const feedFrame = await nextFrame(reader, (event) => event === "profile");
    const frame = feedFrame.data as { meals: { rev: number }; household: { timezone: string } };
    assert.equal(typeof frame.meals.rev, "number", "the care view, not a thread delta");

    // The frame is a re-read signal, not the data: Sam's own read must now show
    // the meal (the Today card does exactly this on a frame).
    const day = await getJson<{ slots: { slot: { id: string }; feed: FeedEvent | null }[] }>(
      fixture,
      "/api/feeding/day",
      fixture.samCookie,
    );
    assert.equal(day.slots.find((entry) => entry.slot.id === "slot-b")?.feed?.byLabel, "Alex");

    const walk = await post(fixture, "/api/walks/start", "POST", fixture.alexCookie, {}, "live-walk");
    assert.equal(walk.status, 200);
    const walkFrame = await nextFrame(reader, (event) => event === "profile");
    const profile = await getJson<{ household: { timezone: string } }>(fixture, "/api/puppy", fixture.samCookie);
    assert.equal(
      (walkFrame.data as { household: { timezone: string } }).household.timezone,
      profile.household.timezone,
      "the frame agrees with the care view Sam reads",
    );
    const walks = await getJson<{ open: Walk | null }>(fixture, "/api/walks", fixture.samCookie);
    assert.equal(walks.open?.startedByLabel, "Alex", "Sam's re-read shows the walk the frame announced");
    await reader.cancel();
  } finally {
    await stop(fixture);
  }
});

test("care writes bump no thread counter, so the long-poll fallback waits it out", async () => {
  const fixture = await startMultiplayerApp();
  try {
    const seq = fixture.app.threadBus?.seq ?? 0;
    // The invariant needs no wall-clock: care writes must leave the thread
    // counter alone, which is what a `since=seq` poll would be woken by.
    assert.equal((await post(fixture, "/api/feeding/fed", "POST", fixture.alexCookie, feedBody("slot-b"), "poll-feed")).status, 200);
    assert.equal((await post(fixture, "/api/walks/start", "POST", fixture.alexCookie, {}, "poll-walk")).status, 200);
    assert.equal(fixture.app.threadBus?.seq, seq, "care writes are not thread news");

    const response = await fetch(`${fixture.url}/api/agent/events/poll?since=${seq}&ms=600`, {
      headers: { Cookie: cookieFor(fixture.samCookie) },
    });
    assert.equal(response.status, 200);
    const snapshot = (await response.json()) as { entries: unknown[]; seq?: number };
    assert.ok(Array.isArray(snapshot.entries));
    assert.equal(fixture.app.threadBus?.seq, seq, "and the answer did not move it either");
  } finally {
    await stop(fixture);
  }
});
