// The shared household thread over real HTTP and the real SQLite harness
// (PLAN §9.1–§9.4, §15.3): two caregivers, one conversation, busy 409 with no
// transcript entry, snapshots, SSE snapshot-then-deltas, the long-poll
// fallback, per-user connection caps, auth, rate limits and no cross-
// conversation leak. The model is Pi AI's faux provider; storage is the same
// `openHarness` stack the server uses, on a temp directory per test.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { SESSION_COOKIE, Auth, RateLimiter, hashToken, newToken } from "../src/server/auth.ts";
import {
  REQUEST_HEADER,
  REQUEST_HEADER_VALUE,
  SIGNIN_LIMIT,
  SUBMIT_LIMIT,
  createAppHandler,
} from "../src/server/http.ts";
import { ThreadBus, type Subscriber } from "../src/server/agent/bus.ts";
import { dataStores } from "../src/server/config.ts";
import { createLogger } from "../src/server/log.ts";
import { listenHttp, startApp, type AppHandle } from "../src/server/app.ts";
import { PROBE_CACHE_VERSION } from "../src/server/models/cache.ts";
import { HouseholdDoc } from "../src/server/domain/docs.ts";
import type { TranscriptEntry, ThreadSnapshot } from "../src/shared/chat.ts";

// The configured default model of PLAN §11.2, as the P1-03 probe would cache it.
const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_MODEL = "mimo-v2.6-flash";

type ResponseStep = AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

interface Fixture {
  dir: string;
  app: AppHandle;
  url: string;
  faux: ReturnType<typeof fauxProvider>;
  alexCookie: string;
  samCookie: string;
  /** Queue more answers for runs the first ones; a factory may hold a run. */
  appendResponses: (steps: readonly ResponseStep[]) => void;
  /** The fixture's own Auth, for minting credentials the HTTP routes exchange. */
  auth: Auth;
}

const ALWAYS: () => AssistantMessage = () => fauxAssistantMessage("Done.");

/** Wait until `probe` succeeds or the budget expires; runs are async things. */
async function until<T>(probe: () => T | undefined | Promise<T | undefined>, budgetMs = 5000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Index with a real value: the suite reads lists it just built. */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  assert.ok(value !== undefined);
  return value;
}

async function startThread(
  options: {
    /** Answers runs consume, in order; an unresolved factory holds the thread busy. */
    responses?: readonly ResponseStep[];
    /** Seed models.json with a live probe result so the default model attaches. */
    probeCache?: boolean;
    /** Seed only the owner, so the invite tests grow the household by one. */
    ownerOnly?: boolean;
  } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-thread-"));
  const faux = fauxProvider({ provider: DEFAULT_PROVIDER, models: [{ id: DEFAULT_MODEL }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const stores = dataStores(dir);
  await stores.config.ensure();
  // Both profiles present at the boot that creates the thread: the household
  // document is only reconciled at boot (P1-08), so the member joins the
  // roster before the server starts. Sam's session row is planted the way
  // `acceptInvite()` would plant it: a hash, never the token itself.
  // `ownerOnly` gives the invite tests a one-member household to grow.
  const samToken = newToken();
  const now = "2026-10-29T10:00:00.000Z";
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  await stores.config.update((config) => ({
    ...config,
    members: options.ownerOnly
      ? [
          {
            id: "owner",
            role: "owner",
            displayName: "Alex",
            createdAt: now,
            sessions: [],
          },
        ]
      : [
          {
            id: "owner",
            role: "owner",
            displayName: "Alex",
            createdAt: now,
            sessions: [],
          },
          {
            id: "m-sam-fixture",
            role: "member",
            displayName: "Sam",
            createdAt: now,
            sessions: [{ tokenHash: hashToken(samToken), createdAt: now, expiresAt: expires }],
          },
        ],
  }));
  if (options.probeCache) {
    await stores.models.update(() => ({
      version: PROBE_CACHE_VERSION,
      checkedAt: new Date().toISOString(),
      results: [
        {
          id: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
          provider: DEFAULT_PROVIDER,
          model: DEFAULT_MODEL,
          status: "ok",
          toolCall: true,
          latencyMs: 5,
          checkedAt: new Date().toISOString(),
        },
      ],
    }));
  }

  const result = await startApp(
    { dataDir: dir, host: "127.0.0.1", port: 0, models },
    { logger: createLogger({ scope: "test", sink: () => undefined }) },
  );
  assert.ok(result.ok, "the app must start with the shared thread wired");
  const app = result.app;
  faux.setResponses((options.responses ?? [ALWAYS()]) as ResponseStep[]);

  // The owner signs in like a browser; Sam already has her session row.
  const auth = new Auth({ config: stores.config });
  const ownerToken = await auth.mintOwner("http://127.0.0.1").then((minted) => minted.token);
  const alexCookie = await auth.login(ownerToken).then((login) => login.token);
  const samCookie = samToken;

  return {
    dir,
    app,
    url: app.url,
    faux,
    alexCookie,
    samCookie,
    appendResponses: (steps) => faux.appendResponses([...steps]),
    auth,
  };
}

async function stop(fixture: Fixture): Promise<void> {
  await fixture.app.close();
  await rm(fixture.dir, { recursive: true, force: true });
}

function cookieFor(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

async function postMessage(
  fixture: Fixture,
  cookieToken: string,
  text: string,
  clientMessageId: string,
  extra: { omitOrigin?: boolean } = {},
): Promise<Response> {
  return fetch(`${fixture.url}/api/agent/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      Cookie: cookieFor(cookieToken),
      // A browser mutation always carries Origin; tests are explicit so a
      // missing-Origin 403 cannot be confused with an auth refusal.
      ...(extra.omitOrigin ? {} : { Origin: fixture.url }),
    },
    body: JSON.stringify({ text, clientMessageId }),
  });
}

async function threadOf(fixture: Fixture, cookieToken: string): Promise<ThreadSnapshot> {
  const response = await fetch(`${fixture.url}/api/agent/thread`, {
    headers: { Cookie: cookieFor(cookieToken) },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as ThreadSnapshot;
}

async function householdOf(fixture: Fixture) {
  const household = await fixture.app.app.snapshot(HouseholdDoc, BACKGROUND_CONTEXT);
  assert.ok(household, "the app bootstrapped the household document");
  return household;
}

// --- SSE frames -------------------------------------------------------------

interface Frame {
  event: string;
  data: unknown;
}

async function* framesOf(response: Response): AsyncGenerator<Frame> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) break;
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (event !== undefined) {
        yield { event, data: data === undefined ? undefined : JSON.parse(data) };
      }
    }
  }
}

const NO_FRAME = Symbol("no frame");

/** One frame with a wall-clock budget; a stream that has closed is not a frame. */
async function nextFrame(iterator: AsyncGenerator<Frame>, budgetMs = 5000): Promise<Frame> {
  const pull = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("the SSE stream ended");
      return next.value;
    }
  })();
  const timeout: Promise<typeof NO_FRAME> = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(NO_FRAME), budgetMs);
    timer.unref?.();
  });
  const value = await Promise.race([pull, timeout]);
  if (value === NO_FRAME) throw new Error("no SSE frame in time");
  return value;
}

async function openEvents(fixture: Fixture, cookieToken: string): Promise<AsyncGenerator<Frame>> {
  const response = await fetch(`${fixture.url}/api/agent/events`, {
    headers: { Cookie: cookieFor(cookieToken) },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  return framesOf(response);
}

async function longPoll(
  fixture: Fixture,
  cookieToken: string,
  since: number,
  budgetMs = 5000,
): Promise<Response> {
  return fetch(`${fixture.url}/api/agent/events/poll?since=${since}&ms=${budgetMs}`, {
    headers: { Cookie: cookieFor(cookieToken) },
  });
}

/**
 * A minimal fanout for ordering tests: `commit()` bumps the seq and notifies
 * whoever is subscribed *now*, so a test can prove when the SSE handler attached.
 */
function fakeBus(): { bus: ThreadBus; commit: () => number } {
  let seq = 0;
  const subscribers = new Set<Subscriber>();
  const bus = {
    get seq(): number {
      return seq;
    },
    get closed(): boolean {
      return false;
    },
    subscribe(_userId: string, subscriber: Subscriber): () => void {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  } as unknown as ThreadBus;
  return {
    bus,
    commit: () => {
      seq += 1;
      for (const subscriber of [...subscribers]) subscriber.notice("batch", []);
      return seq;
    },
  };
}

// --- tests ------------------------------------------------------------------

test("two caregivers submit into one thread; each reply is attributed to the latest speaker", async () => {
  const fixture = await startThread();
  try {
    const first = await postMessage(fixture, fixture.alexCookie, "Walked Biscuit this morning", "m-alex-1");
    assert.equal(first.status, 202);
    const firstBody = (await first.json()) as { accepted: boolean; submissionId: number };
    assert.equal(firstBody.accepted, true);

    // Sam writes only after Alex's run ended: v1 is one-at-a-time, not a queue.
    await until(async () => {
      const snapshot = await threadOf(fixture, fixture.alexCookie);
      const replies = snapshot.entries.filter((entry) => entry.kind === "assistant");
      return replies.length === 1 ? true : undefined;
    });
    // The faux provider's answers are a queue; a second run needs a second one.
    fixture.appendResponses([ALWAYS()]);
    const second = await postMessage(fixture, fixture.samCookie, "Did he drink water?", "m-sam-1");
    assert.equal(second.status, 202);
    await until(async () => {
      const snapshot = await threadOf(fixture, fixture.alexCookie);
      const replies = snapshot.entries.filter((entry) => entry.kind === "assistant");
      return replies.length >= 2 ? true : undefined;
    });

    const snapshot = await threadOf(fixture, fixture.alexCookie);
    const chats = snapshot.entries.filter(
      (entry): entry is Extract<TranscriptEntry, { kind: "chat" }> => entry.kind === "chat",
    );
    assert.equal(chats.length, 2);
    const alexMessage = at(chats, 0) as Extract<TranscriptEntry, { kind: "chat" }>;
    const samMessage = at(chats, 1) as Extract<TranscriptEntry, { kind: "chat" }>;
    assert.equal(alexMessage.authorId, "owner");
    assert.equal(alexMessage.authorName, "Alex");
    assert.equal(alexMessage.text, "Walked Biscuit this morning");
    assert.equal(alexMessage.clientMessageId, "m-alex-1");
    assert.notEqual(samMessage.authorId, null);
    assert.equal(samMessage.authorName, "Sam", "labels resolve through the household profiles");
    assert.equal(samMessage.text, "Did he drink water?");
    assert.equal(samMessage.clientMessageId, "m-sam-1");

    // §9.2: the latest placed `app.chat` before an assistant entry is its author.
    const replies = snapshot.entries.filter(
      (entry): entry is Extract<TranscriptEntry, { kind: "assistant" }> => entry.kind === "assistant",
    );
    assert.equal(at(replies, 0).authorName, "Alex");
    assert.equal(at(replies, 1).authorName, "Sam");
    assert.notEqual(at(replies, 0).entryId, at(replies, 1).entryId);
  } finally {
    await stop(fixture);
  }
});

test("a busy thread rejects with a friendly 409 and no transcript entry", async () => {
  let release!: (message: AssistantMessage) => void;
  const held: ResponseStep = () =>
    new Promise<AssistantMessage>((resolve) => {
      release = resolve;
    });
  const fixture = await startThread({ responses: [held] });
  try {
    const first = await postMessage(fixture, fixture.alexCookie, "Book the groomer", "m-hold-1");
    assert.equal(first.status, 202);

    // Wait until the thread is genuinely busy (the answer is still pending).
    await until(async () => {
      const snapshot = await threadOf(fixture, fixture.alexCookie);
      return snapshot.status.busy ? true : undefined;
    });

    const rejected = await postMessage(fixture, fixture.samCookie, "Also add a groomer note", "m-reject-1");
    assert.equal(rejected.status, 409);
    const body = (await rejected.json()) as { error: string; message: string };
    assert.equal(body.error, "busy");
    assert.match(body.message, /keep your draft/);

    const before = (await threadOf(fixture, fixture.alexCookie)).entries.length;
    release(fauxAssistantMessage("Groomer booked."));
    await until(async () => {
      const snapshot = await threadOf(fixture, fixture.alexCookie);
      return !snapshot.status.busy && snapshot.entries.some((entry) => entry.kind === "assistant")
        ? true
        : undefined;
    });
    const after = (await threadOf(fixture, fixture.alexCookie)).entries.length;
    assert.equal(after, before + 1, "only the answer lands");
    const texts = (await threadOf(fixture, fixture.alexCookie)).entries
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "chat" }> => entry.kind === "chat")
      .map((entry) => entry.text);
    assert.equal(texts.includes("Also add a groomer note"), false, "a rejected input never enters the transcript");
  } finally {
    await stop(fixture);
  }
});

test("a duplicate clientMessageId returns the same submission and one entry", async () => {
  const fixture = await startThread();
  try {
    const first = await postMessage(fixture, fixture.alexCookie, "One message", "m-dup");
    const second = await postMessage(fixture, fixture.alexCookie, "One message", "m-dup");
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const firstBody = (await first.json()) as { submissionId: number };
    const secondBody = (await second.json()) as { submissionId: number };
    assert.equal(firstBody.submissionId, secondBody.submissionId);
    await until(async () => {
      const snapshot = await threadOf(fixture, fixture.alexCookie);
      return snapshot.entries.some((entry) => entry.kind === "assistant") ? true : undefined;
    });
    const snapshot = await threadOf(fixture, fixture.alexCookie);
    assert.equal(snapshot.entries.filter((entry) => entry.kind === "chat").length, 1);
  } finally {
    await stop(fixture);
  }
});

test("two caregivers may reuse a clientMessageId; the dedupe key is namespaced per author", async () => {
  const fixture = await startThread();
  try {
    const first = await postMessage(fixture, fixture.alexCookie, "Alex's note", "shared-client-id");
    assert.equal(first.status, 202);
    const firstBody = (await first.json()) as { submissionId: number };

    await until(async () => {
      const snapshot = await threadOf(fixture, fixture.alexCookie);
      return snapshot.entries.some((entry) => entry.kind === "assistant") ? true : undefined;
    });
    fixture.appendResponses([ALWAYS()]);

    const second = await postMessage(fixture, fixture.samCookie, "Sam's note", "shared-client-id");
    assert.equal(second.status, 202);
    const secondBody = (await second.json()) as { submissionId: number };
    assert.notEqual(
      firstBody.submissionId,
      secondBody.submissionId,
      "Sam's submit is not deduped against Alex's identical client id",
    );
    await until(async () => {
      const snapshot = await threadOf(fixture, fixture.alexCookie);
      return snapshot.entries.filter((entry) => entry.kind === "assistant").length >= 2 ? true : undefined;
    });

    const snapshot = await threadOf(fixture, fixture.alexCookie);
    const chats = snapshot.entries
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "chat" }> => entry.kind === "chat")
      .map((entry) => ({ author: entry.authorName, text: entry.text, clientId: entry.clientMessageId }));
    assert.deepEqual(chats, [
      { author: "Alex", text: "Alex's note", clientId: "shared-client-id" },
      { author: "Sam", text: "Sam's note", clientId: "shared-client-id" },
    ]);
  } finally {
    await stop(fixture);
  }
});

test("SSE sends the full snapshot at attach, then deltas; a fresh attach starts from a snapshot again", async () => {
  const fixture = await startThread();
  try {
    const posted = await postMessage(fixture, fixture.alexCookie, "Ping", "m-sse-1");
    assert.equal(posted.status, 202);
    await until(async () => {
      const snapshot = await threadOf(fixture, fixture.alexCookie);
      return snapshot.entries.some((entry) => entry.kind === "assistant") ? true : undefined;
    });

    const live = await openEvents(fixture, fixture.alexCookie);
    const snapshotFrame = await nextFrame(live);
    assert.equal(snapshotFrame.event, "snapshot");
    const attached = snapshotFrame.data as ThreadSnapshot;
    assert.equal(
      attached.entries.some((entry) => entry.kind === "chat" && entry.text === "Ping"),
      true,
    );
    assert.equal(attached.status !== undefined, true);
    const attachedSeq = attached.seq;

    // A delta arrives while the connection is open.
    fixture.appendResponses([ALWAYS()]);
    const second = await postMessage(fixture, fixture.alexCookie, "Second ping", "m-sse-2");
    assert.equal(second.status, 202);
    await until(async () => {
      const snapshot = await threadOf(fixture, fixture.alexCookie);
      return snapshot.entries.filter((entry) => entry.kind === "assistant").length >= 2 ? true : undefined;
    });
    const batch = await nextFrame(live);
    assert.equal(batch.event, "batch");
    const batchBody = batch.data as { seq: number; events: Array<{ type: string }> };
    assert.equal(batchBody.seq > attachedSeq, true, "batches carry the seq the snapshot used");
    const eventTypes = batchBody.events.map((event) => event.type);
    assert.equal(
      eventTypes.some((type) => type === "entry_appended" || type === "message_end" || type === "submission"),
      true,
      `the batch holds the thread's own events: ${JSON.stringify(eventTypes)}`,
    );

    // A reconnect is not a resume: the full snapshot comes again, with
    // everything that landed since the interruption.
    const again = await openEvents(fixture, fixture.alexCookie);
    const reSnapshot = await nextFrame(again);
    assert.equal(reSnapshot.event, "snapshot");
    const reAttached = reSnapshot.data as ThreadSnapshot;
    assert.equal(reAttached.seq > attachedSeq, true);
    assert.equal(
      reAttached.entries.some((entry) => entry.kind === "chat" && entry.text === "Second ping"),
      true,
    );
  } finally {
    await stop(fixture);
  }
});

test("SSE subscribes before the snapshot read, so a commit during the read is queued as a delta", async () => {
  const fixture = await startThread();
  const { bus, commit } = fakeBus();
  let origin = "";
  let attachedSeq = 0;
  const deps = {
    auth: fixture.auth,
    thread: { harness: fixture.app.app, context: BACKGROUND_CONTEXT },
    bus,
    submitLimiter: new RateLimiter(SUBMIT_LIMIT, 60_000),
    signInLimiter: new RateLimiter(SIGNIN_LIMIT, 60_000),
    allowedOrigins: () => (origin === "" ? [] : [origin]),
    logger: createLogger({ scope: "test", sink: () => undefined }),
    // The deterministic interleaving: the read returns a snapshot from seq 0,
    // then a commit broadcasts before the handler can write that snapshot.
    // Only a handler that subscribed first still holds the delta.
    readSnapshot: async (): Promise<ThreadSnapshot> => {
      attachedSeq = bus.seq;
      const snapshot: ThreadSnapshot = {
        conversationId: 1,
        seq: attachedSeq,
        status: { busy: false, queued: 0 },
        entries: [],
      };
      commit();
      return snapshot;
    },
  };
  const gate = await listenHttp("127.0.0.1", 0, createAppHandler(deps));
  origin = gate.url;
  try {
    const response = await fetch(`${gate.url}/api/agent/events`, {
      headers: { Cookie: cookieFor(fixture.alexCookie) },
    });
    assert.equal(response.status, 200);
    const frames = framesOf(response);
    const snapshotFrame = await nextFrame(frames);
    assert.equal(snapshotFrame.event, "snapshot");
    assert.equal((snapshotFrame.data as ThreadSnapshot).seq, attachedSeq);

    const delta = await nextFrame(frames, 3000);
    assert.equal(delta.event, "batch", "the commit during the snapshot read is not lost");
    assert.equal((delta.data as { seq: number }).seq, attachedSeq + 1);
  } finally {
    await gate.close();
    await stop(fixture);
  }
});

test("a delta the snapshot's counter already covers is not replayed", async () => {
  const fixture = await startThread();
  const { bus, commit } = fakeBus();
  let origin = "";
  const deps = {
    auth: fixture.auth,
    thread: { harness: fixture.app.app, context: BACKGROUND_CONTEXT },
    bus,
    submitLimiter: new RateLimiter(SUBMIT_LIMIT, 60_000),
    signInLimiter: new RateLimiter(SIGNIN_LIMIT, 60_000),
    allowedOrigins: () => (origin === "" ? [] : [origin]),
    logger: createLogger({ scope: "test", sink: () => undefined }),
    // The other side of the attach race: the commit lands during the read and
    // the snapshot returned for it already carries the new counter, so the
    // queued batch is a duplicate and must not be replayed.
    readSnapshot: async (): Promise<ThreadSnapshot> => {
      const seq = commit();
      return { conversationId: 1, seq, status: { busy: false, queued: 0 }, entries: [] };
    },
  };
  const gate = await listenHttp("127.0.0.1", 0, createAppHandler(deps));
  origin = gate.url;
  try {
    const response = await fetch(`${gate.url}/api/agent/events`, {
      headers: { Cookie: cookieFor(fixture.alexCookie) },
    });
    assert.equal(response.status, 200);
    const frames = framesOf(response);
    const snapshotFrame = await nextFrame(frames);
    assert.equal(snapshotFrame.event, "snapshot");
    assert.equal((snapshotFrame.data as ThreadSnapshot).seq, 1);
    // Nothing follows: the recovered batch is inside the snapshot, so a client
    // applying deltas idempotently never sees the entry twice.
    await assert.rejects(nextFrame(frames, 400), /no SSE frame in time/);
  } finally {
    await gate.close();
    await stop(fixture);
  }
});

test("a new SSE attach after the stream ended answers 503, not heartbeats forever", async () => {
  const fixture = await startThread();
  try {
    const bus = fixture.app.threadBus;
    assert.ok(bus, "the shared-thread wiring exposes its fanout");
    bus.stop();
    assert.equal(bus.closed, true);

    const response = await fetch(`${fixture.url}/api/agent/events`, {
      headers: { Cookie: cookieFor(fixture.alexCookie) },
    });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /stream ended|reconnect/);
  } finally {
    await stop(fixture);
  }
});

test("/healthz answers before any session lookup, so a probe cookie cannot read config", async () => {
  const fixture = await startThread();
  const { bus } = fakeBus();
  let origin = "";
  let sessionLookups = 0;
  const deps = {
    auth: {
      authenticate: async (token: string) => {
        sessionLookups += 1;
        return fixture.auth.authenticate(token);
      },
    } as unknown as Auth,
    thread: { harness: fixture.app.app, context: BACKGROUND_CONTEXT },
    bus,
    submitLimiter: new RateLimiter(SUBMIT_LIMIT, 60_000),
    signInLimiter: new RateLimiter(SIGNIN_LIMIT, 60_000),
    allowedOrigins: () => (origin === "" ? [] : [origin]),
    logger: createLogger({ scope: "test", sink: () => undefined }),
  };
  const gate = await listenHttp("127.0.0.1", 0, createAppHandler(deps));
  origin = gate.url;
  try {
    const response = await fetch(`${gate.url}/healthz`, {
      headers: { Cookie: `${SESSION_COOKIE}=not-a-session` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(sessionLookups, 0, "liveness never parses config or walks sessions");
  } finally {
    await gate.close();
    await stop(fixture);
  }
});

test("the long-poll fallback answers with full snapshots — never deltas", async () => {
  const fixture = await startThread();
  try {
    const baseline = await threadOf(fixture, fixture.alexCookie);

    // Something already changed since the client's seq: an immediate full answer.
    const quick = await longPoll(fixture, fixture.alexCookie, Math.max(0, baseline.seq - 1), 500);
    assert.equal(quick.status, 200);
    const quickBody = (await quick.json()) as ThreadSnapshot;
    assert.equal(Array.isArray(quickBody.entries), true);
    assert.equal(quickBody.seq > baseline.seq - 1, true);

    // Nothing has changed yet: the poll waits, then answers in full when a
    // broadcast lands.
    const waiter = longPoll(fixture, fixture.alexCookie, baseline.seq, 3000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const posted = await postMessage(fixture, fixture.alexCookie, "Wake the poller", "m-poll-1");
    assert.equal(posted.status, 202);
    const woken = await waiter;
    assert.equal(woken.status, 200);
    const wokenBody = (await woken.json()) as ThreadSnapshot;
    assert.equal(wokenBody.seq > baseline.seq, true);
    assert.equal(
      wokenBody.entries.some((entry) => entry.kind === "chat" && entry.text === "Wake the poller"),
      true,
      "the fallback returns a snapshot that includes the new message",
    );
  } finally {
    await stop(fixture);
  }
});

test("SSE connections are capped per user; the oldest drops politely, one at a time", async () => {
  const fixture = await startThread();
  const CAP = 4; // THREAD_CONNECTIONS_PER_USER
  try {
    const iterators: AsyncGenerator<Frame>[] = [];
    for (let index = 0; index < CAP; index += 1) {
      iterators.push(await openEvents(fixture, fixture.alexCookie));
      assert.equal((await nextFrame(at(iterators, index))).event, "snapshot");
    }
    // One more than the cap: the newest browser wins, the oldest receives a
    // reconnect instead of a silent hang.
    iterators.push(await openEvents(fixture, fixture.alexCookie));
    assert.equal((await nextFrame(at(iterators, CAP))).event, "snapshot");

    const dropped = await nextFrame(at(iterators, 0), 3000);
    assert.equal(dropped.event, "reconnect", "the oldest connection is the one dropped");

    // The surviving current client still streams the next delta.
    const monitor = at(iterators, CAP);
    const posted = await postMessage(fixture, fixture.alexCookie, "Through the cap", "m-cap-1");
    assert.equal(posted.status, 202);
    await until(async () => {
      const snapshot = await threadOf(fixture, fixture.alexCookie);
      return snapshot.entries.filter((entry) => entry.kind === "assistant").length >= 1 ? true : undefined;
    });
    const batch = await nextFrame(monitor, 3000);
    assert.notEqual(batch.event, "reconnect");
  } finally {
    await stop(fixture);
  }
});

test("a poll is bound by the same per-user connection cap", async () => {
  const fixture = await startThread();
  const CAP = 4;
  try {
    const baseline = await threadOf(fixture, fixture.alexCookie);
    const polls: Promise<Response>[] = [];
    for (let index = 0; index < CAP; index += 1) {
      polls.push(longPoll(fixture, fixture.alexCookie, baseline.seq, 800));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The fifth hold evicts the first, whose wait settles like an ended stream
    // instead of hanging out its clock; the rest answer with snapshots.
    const fifth = longPoll(fixture, fixture.alexCookie, baseline.seq, 800);
    const results = await Promise.all([...polls, fifth]);
    for (const response of results) {
      assert.notEqual(response.status, 404);
    }
    for (const response of results) {
      if (response.status === 200) {
        const body = (await response.json()) as ThreadSnapshot;
        assert.equal(Array.isArray(body.entries), true);
      } else {
        const body = (await response.json()) as { error?: string };
        assert.match(body.error ?? "", /reconnect|thread stream ended/);
      }
    }
  } finally {
    await stop(fixture);
  }
});

test("a throwing subscriber is evicted without aborting the fan-out", async () => {
  const fixture = await startThread();
  try {
    const bus = fixture.app.threadBus;
    assert.ok(bus, "the shared-thread wiring exposes its fanout");
    let goodBatches = 0;
    let badCalls = 0;
    const badUnsub = bus.subscribe("m-sam-fixture", {
      notice: () => {
        badCalls += 1;
        throw new Error("the socket is gone");
      },
      onClose: () => undefined,
    });
    const goodUnsub = bus.subscribe("owner", {
      notice: (type) => {
        if (type === "batch") goodBatches += 1;
      },
      onClose: () => undefined,
    });
    try {
      const posted = await postMessage(fixture, fixture.alexCookie, "Fan out past a broken socket", "m-fanout");
      assert.equal(posted.status, 202);
      await until(() => (goodBatches > 0 ? true : undefined));
      assert.equal(badCalls >= 1, true, "the broken subscriber was called first");
    } finally {
      badUnsub();
      goodUnsub();
    }
  } finally {
    await stop(fixture);
  }
});

test("a long-poll's timer is disarmed when the stream closes", async () => {
  const fixture = await startThread();
  try {
    let handle: NodeJS.Timeout | undefined;
    const bus = new ThreadBus({
      harness: fixture.app.app,
      conversationId: 1,
      context: BACKGROUND_CONTEXT,
      setTimer: (callback, ms) => {
        handle = setTimeout(callback, ms);
        handle.unref?.();
        return handle;
      },
    });
    const waiting = bus.poll("owner", 0, 60_000);
    const armed = handle as (NodeJS.Timeout & { _destroyed?: boolean }) | undefined;
    assert.ok(armed);
    assert.equal(armed._destroyed, false);

    bus.stop();
    assert.equal(await waiting, "closed");
    assert.equal(armed._destroyed, true, "the closed path clears the wait timer");
    assert.equal(bus.waiterCount, 0);
  } finally {
    await stop(fixture);
  }
});

test("another conversation's entries never appear in the thread or its events", async () => {
  const fixture = await startThread();
  try {
    const live = await openEvents(fixture, fixture.alexCookie);
    assert.equal((await nextFrame(live)).event, "snapshot");

    const household = await householdOf(fixture);
    const foreign = await fixture.app.app.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    await fixture.app.app.commit(
      async (tx: Tx) => {
        await tx.appendEntry(foreign.id, {
          kind: "app.chat",
          data: {
            authorId: "owner",
            authorName: "Alex",
            text: "FOREIGN-ENTRY",
            clientMessageId: "m-foreign",
          },
        });
      },
      BACKGROUND_CONTEXT,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const snapshot = await threadOf(fixture, fixture.alexCookie);
    assert.equal(snapshot.conversationId, household.conversationId);
    assert.equal(
      snapshot.entries.some(
        (entry) => entry.kind === "chat" && (entry as { text?: string }).text === "FOREIGN-ENTRY",
      ),
      false,
      "the household snapshot stays the household's transcript",
    );
  } finally {
    // The only later event the household thread would produce is a submission,
    // which this test never makes: a foreign write cannot reach either channel.
    await stop(fixture);
  }
});

test("auth: no session is 401, a member may read and write, and a mutation without Origin is refused", async () => {
  const fixture = await startThread();
  try {
    const noSession = await fetch(`${fixture.url}/api/agent/thread`);
    assert.equal(noSession.status, 401);

    const junk = await fetch(`${fixture.url}/api/agent/thread`, {
      headers: { Cookie: `${SESSION_COOKIE}=not-a-session` },
    });
    assert.equal(junk.status, 401);

    const memberRead = await fetch(`${fixture.url}/api/agent/thread`, {
      headers: { Cookie: cookieFor(fixture.samCookie) },
    });
    assert.equal(memberRead.status, 200, "a member is within the household scope");

    const ownerPost = await postMessage(fixture, fixture.alexCookie, "Owner asks", "m-o-1", { omitOrigin: true });
    assert.equal(ownerPost.status, 403, "a mutation needs a served origin, not only a session");

    const memberPost = await postMessage(fixture, fixture.samCookie, "Member asks", "m-o-2");
    assert.equal(memberPost.status, 202);

    const events = await fetch(`${fixture.url}/api/agent/events`);
    assert.equal(events.status, 401, "SSE needs the session too");
    const poll = await longPoll(fixture, "not-a-session", 0, 300);
    assert.equal(poll.status, 401);
  } finally {
    await stop(fixture);
  }
});

test("the submit rate limit answers 429 instead of flooding the thread with clicks", async () => {
  const fixture = await startThread();
  try {
    let sawLimit = false;
    let last: Response | undefined;
    for (let index = 0; index < SUBMIT_LIMIT + 1; index += 1) {
      // A repeated client id dedupes downstream, but the HTTP limiter counts
      // attempts — exactly the click-storm protection.
      last = await postMessage(fixture, fixture.alexCookie, "Too many clicks", "m-limit");
      if (last.status === 429) {
        sawLimit = true;
        break;
      }
    }
    assert.equal(sawLimit, true);
    assert.equal(last!.status, 429);
  } finally {
    await stop(fixture);
  }
});

test("the thread is configured with the §9.5 instructions and the default model; the system thread stays model-less", async () => {
  const fixture = await startThread({ probeCache: true });
  try {
    const snapshot = await threadOf(fixture, fixture.alexCookie);
    assert.equal(snapshot.model, `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`);

    const household = await householdOf(fixture);
    const shared = await fixture.app.app.conversation(household.conversationId as ConversationId, BACKGROUND_CONTEXT);
    assert.ok(shared);
    const agent = await shared.agent(BACKGROUND_CONTEXT);
    assert.match(agent.instructions ?? "", /household operator/);
    assert.match(agent.instructions ?? "", /shared thread for two caregivers/);
    assert.match(agent.instructions ?? "", /Never ask for or reveal/);

    const hidden = await fixture.app.app.conversation(household.systemConversationId as ConversationId, BACKGROUND_CONTEXT);
    assert.ok(hidden);
    assert.equal((await hidden.agent(BACKGROUND_CONTEXT)).model, undefined, "the system thread keeps no model");
  } finally {
    await stop(fixture);
  }
});

test("model tool calls surface as attributed tool cards in the snapshot", async () => {
  const fixture = await startThread({
    // The first run's answer is the tool call; the second closes the round.
    responses: [
      fauxAssistantMessage([fauxToolCall("log_feeding", { slotId: "breakfast" })], { stopReason: "toolUse" }),
      ALWAYS(),
    ],
  });
  try {
    const posted = await postMessage(fixture, fixture.alexCookie, "Feed Biscuit", "m-tool-1");
    assert.equal(posted.status, 202);
    await until(async () => {
      const snapshot = await threadOf(fixture, fixture.alexCookie);
      return snapshot.entries.some((entry) => entry.kind === "tool") ? true : undefined;
    });
    const card = (
      (await threadOf(fixture, fixture.alexCookie)).entries.find((entry) => entry.kind === "tool") as {
        toolName: string;
        status: string;
        text: string;
        byUserId: string | null;
        byLabel: string;
        toolCallId: string;
      }
    );
    assert.equal(card.toolName, "log_feeding");
    // No care tool is registered until P1-11, so the harness answers the
    // model's call with its unavailable diagnostic — and the card still shows.
    assert.equal(card.status, "error");
    assert.match(card.text, /not available/);
    assert.equal(card.byUserId, "owner", "the card names who asked");
    assert.equal(card.byLabel, "Alex", "the label resolves through the household profile");
    assert.notEqual(card.toolCallId, "");
  } finally {
    await stop(fixture);
  }
});

test("a chat entry from an unknown author normalizes to the household fallback, never undefined", async () => {
  const fixture = await startThread();
  try {
    const household = await householdOf(fixture);
    const sharedId = household.conversationId as ConversationId;
    // A direct write stands in for an entry whose author left the household.
    await fixture.app.app.commit(
      async (tx: Tx) => {
        await tx.appendEntry(sharedId, {
          kind: "app.chat",
          data: {
            authorId: "m-gone",
            authorName: "Former member",
            text: "old note",
            clientMessageId: "m-gone-1",
          },
        });
      },
      BACKGROUND_CONTEXT,
    );
    const snapshot = await threadOf(fixture, fixture.alexCookie);
    const chat = snapshot.entries.find((entry) => entry.kind === "chat" && entry.text === "old note") as {
      authorId: string | null;
      authorName: string;
    };
    assert.equal(chat.authorId, "m-gone", "the id stays so a later profile may attribute it");
    assert.equal(chat.authorName, "Household", "the label falls back, and is never undefined");
  } finally {
    await stop(fixture);
  }
});

// --- over-HTTP sign-in, invites, logout (the routes P1-06 mapped to here) ----

function firstCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = /pupkeep_session=([^;]*)/.exec(header)?.[1];
  assert.ok(value !== undefined && value !== "", "the response sets a session cookie");
  return value;
}

function sessionOfCookie(cookieToken: string): string {
  return `${SESSION_COOKIE}=${cookieToken}`;
}

test("the owner link signs a browser in over HTTP; anything else is a refusal", async () => {
  const fixture = await startThread();
  try {
    const ownerToken = await fixture.auth.mintOwner("http://127.0.0.1").then((minted) => minted.token);
    // A wrong token cannot be told from an exhausted one.
    const bad = await fetch(`${fixture.url}/login?token=not-the-owner-token`, { redirect: "manual" });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get("set-cookie"), null);

    const good = await fetch(`${fixture.url}/login?token=${encodeURIComponent(ownerToken)}`, {
      redirect: "manual",
    });
    assert.equal(good.status, 303);
    assert.equal(good.headers.get("location"), "/");
    assert.equal(good.headers.get("referrer-policy"), "no-referrer", "the credential never rides a Referer");
    const header = good.headers.get("set-cookie") ?? "";
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    // Plain HTTP on the tailnet: no Secure (the browser would drop it).
    assert.doesNotMatch(header, /Secure/);

    const cookie = firstCookie(good);
    const me = await fetch(`${fixture.url}/api/session`, { headers: { Cookie: sessionOfCookie(cookie) } });
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { memberId: string; role: string; label: string };
    assert.equal(meBody.role, "owner");
    assert.equal(meBody.label, "Alex", "the label comes from the household profile");
  } finally {
    await stop(fixture);
  }
});

test("the owner mints an invite over HTTP; the partner lands with a member session; a code is single-use", async () => {
  const fixture = await startThread({ ownerOnly: true });
  try {
    const minted = await fixture.auth.mintOwner("http://127.0.0.1").then((m) => m.token);
    const alexCookie = await fixture.auth.login(minted).then((l) => l.token);

    const invite = await fetch(`${fixture.url}/api/invites`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        Cookie: sessionOfCookie(alexCookie),
        Origin: fixture.url,
      },
      body: JSON.stringify({ displayName: "Sam" }),
    });
    assert.equal(invite.status, 200, "only the owner creates invites");
    const inviteBody = (await invite.json()) as { code: string; link: string };
    assert.equal(inviteBody.link, `${fixture.url}/invite?code=${encodeURIComponent(inviteBody.code)}`);

    // A member would be a 403 by the matrix:
    // (the household has no second member yet, so an owner-block is undetectable
    // through HTTP alone; auth.test.ts covers the matrix itself)
    const partner = await fetch(inviteBody.link, { redirect: "manual" });
    assert.equal(partner.status, 303);
    const partnerCookie = firstCookie(partner);
    const me = await fetch(`${fixture.url}/api/session`, {
      headers: { Cookie: sessionOfCookie(partnerCookie) },
    });
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { role: string; label: string; authorId: string | null };
    assert.equal(meBody.role, "member");
    // A just-invited member has no profile until the next boot reconciles it:
    // §9.2 says the label then falls back, never `undefined`.
    assert.equal(meBody.label, "Household");

    // The code is one-time: a second use is refused, so a leaked link cannot
    // mint a third caregiver.
    const reuse = await fetch(inviteBody.link, { redirect: "manual" });
    assert.equal(reuse.status, 401);
  } finally {
    await stop(fixture);
  }
});

test("a member cannot create an invite, and the ones that exist still work", async () => {
  const fixture = await startThread();
  try {
    const refused = await fetch(`${fixture.url}/api/invites`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        Cookie: sessionOfCookie(fixture.samCookie),
        Origin: fixture.url,
      },
      body: JSON.stringify({ displayName: "Imposter" }),
    });
    assert.equal(refused.status, 403);
  } finally {
    await stop(fixture);
  }
});

test("logout revokes the session and clears the cookie", async () => {
  const fixture = await startThread();
  try {
    const before = await fetch(`${fixture.url}/api/session`, {
      headers: { Cookie: sessionOfCookie(fixture.alexCookie) },
    });
    assert.equal(before.status, 200);

    const out = await fetch(`${fixture.url}/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        Cookie: sessionOfCookie(fixture.alexCookie),
        Origin: fixture.url,
      },
      redirect: "manual",
    });
    assert.equal(out.status, 303);
    const header = out.headers.get("set-cookie") ?? "";
    assert.match(header, /Max-Age=0/, "the browser is told to drop the cookie");

    const after = await fetch(`${fixture.url}/api/session`, {
      headers: { Cookie: sessionOfCookie(fixture.alexCookie) },
    });
    assert.equal(after.status, 401, "the session row is gone, not merely the cookie");
  } finally {
    await stop(fixture);
  }
});

test("every mutation refuses a missing custom header (403) and a non-JSON body (415)", async () => {
  const fixture = await startThread();
  try {
    const mutations = [
      { path: "/api/agent/messages", body: JSON.stringify({ text: "CSRF probe", clientMessageId: "m-csrf" }) },
      { path: "/api/invites", body: JSON.stringify({ displayName: "Imposter" }) },
      { path: "/logout", body: JSON.stringify({}) },
    ];
    for (const mutation of mutations) {
      const common = {
        Cookie: sessionOfCookie(fixture.alexCookie),
        Origin: fixture.url,
      };
      const missingHeader = await fetch(`${fixture.url}${mutation.path}`, {
        method: "POST",
        headers: { ...common, "Content-Type": "application/json" },
        body: mutation.body,
        redirect: "manual",
      });
      assert.equal(missingHeader.status, 403, `${mutation.path} needs ${REQUEST_HEADER}: ${REQUEST_HEADER_VALUE}`);

      const wrongType = await fetch(`${fixture.url}${mutation.path}`, {
        method: "POST",
        headers: { ...common, "Content-Type": "text/plain", [REQUEST_HEADER]: REQUEST_HEADER_VALUE },
        body: mutation.body,
        redirect: "manual",
      });
      assert.equal(wrongType.status, 415, `${mutation.path} needs application/json`);
    }

    const still = await fetch(`${fixture.url}/api/session`, {
      headers: { Cookie: sessionOfCookie(fixture.alexCookie) },
    });
    assert.equal(still.status, 200, "a refused logout never revokes the session");
  } finally {
    await stop(fixture);
  }
});

test("sign-in and invite guessing is rate-limited by client IP", async () => {
  const fixture = await startThread();
  try {
    let hitLimit = false;
    for (let attempt = 0; attempt < SIGNIN_LIMIT + 4; attempt += 1) {
      const route = attempt % 2 === 0 ? "/login?token=guess" : "/invite?code=guess";
      const response = await fetch(`${fixture.url}${route}`, { redirect: "manual" });
      if (response.status === 429) {
        hitLimit = true;
        break;
      }
    }
    assert.equal(hitLimit, true, "guessing tokens or codes meets the limiter within a window");
  } finally {
    await stop(fixture);
  }
});

test("repeated polls leave no waiters behind", async () => {
  const fixture = await startThread();
  try {
    const busT = fixture.app.threadBus;
    assert.ok(busT, "the shared-thread wiring exposes its fanout");
    // Five expired long-polls in a row: each answers 200 with a snapshot and
    // must leave the waiter list empty, not grow it.
    for (let round = 0; round < 5; round += 1) {
      const response = await longPoll(fixture, fixture.alexCookie, 0, 150);
      assert.equal(response.status, 200);
    }
    assert.equal(busT.waiterCount, 0, "settled waiters are removed, not accumulated");
  } finally {
    await stop(fixture);
  }
});
