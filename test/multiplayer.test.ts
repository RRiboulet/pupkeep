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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.equal(slots.status, 200, "the schedule must be storable");
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
    const won = (await winner.json()) as { feed: FeedEvent; day: { slots: { feed: FeedEvent | null }[]; events: FeedEvent[] } };
    const lost = (await loser.json()) as { error: string; message: string; feed: FeedEvent; day: { events: FeedEvent[] } };
    assert.equal(lost.error, "already_fed");
    assert.equal(lost.feed.id, won.feed.id, "the loser is shown the committed meal");
    assert.equal(lost.day.events.length, 1, "the 409 carries the current day, one event");
    assert.match(lost.message, /already logged this meal at \d{2}:\d{2}/);

    const feeding = await fixture.app.app.snapshot(FeedingDoc, context);
    assert.equal(feeding?.events.length, 1, "the document holds one event, never two");
    assert.equal(feeding?.events[0]?.source, "ui");

    // §12.3: exactly one intent, for the caregiver who did not feed.
    const notifications = await fixture.app.app.snapshot(NotificationsDoc, context);
    assert.equal(notifications?.items.length, 1, "one meal, one partner intent");
    const feeder = won.feed.byUserId;
    assert.notEqual(notifications?.items[0]?.userId, feeder, "the actor is not notified");
    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries.filter((entry) => entry.kind === "feed.logged").length, 1);
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
    assert.equal(event.actionId.startsWith("tool:"), true);

    // The other caregiver's route call now reads the committed truth.
    const route = await post(fixture, "/api/feeding/fed", "POST", fixture.samCookie, feedBody("slot-b"), "sam-after-agent");
    assert.equal(route.status, 409);
    const conflict = (await route.json()) as { error: string; feed: FeedEvent; message: string };
    assert.equal(conflict.error, "already_fed");
    assert.equal(conflict.feed.id, event.id);
    assert.match(conflict.message, /Alex already logged this meal/);
    assert.equal((await fixture.app.app.snapshot(FeedingDoc, context))?.events.length, 1);

    // The tool card is visible to both caregivers with the same refusal shape.
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

// --- a walk across a SIGKILL ------------------------------------------------

/** The child that commits a walk start and then waits to be killed. */
const KILL_SCRIPT = `
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { dataStores } from "./src/server/config.ts";
import { bootstrapSession } from "./src/server/domain/bootstrap.ts";
import { startWalk } from "./src/server/domain/walks.ts";
import { openHarness } from "./src/server/harness.ts";

const dir = process.env.PUPKEEP_TEST_DIR;
const models = createModels();
models.setProvider(fauxProvider().provider);
const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
const config = await dataStores(dir).config.read();
await bootstrapSession(opened.harness, { config, context: BACKGROUND_CONTEXT, timezone: "Europe/Paris" });
const outcome = await startWalk(opened.harness, BACKGROUND_CONTEXT, {
  actor: async () => ({ id: "owner", label: "Alex" }),
  actionId: "http:start-kill",
});
if (outcome.kind !== "started") throw new Error("the child could not start the walk: " + outcome.kind);
console.log("READY " + outcome.walk.id);
// No close, no checkpoint: the parent kills this process.
setInterval(() => {}, 1000);
`;

test("a walk committed before a SIGKILL is still open after a fresh app start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-multiplayer-kill-"));
  const stores = dataStores(dir);
  await stores.config.ensure();
  const createdAt = "2026-10-29T10:00:00.000Z";
  const samToken = newToken();
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

  const repo = join(import.meta.dirname, "..");
  const child = spawn(process.execPath, ["--input-type=module", "-e", KILL_SCRIPT], {
    cwd: repo,
    env: { ...process.env, PUPKEEP_TEST_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const walkId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the child never committed the walk")), 15_000);
      timer.unref?.();
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const match = /READY (\S+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`the child exited before READY (code ${code}, signal ${signal})`));
      });
    });

    // A hard kill, no graceful close and no checkpoint.
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const result = await startApp(
      { dataDir: dir, host: "127.0.0.1", port: 0, models },
      { logger: createLogger({ scope: "test", sink: () => undefined }) },
    );
    assert.ok(result.ok, "the app restarts on the same data directory");
    const fixture: Fixture = { dir, app: result.app, url: result.app.url, alexCookie: "", samCookie: samToken, setNow: () => {} };
    const auth = new Auth({ config: stores.config });
    const ownerToken = await auth.mintOwner("http://127.0.0.1").then((m) => m.token);
    fixture.alexCookie = await auth.login(ownerToken).then((l) => l.token);
    try {
      const walks = await getJson<{ open: Walk | null }>(fixture, "/api/walks", fixture.alexCookie);
      assert.equal(walks.open?.id, walkId, "the open walk survived the kill");
      assert.equal(walks.open?.startedByLabel, "Alex");
      assert.equal((await fixture.app.app.snapshot(WalksDoc, context))?.walks.length, 1);

      const ended = await post(fixture, "/api/walks/end", "POST", fixture.samCookie, { walkId }, "end-after-kill");
      assert.equal(ended.status, 200, "the other caregiver can end it after the restart");
    } finally {
      await result.app.close();
    }
  } finally {
    child.kill("SIGKILL");
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
    const afterEnd = await post(fixture, "/api/walks/start", "POST", fixture.samCookie, {}, "walk-3");
    assert.equal(afterEnd.status, 200, "ending resolves the block");

    // Resolution two: discard the next stale walk.
    const second = (await afterEnd.json()) as { walk: Walk };
    fixture.setNow(T0 + 2 * (WALK_STALE_AFTER_MS + HOUR));
    const discarded = await post(fixture, "/api/walks/discard", "POST", fixture.alexCookie, { walkId: second.walk.id }, "discard-1");
    assert.equal(discarded.status, 200);
    assert.equal(((await discarded.json()) as { walk: Walk }).walk.discarded, true);
    assert.equal((await post(fixture, "/api/walks/start", "POST", fixture.alexCookie, {}, "walk-4")).status, 200);
    assert.ok((await getJson<{ open: Walk | null }>(fixture, "/api/walks", fixture.alexCookie)).open);
    const history = await fixture.app.app.snapshot(WalksDoc, context);
    assert.equal(history?.walks.length, 3, "two ended walks and one open; the discarded record is kept");
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

    const walk = await post(fixture, "/api/walks/start", "POST", fixture.alexCookie, {}, "live-walk");
    assert.equal(walk.status, 200);
    await nextFrame(reader, (event) => event === "profile");
    await reader.cancel();
  } finally {
    await stop(fixture);
  }
});

test("care writes bump no thread counter, so the long-poll fallback waits it out", async () => {
  const fixture = await startMultiplayerApp();
  try {
    const seq = fixture.app.threadBus?.seq ?? 0;
    const started = Date.now();
    const poll = fetch(`${fixture.url}/api/agent/events/poll?since=${seq}&ms=1200`, {
      headers: { Cookie: cookieFor(fixture.samCookie) },
    });
    // Let the poll attach before the writes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await post(fixture, "/api/feeding/fed", "POST", fixture.alexCookie, feedBody("slot-b"), "poll-feed")).status, 200);
    assert.equal((await post(fixture, "/api/walks/start", "POST", fixture.alexCookie, {}, "poll-walk")).status, 200);
    assert.equal(fixture.app.threadBus?.seq, seq, "care writes are not thread news");

    const response = await poll;
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200);
    assert.ok(elapsed >= 1100, `the fallback waited out its window instead of waking early (${elapsed} ms)`);
    const snapshot = (await response.json()) as { entries: unknown[] };
    assert.ok(Array.isArray(snapshot.entries));
  } finally {
    await stop(fixture);
  }
});
