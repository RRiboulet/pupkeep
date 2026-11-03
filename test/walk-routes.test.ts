// P2-07: the walk HTTP surface (PLAN §7.3, §7.4, §8.4, §8.5, §14.2).
//
// What is covered:
//   * GET /api/walks: the open walk, the server clock the timer is corrected
//     against, and §8.5's window — all `no-store`;
//   * start: one commit, the open walk in the answer, a second start refused
//     with the walk (and `walk_stale` once the window has passed);
//   * end: the id the form rendered is required, observations are recorded, a
//     replay is success, and a different action is `walk_ended` with the record;
//   * discard: only through its own route, marking the record;
//   * the shared mutation guards (session, origin, request header, JSON, key).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { SESSION_COOKIE, Auth, hashToken, newToken } from "../src/server/auth.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { dataStores } from "../src/server/config.ts";
import { createLogger } from "../src/server/log.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { WALK_STALE_AFTER_MS } from "../src/shared/walks.ts";
import type { Walk } from "../src/shared/domain.ts";

const T0 = new Date("2026-10-30T08:00:00.000Z");

interface Fixture {
  dir: string;
  app: AppHandle;
  url: string;
  alexCookie: string;
  samCookie: string;
  /** Advance the app's clock (the routes read it, not the wall clock). */
  setNow: (date: Date) => void;
}

async function startWalkApp(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-walk-routes-"));
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] });
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

  let current = T0;
  const result = await startApp(
    { dataDir: dir, host: "127.0.0.1", port: 0, models, now: () => current.getTime() },
    { logger: createLogger({ scope: "test", sink: () => undefined }) },
  );
  assert.ok(result.ok, "the app must start");
  const auth = new Auth({ config: stores.config });
  const ownerToken = await auth.mintOwner("http://127.0.0.1").then((m) => m.token);
  const alexCookie = await auth.login(ownerToken).then((l) => l.token);
  return {
    dir,
    app: result.app,
    url: result.app.url,
    alexCookie,
    samCookie: samToken,
    setNow: (date) => {
      current = date;
    },
  };
}

async function stop(fixture: Fixture): Promise<void> {
  await fixture.app.close();
  await rm(fixture.dir, { recursive: true, force: true });
}

function cookieFor(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

interface MutateOptions {
  body?: Record<string, unknown>;
  key?: string;
  omitOrigin?: boolean;
  omitHeader?: boolean;
  omitKey?: boolean;
  contentType?: string;
}

async function post(
  fixture: Fixture,
  path: string,
  token: string,
  options: MutateOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": options.contentType ?? "application/json",
    ...(options.omitHeader ? {} : { [REQUEST_HEADER]: REQUEST_HEADER_VALUE }),
    Cookie: cookieFor(token),
    ...(options.omitOrigin ? {} : { Origin: fixture.url }),
  };
  if (!options.omitKey && options.key !== undefined) headers["Idempotency-Key"] = options.key;
  return fetch(`${fixture.url}${path}`, { method: "POST", headers, body: JSON.stringify(options.body ?? {}) });
}

async function getWalks(
  fixture: Fixture,
  token: string,
): Promise<{ status: number; body: { open: Walk | null; serverNow: string; staleAfterMs: number } }> {
  const response = await fetch(`${fixture.url}/api/walks`, { headers: { Cookie: cookieFor(token) } });
  return { status: response.status, body: (await response.json()) as never };
}

test("GET /api/walks answers the open walk, the server clock and the stale window", async () => {
  const fixture = await startWalkApp();
  try {
    const response = await fetch(`${fixture.url}/api/walks`, { headers: { Cookie: cookieFor(fixture.alexCookie) } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const body = (await response.json()) as { open: Walk | null; serverNow: string; staleAfterMs: number };
    assert.equal(body.open, null);
    assert.equal(body.serverNow, T0.toISOString(), "the server clock, not the device's");
    assert.equal(body.staleAfterMs, WALK_STALE_AFTER_MS);

    const started = await post(fixture, "/api/walks/start", fixture.alexCookie, { key: "start-1" });
    assert.equal(started.status, 200);
    const startedBody = (await started.json()) as { walk: Walk; replayed: boolean };
    assert.equal(startedBody.replayed, false);
    assert.equal(startedBody.walk.startedByLabel, "Alex");

    const after = await getWalks(fixture, fixture.samCookie);
    assert.equal(after.body.open?.id, startedBody.walk.id, "the partner sees the same open walk");
  } finally {
    await stop(fixture);
  }
});

test("a second start is a 409 with the open walk; past eight hours it is walk_stale", async () => {
  const fixture = await startWalkApp();
  try {
    const started = await post(fixture, "/api/walks/start", fixture.alexCookie, { key: "start-1" });
    const { walk } = (await started.json()) as { walk: Walk };

    const second = await post(fixture, "/api/walks/start", fixture.samCookie, { key: "start-2" });
    assert.equal(second.status, 409);
    const open = (await second.json()) as { error: string; message: string; walk: Walk };
    assert.equal(open.error, "walk_open");
    assert.equal(open.walk.id, walk.id, "the caller can show the walk instead of a dead end");
    assert.match(open.message, /"Alex" is already walking/);

    fixture.setNow(new Date(T0.getTime() + WALK_STALE_AFTER_MS + 1));
    const stale = await post(fixture, "/api/walks/start", fixture.samCookie, { key: "start-3" });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { error: string }).error, "walk_stale");
    assert.equal((await getWalks(fixture, fixture.alexCookie)).body.open?.id, walk.id, "still one walk");
  } finally {
    await stop(fixture);
  }
});

test("ending a walk records observations, replays, and refuses a different action with the record", async () => {
  const fixture = await startWalkApp();
  try {
    const started = await post(fixture, "/api/walks/start", fixture.alexCookie, { key: "start-1" });
    const { walk } = (await started.json()) as { walk: Walk };
    fixture.setNow(new Date(T0.getTime() + 35 * 60_000));

    const ended = await post(fixture, "/api/walks/end", fixture.samCookie, {
      key: "end-1",
      body: { walkId: walk.id, pee: 1, poop: 0, dogsMet: " a beagle ", mood: "happy", notes: " park loop " },
    });
    assert.equal(ended.status, 200);
    const endedBody = (await ended.json()) as { walk: Walk };
    assert.equal(endedBody.walk.endedByLabel, "Sam");
    assert.equal(endedBody.walk.dogsMet, "a beagle");
    assert.equal(endedBody.walk.notes, "park loop");
    assert.equal((await getWalks(fixture, fixture.alexCookie)).body.open, null);

    const replay = await post(fixture, "/api/walks/end", fixture.samCookie, {
      key: "end-1",
      body: { walkId: walk.id, pee: 1, poop: 0, dogsMet: "a beagle", mood: "  happy  ", notes: "park loop" },
    });
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true, "a normalised retry replays");

    const again = await post(fixture, "/api/walks/end", fixture.alexCookie, { key: "end-2", body: { walkId: walk.id } });
    assert.equal(again.status, 409);
    const conflict = (await again.json()) as { error: string; message: string; walk: Walk };
    assert.equal(conflict.error, "walk_ended");
    assert.equal(conflict.walk.endedByLabel, "Sam", "who ended it, not just a sentence");
    assert.match(conflict.message, /"Sam" already ended this walk/);
  } finally {
    await stop(fixture);
  }
});

test("closing a walk needs the id the form showed; discard marks a stale walk", async () => {
  const fixture = await startWalkApp();
  try {
    const started = await post(fixture, "/api/walks/start", fixture.alexCookie, { key: "start-1" });
    const { walk } = (await started.json()) as { walk: Walk };

    const noId = await post(fixture, "/api/walks/end", fixture.alexCookie, { key: "end-1", body: {} });
    assert.equal(noId.status, 409, "an end without the id it rendered is refused");
    assert.match(((await noId.json()) as { error: string }).error, /walk id/);

    fixture.setNow(new Date(T0.getTime() + 9 * 60 * 60_000));
    const discarded = await post(fixture, "/api/walks/discard", fixture.samCookie, {
      key: "discard-1",
      body: { walkId: walk.id },
    });
    assert.equal(discarded.status, 200);
    assert.equal(((await discarded.json()) as { walk: Walk }).walk.discarded, true);

    // A fresh walk is endable, not discardable (§8.5).
    fixture.setNow(T0);
    const earlyStart = await post(fixture, "/api/walks/start", fixture.alexCookie, { key: "start-2" });
    const early = (await earlyStart.json()) as { walk: Walk };
    const earlyDiscard = await post(fixture, "/api/walks/discard", fixture.samCookie, {
      key: "discard-early",
      body: { walkId: early.walk.id },
    });
    assert.equal(earlyDiscard.status, 409);
    assert.match(((await earlyDiscard.json()) as { error: string }).error, /not stale/);
    await post(fixture, "/api/walks/end", fixture.samCookie, { key: "end-early", body: { walkId: early.walk.id } });
    fixture.setNow(new Date(T0.getTime() + 9 * 60 * 60_000));

    const extraKeys = await post(fixture, "/api/walks/end", fixture.samCookie, {
      key: "end-extra",
      body: { walkId: walk.id, peee: 1 },
    });
    assert.equal(extraKeys.status, 409, "a misspelt observation is visible");
    const stringCount = await post(fixture, "/api/walks/end", fixture.samCookie, {
      key: "end-string",
      body: { walkId: walk.id, pee: "1" },
    });
    assert.equal(stringCount.status, 409);
    assert.match(((await stringCount.json()) as { error: string }).error, /observations are optional/);

    const missing = await post(fixture, "/api/walks/discard", fixture.samCookie, {
      key: "discard-2",
      body: { walkId: "walk-gone" },
    });
    assert.equal(missing.status, 409);
    assert.equal(((await missing.json()) as { error: string }).error, "walk_missing");
  } finally {
    await stop(fixture);
  }
});

test("the walk routes need a session, an origin, the request header, JSON and a key", async () => {
  const fixture = await startWalkApp();
  try {
    assert.equal((await fetch(`${fixture.url}/api/walks`)).status, 401);
    assert.equal((await post(fixture, "/api/walks/start", "", { key: "k" })).status, 401);

    assert.equal((await post(fixture, "/api/walks/start", fixture.alexCookie, { key: "k", omitOrigin: true })).status, 403);
    assert.equal((await post(fixture, "/api/walks/start", fixture.alexCookie, { key: "k", omitHeader: true })).status, 403);
    assert.equal(
      (await post(fixture, "/api/walks/start", fixture.alexCookie, { key: "k", contentType: "text/plain" })).status,
      415,
    );
    const noKey = await post(fixture, "/api/walks/start", fixture.alexCookie, { omitKey: true });
    assert.equal(noKey.status, 409);
    assert.match(((await noKey.json()) as { error: string }).error, /Idempotency-Key/);

    // A start body that is not an object is refused, and nothing is written.
    const badBody = await post(fixture, "/api/walks/start", fixture.alexCookie, { key: "bad", body: { extra: true } });
    assert.equal(badBody.status, 409);
    assert.equal((await getWalks(fixture, fixture.alexCookie)).body.open, null);
  } finally {
    await stop(fixture);
  }
});
