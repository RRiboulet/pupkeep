// P3-03: the growth HTTP surface and its live care frame (PLAN §7.3, §7.4,
// §8.4, §9.4, §14.2, §16 P3-03).
//
// What is covered:
//   * GET /api/growth: the committed series, P3-02's summary and its copy, with
//     `no-store` and a session;
//   * POST /api/growth: one commit, the committed view in the answer, a replay
//     under the same key, the one key-conflict answer, and the domain's refusal
//     for a value the parser would not store — nothing written;
//   * the shared mutation guards (session, origin, request header, JSON, key);
//   * the care frame: a measurement moves no document revision, and still
//     reaches the other caregiver's screen.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import { watchProfileState } from "../src/server/agent/state.ts";
import { emptyConfig } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import { ActivityDoc } from "../src/server/domain/docs.ts";
import { MEASUREMENT_RULE } from "../src/shared/growth.ts";
import { openHarness } from "../src/server/harness.ts";
import { createLogger } from "../src/server/log.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import type { GrowthView } from "../src/shared/growth.ts";
import type { PuppyProfile } from "../src/shared/profile.ts";
import { startTestApp, type TestApp } from "./support/app.ts";

const context = BACKGROUND_CONTEXT;
const T0 = new Date("2026-10-30T08:00:00.000Z");

type Fixture = TestApp & { alexCookie: string };

async function startGrowthApp(): Promise<Fixture> {
  const base = await startTestApp({ prefix: "pupkeep-growth-routes-", now: T0.getTime() });
  return { ...base, alexCookie: base.cookies.owner };
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

async function getGrowth(fixture: Fixture, token = fixture.alexCookie): Promise<{ status: number; body: GrowthView }> {
  const response = await fetch(`${fixture.url}/api/growth`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
  return { status: response.status, body: (await response.json()) as GrowthView };
}

// --- the read ---------------------------------------------------------------

test("GET /api/growth answers the series, the trend and its copy, and needs a session", async () => {
  const fixture = await startGrowthApp();
  try {
    const unauthenticated = await fetch(`${fixture.url}/api/growth`);
    assert.equal(unauthenticated.status, 401);

    const { status, body } = await getGrowth(fixture);
    assert.equal(status, 200);
    assert.deepEqual(body.points, []);
    assert.equal(body.summary.state, "no_data");
    assert.match(body.lines[0]!.text, /No weight logged yet\./);
    assert.match(body.lines[1]!.text, /not veterinary advice/);
    assert.equal(body.summary.target, null);
    const response = await fetch(`${fixture.url}/api/growth`, {
      headers: { Cookie: `${SESSION_COOKIE}=${fixture.alexCookie}` },
    });
    assert.equal(response.headers.get("cache-control"), "no-store");

    // The care reads use the process clock (P3-03's fix): the profile GET, the
    // profile PATCH answer and the growth view agree about the household's day.
    const patched = await fetch(`${fixture.url}/api/puppy`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        "Idempotency-Key": "target-1",
        Cookie: `${SESSION_COOKIE}=${fixture.alexCookie}`,
        Origin: fixture.url,
      },
      body: JSON.stringify({ rev: 0, targetWeightKg: 12 }),
    });
    assert.equal(patched.status, 200);
    const patchedProfile = ((await patched.json()) as { profile: PuppyProfile }).profile;
    assert.equal(patchedProfile.today, (await fixture.profile()).today, "the PATCH answer uses the process clock");
  } finally {
    await fixture.stop();
  }
});

// --- the write --------------------------------------------------------------

test("logging a weight is one commit, replayed by the same key, and refused for a different body", async () => {
  const fixture = await startGrowthApp();
  try {
    const before = await fixture.profile();
    const first = await post(fixture, "/api/growth", fixture.alexCookie, {
      key: "weigh-1",
      body: { weightKg: 4.25, note: "after a nap" },
    });
    assert.equal(first.status, 200);
    const logged = (await first.json()) as { growth: GrowthView; replayed: boolean };
    assert.equal(logged.replayed, false);
    assert.equal(logged.growth.points.length, 1);
    assert.equal(logged.growth.points[0]?.weightKg, 4.25);
    // The household-local day, derived from the same zone the profile shows.
    assert.equal(logged.growth.points[0]?.localDate, before.today);
    // The copy arrives with roles, so the panel never styles by line index.
    assert.deepEqual(logged.growth.lines.map((line) => line.role), ["note", "disclaimer"]);
    assert.match(logged.growth.lines[0]!.text, /One weight logged \(4\.25 kg/);
    assert.match(logged.growth.lines[1]!.text, /not veterinary advice/);

    // The commit is the measurement, one activity line and the idempotency
    // record; the note is stored on the record, not in the feed. (The fixture's
    // zone confirmation is its own setup line.)
    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.deepEqual(
      activity?.entries.filter((entry) => entry.kind === "growth.measurement").map((entry) => entry.summary),
      ["Alex logged a weight of 4.25 kg"],
    );

    const replay = await post(fixture, "/api/growth", fixture.alexCookie, {
      key: "weigh-1",
      body: { weightKg: 4.25, note: "after a nap" },
    });
    assert.equal(replay.status, 200);
    const replayed = (await replay.json()) as { growth: GrowthView; replayed: boolean };
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.growth.points.length, 1, "a replay writes nothing");

    const conflict = await post(fixture, "/api/growth", fixture.alexCookie, {
      key: "weigh-1",
      body: { weightKg: 4.3 },
    });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: string }).error, "idempotency_conflict");
    assert.equal((await getGrowth(fixture)).body.points.length, 1);
  } finally {
    await fixture.stop();
  }
});

test("an invalid measurement is refused with the rule and writes nothing", async () => {
  const fixture = await startGrowthApp();
  try {
    const zero = await post(fixture, "/api/growth", fixture.alexCookie, { key: "bad-1", body: { weightKg: 0 } });
    assert.equal(zero.status, 409);
    assert.equal(((await zero.json()) as { error: string }).error, MEASUREMENT_RULE);

    const text = await post(fixture, "/api/growth", fixture.alexCookie, {
      key: "bad-2",
      body: { weightKg: "4.25" },
    });
    assert.equal(text.status, 409);
    assert.match(((await text.json()) as { error: string }).error, /weight in kilograms/);

    const typo = await post(fixture, "/api/growth", fixture.alexCookie, {
      key: "bad-3",
      body: { weightKg: 4.25, grams: 4250 },
    });
    assert.equal(typo.status, 409);
    assert.match(((await typo.json()) as { error: string }).error, /does not accept "grams"/);

    assert.deepEqual((await getGrowth(fixture)).body.points, []);
    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    // The fixture's own zone confirmation is setup, not this write: a refused
    // measurement adds no measurement line and no command key.
    assert.equal(
      activity?.entries.some((entry) => entry.kind === "growth.measurement"),
      false,
      "a refused measurement writes nothing",
    );
  } finally {
    await fixture.stop();
  }
});

test("the growth routes need a session, an origin, the request header, JSON and a key", async () => {
  const fixture = await startGrowthApp();
  try {
    assert.equal((await post(fixture, "/api/growth", "", { key: "k", body: { weightKg: 4.2 } })).status, 401);
    assert.equal(
      (await post(fixture, "/api/growth", fixture.alexCookie, { key: "k", body: { weightKg: 4.2 }, omitOrigin: true })).status,
      403,
    );
    assert.equal(
      (await post(fixture, "/api/growth", fixture.alexCookie, { key: "k", body: { weightKg: 4.2 }, omitHeader: true })).status,
      403,
    );
    assert.equal(
      (await post(fixture, "/api/growth", fixture.alexCookie, {
        key: "k",
        body: { weightKg: 4.2 },
        contentType: "text/plain",
      })).status,
      415,
    );
    const noKey = await post(fixture, "/api/growth", fixture.alexCookie, { body: { weightKg: 4.2 } });
    assert.equal(noKey.status, 409);
    assert.match(((await noKey.json()) as { error: string }).error, /Idempotency-Key/);
    assert.deepEqual((await getGrowth(fixture)).body.points, []);
  } finally {
    await fixture.stop();
  }
});

// --- the live frame ---------------------------------------------------------

test("a measurement publishes a care signal, and the frame carries no growth data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-growth-frame-"));
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
      const { logMeasurement } = await import("../src/server/domain/growth.ts");
      await logMeasurement(opened.harness, context, {
        actor: async () => ({ id: "owner", label: "Alex" }),
        actionId: "http:weigh-1",
        weightKg: 4.2,
        source: "ui",
        now: T0,
      });
      const deadline = Date.now() + 2000;
      while (frames.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(frames.length > 0, "app.growth is one of the documents behind the care frame");
      // P2-05: the frame is a signal, not data. `applyCareView` bumps `careSeq`,
      // and the Pup screen re-reads GET /api/growth on the change.
      const frame = frames[frames.length - 1]!;
      assert.equal("growth" in (frame as unknown as Record<string, unknown>), false, "no growth data on the frame");
    } finally {
      watch.stop();
    }
    // The live read the screen re-fetches does carry it.
    const { growthView, readGrowth } = await import("../src/server/domain/growth.ts");
    const { readHousehold } = await import("../src/server/domain/household.ts");
    const { readPuppy } = await import("../src/server/domain/profile.ts");
    const view = growthView(await readHousehold(opened.harness, context), await readPuppy(opened.harness, context), await readGrowth(opened.harness, context), T0);
    assert.equal(view.points.length, 1, "the measurement the frame signalled is on the live read");
    assert.equal(view.points[0]?.weightKg, 4.2);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});
