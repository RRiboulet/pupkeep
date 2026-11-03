// P1-14: first-run setup (PLAN §16 Phase 1, §13.1, §8.1, §7.4, §14.2).
//
// What is covered, in the order the code is layered:
//   * the shape: the household's v1 → v2 migration, the meal-slot parser and
//     the derived setup checklist;
//   * the two domain writers over a real SQLite harness: one commit per save,
//     revision conflict, idempotent replay, one activity entry, and refusals
//     that write nothing;
//   * the HTTP surface (auth/origin/header/content-type/key/rev), the 409
//     shapes, and the `profile` frame both caregivers see;
//   * bootstrap: a database that predates P1-14 gets its feeding document and a
//     confirmed-once household rather than a reset or a 503.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { SESSION_COOKIE, Auth, hashToken, newToken } from "../src/server/auth.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { dataStores, emptyConfig, type AppConfig, type MemberRecord } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import {
  ActivityDoc,
  FeedingDoc,
  HouseholdDoc,
  PuppyDoc,
  emptyFeeding,
  parseFeeding,
  parseHousehold,
} from "../src/server/domain/docs.ts";
import { DomainConflictError } from "../src/server/domain/errors.ts";
import {
  FeedingUnavailableError,
  readFeeding,
  updateMealSlots,
} from "../src/server/domain/feeding.ts";
import { readHousehold, updateHouseholdTimezone } from "../src/server/domain/household.ts";
import { readProfile, setupState } from "../src/server/domain/profile.ts";
import { parseMealSlots, parseStoredMealSlots } from "../src/shared/feeding.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import { createLogger } from "../src/server/log.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import type { PuppyProfile } from "../src/shared/profile.ts";
import type { MealSlot } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
const NOW = new Date("2026-10-29T12:00:00.000Z");
const NOON = NOW;

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "owner",
    role: "owner",
    displayName: "Alex",
    createdAt: "2026-10-29T10:00:00.000Z",
    sessions: [],
    ...overrides,
  };
}

const owner = member();
const partner = member({ id: "partner", role: "member", displayName: "Sam" });

function config(...members: MemberRecord[]): AppConfig {
  return { ...emptyConfig(), members };
}

const actor = async () => ({ id: "owner", label: "Alex" });

const BREAKFAST: MealSlot = { id: "slot-a", label: "Breakfast", timeLocal: "07:00", active: true };
const DINNER: MealSlot = { id: "slot-b", label: "Dinner", timeLocal: "18:00", portion: "80 g", active: true };

// --- the shape --------------------------------------------------------------

test("a version-1 household migrates to rev 0 and an unconfirmed timezone", () => {
  const migrate = HouseholdDoc.definition.migrate;
  assert.ok(migrate, "the document declares its migration");
  const legacy = {
    schemaVersion: 1,
    name: "Our household",
    timezone: "Europe/Paris",
    members: [{ id: "owner", name: "Alex" }],
    conversationId: 3,
    systemConversationId: 4,
    createdAt: "2026-10-29T10:00:00.000Z",
    settings: {
      feedReminderDelayMin: 15,
      appointmentReminderOffsetsMin: [1440, 60],
      showerIntervalDays: 21,
      agentBudgetUsd: 10,
    },
  };
  const migrated = migrate(legacy as never, 1);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.rev, 0);
  assert.equal(migrated.timezone, "Europe/Paris", "the captured zone is kept");
  assert.equal(migrated.timezoneConfirmedAt, null, "but nobody has confirmed it yet");
  assert.throws(() => migrate(legacy as never, 0), /no migration/);
});

test("the household parser needs a revision and a real confirmation instant", () => {
  const base = {
    schemaVersion: 2,
    rev: 3,
    name: "Our household",
    timezone: "Europe/Paris",
    timezoneConfirmedAt: "2026-10-29T12:00:00.000Z",
    members: [{ id: "owner", name: "Alex" }],
    conversationId: 1,
    systemConversationId: 2,
    createdAt: "2026-10-29T10:00:00.000Z",
    settings: {
      feedReminderDelayMin: 15,
      appointmentReminderOffsetsMin: [1440],
      showerIntervalDays: 21,
      agentBudgetUsd: 10,
    },
  };
  assert.deepEqual(parseHousehold(base)?.rev, 3);
  assert.equal(parseHousehold({ ...base, rev: -1 }), undefined);
  assert.equal(parseHousehold({ ...base, rev: 1.5 }), undefined);
  assert.equal(parseHousehold({ ...base, timezoneConfirmedAt: "yesterday" }), undefined);
  assert.equal(parseHousehold({ ...base, timezone: "Not/AZone" }), undefined);
  assert.equal(parseHousehold({ ...base, timezoneConfirmedAt: null })?.timezoneConfirmedAt, null);
});

test("the meal-slot parser enforces the schedule invariants", () => {
  assert.deepEqual(parseMealSlots([BREAKFAST]), [BREAKFAST]);
  assert.equal(parseMealSlots([]), undefined, "a write needs at least one meal");
  assert.deepEqual(parseStoredMealSlots([]), [], "a fresh document may hold no slots");
  assert.equal(parseMealSlots([{ ...BREAKFAST, timeLocal: "7:00" }]), undefined, "HH:MM, not H:MM");
  assert.equal(parseMealSlots([{ ...BREAKFAST, timeLocal: "24:00" }]), undefined);
  assert.equal(parseMealSlots([{ ...BREAKFAST, label: "  " }]), undefined);
  assert.equal(parseMealSlots([{ ...BREAKFAST, label: "Bed\u0000time" }]), undefined);
  assert.equal(parseMealSlots([{ ...BREAKFAST, portion: "x".repeat(81) }]), undefined);
  assert.equal(parseMealSlots([{ ...BREAKFAST, active: false }]), undefined, "at least one active slot");
  assert.equal(
    parseMealSlots([BREAKFAST, { ...DINNER, timeLocal: "07:00" }]),
    undefined,
    "one meal per wall-clock time",
  );
  assert.equal(parseMealSlots([BREAKFAST, { ...DINNER, id: "slot-a" }]), undefined, "ids are unique");
  assert.equal(parseMealSlots([{ ...BREAKFAST, nickname: "Bfast" }]), undefined, "unknown keys are refused");
  // An empty portion is "not set", not an empty string in the document.
  assert.equal(parseMealSlots([{ ...BREAKFAST, portion: "  " }])?.[0]?.portion, undefined);
  assert.equal(parseMealSlots([BREAKFAST, DINNER])?.length, 2);
  // Twelve is the cap; a thirteenth meal is a typo.
  const many = Array.from({ length: 13 }, (_item, index) => ({
    id: `slot-${index}`,
    label: `Meal ${index}`,
    timeLocal: `${String(index).padStart(2, "0")}:00`,
    active: true,
  }));
  assert.equal(parseMealSlots(many.slice(0, 12))?.length, 12);
  assert.equal(parseMealSlots(many), undefined);
});

test("the setup checklist is derived from the documents, in wizard order", () => {
  const household = {
    schemaVersion: 2 as const,
    rev: 0,
    name: "Our household",
    timezone: "Europe/Paris",
    timezoneConfirmedAt: null,
    members: [{ id: "owner", name: "Alex" }],
    conversationId: 1,
    systemConversationId: 2,
    createdAt: "2026-10-29T10:00:00.000Z",
    settings: {
      feedReminderDelayMin: 15,
      appointmentReminderOffsetsMin: [1440],
      showerIntervalDays: 21,
      agentBudgetUsd: 10,
    },
  };
  const puppy = {
    schemaVersion: 2 as const,
    rev: 0,
    name: "",
    birthday: null,
    breed: null,
    sex: null,
    targetWeightKg: null,
    createdAt: "2026-10-29T10:00:00.000Z",
  };
  const feeding = { ...emptyFeeding(), createdAt: "2026-10-29T10:00:00.000Z" };

  assert.deepEqual(setupState(household, puppy, feeding), {
    complete: false,
    missing: ["timezone", "puppy", "meals"],
  });
  assert.deepEqual(
    setupState(
      { ...household, timezoneConfirmedAt: "2026-10-29T12:00:00.000Z" },
      { ...puppy, name: "Biscuit" },
      { ...feeding, slots: [BREAKFAST] },
    ),
    { complete: true, missing: [] },
  );
  assert.deepEqual(
    setupState(
      { ...household, timezoneConfirmedAt: "2026-10-29T12:00:00.000Z" },
      { ...puppy, name: "Biscuit" },
      feeding,
    ),
    { complete: false, missing: ["meals"] },
  );
});

// --- the domain writes ------------------------------------------------------

async function withHarness(run: (opened: OpenedHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-setup-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
  try {
    await run(opened);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

test("confirming the captured zone is one commit: revision, instant, activity", async () => {
  await withHarness(async ({ harness }) => {
    await bootstrapSession(harness, {
      config: config(owner, partner),
      context,
      timezone: "Europe/Paris",
      now: () => NOON,
    });
    const before = await readHousehold(harness, context);
    assert.equal(before.timezone, "Europe/Paris");
    assert.equal(before.timezoneConfirmedAt, null);

    const outcome = await updateHouseholdTimezone(harness, context, {
      actor,
      actionId: "http:zone-1",
      rev: 0,
      timezone: "Europe/Paris",
      now: NOW,
    });
    assert.equal(outcome, "updated");

    const after = await readHousehold(harness, context);
    assert.equal(after.rev, 1, "a confirmation is a real save");
    assert.equal(after.timezoneConfirmedAt, NOW.toISOString());
    const activity = await harness.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries.length, 1);
    assert.equal(activity?.entries[0]?.kind, "household.timezone");
    assert.match(activity?.entries[0]?.summary ?? "", /Alex confirmed the household timezone \(Europe\/Paris\)/);

    // The care view says the timezone step is done and keeps the other two.
    const profile = await readProfile(harness, context, NOON);
    assert.deepEqual(profile.setup.missing, ["puppy", "meals"]);
    assert.equal(profile.household.rev, 1);
  });
});

test("changing the zone names both zones, and a bad zone writes nothing", async () => {
  await withHarness(async ({ harness }) => {
    await bootstrapSession(harness, { config: config(owner), context, timezone: "Europe/Paris", now: () => NOON });
    const changed = await updateHouseholdTimezone(harness, context, {
      actor,
      actionId: "http:zone-1",
      rev: 0,
      timezone: "America/New_York",
      now: NOW,
    });
    assert.equal(changed, "updated");
    const activity = await harness.snapshot(ActivityDoc, context);
    assert.match(
      activity?.entries[0]?.summary ?? "",
      /Alex changed the household timezone from Europe\/Paris to America\/New_York/,
    );

    await assert.rejects(
      updateHouseholdTimezone(harness, context, {
        actor,
        actionId: "http:zone-bad",
        rev: 1,
        timezone: "Mars/Olympus",
        now: NOW,
      }),
      DomainConflictError,
    );
    const after = await readHousehold(harness, context);
    assert.equal(after.rev, 1, "a refused zone does not burn a revision");
    assert.equal(after.timezone, "America/New_York");
    assert.equal((await harness.snapshot(ActivityDoc, context))?.entries.length, 1);
  });
});

test("a timezone save replays as success, refuses a reused key and a stale revision", async () => {
  await withHarness(async ({ harness }) => {
    await bootstrapSession(harness, { config: config(owner), context, timezone: "Europe/Paris", now: () => NOON });
    const input = { actor, rev: 0, timezone: "Europe/Lisbon", now: NOW } as const;
    assert.equal(await updateHouseholdTimezone(harness, context, { ...input, actionId: "http:k1" }), "updated");
    assert.equal(
      await updateHouseholdTimezone(harness, context, { ...input, actionId: "http:k1" }),
      "replayed",
      "the same key and body is the same action",
    );
    const activity = await harness.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries.length, 1, "a replay is not a second care action");

    assert.equal(
      await updateHouseholdTimezone(harness, context, {
        actor,
        actionId: "http:k1",
        rev: 0,
        timezone: "Europe/Madrid",
        now: NOW,
      }),
      "key-conflict",
    );
    assert.equal(
      await updateHouseholdTimezone(harness, context, {
        actor,
        actionId: "http:k2",
        rev: 0,
        timezone: "Europe/Madrid",
        now: NOW,
      }),
      "stale",
      "a revision that was read before the first save is refused",
    );
    const after = await readHousehold(harness, context);
    assert.equal(after.rev, 1);
    assert.equal(after.timezone, "Europe/Lisbon");
  });
});

test("the meal schedule is one commit, and an invalid schedule writes nothing", async () => {
  await withHarness(async ({ harness }) => {
    await bootstrapSession(harness, { config: config(owner), context, timezone: "Europe/Paris", now: () => NOON });
    assert.deepEqual((await readFeeding(harness, context)).slots, [], "a fresh household has no meals");

    const first = await updateMealSlots(harness, context, {
      actor,
      actionId: "http:slots-1",
      rev: 0,
      slots: [BREAKFAST, DINNER],
      now: NOW,
    });
    assert.equal(first, "updated");
    const feeding = await readFeeding(harness, context);
    assert.equal(feeding.rev, 1);
    assert.deepEqual(feeding.slots, [BREAKFAST, DINNER]);

    const activity = await harness.snapshot(ActivityDoc, context);
    assert.match(activity?.entries[0]?.summary ?? "", /Alex set the meal schedule \(2 meals\)/);

    // A second save summarises as an update, not a first set.
    assert.equal(
      await updateMealSlots(harness, context, {
        actor,
        actionId: "http:slots-2",
        rev: 1,
        slots: [{ ...BREAKFAST, timeLocal: "07:30" }],
        now: NOW,
      }),
      "updated",
    );
    assert.match(
      (await harness.snapshot(ActivityDoc, context))?.entries[1]?.summary ?? "",
      /Alex updated the meal schedule \(1 meal\)/,
    );

    await assert.rejects(
      updateMealSlots(harness, context, {
        actor,
        actionId: "http:slots-3",
        rev: 2,
        slots: [BREAKFAST, { ...DINNER, timeLocal: "07:00" }],
        now: NOW,
      }),
      DomainConflictError,
      "two meals at the same wall-clock time are refused",
    );
    const after = await readFeeding(harness, context);
    assert.equal(after.rev, 2, "a refused schedule does not burn a revision");
    assert.equal(after.slots.length, 1);
    assert.ok(parseFeeding(after), "the stored document is still a schedule a reader can load");
  });
});

test("a replayed schedule save is success, and a stale one changes nothing", async () => {
  await withHarness(async ({ harness }) => {
    await bootstrapSession(harness, { config: config(owner), context, timezone: "Europe/Paris", now: () => NOON });
    const input = { actor, rev: 0, slots: [BREAKFAST], now: NOW } as const;
    assert.equal(await updateMealSlots(harness, context, { ...input, actionId: "http:s1" }), "updated");
    assert.equal(await updateMealSlots(harness, context, { ...input, actionId: "http:s1" }), "replayed");
    assert.equal((await harness.snapshot(ActivityDoc, context))?.entries.length, 1);

    assert.equal(await updateMealSlots(harness, context, { ...input, actionId: "http:s2" }), "stale");
    assert.equal((await readFeeding(harness, context)).rev, 1);
  });
});

test("a missing feeding document is unavailable, not an empty schedule", async () => {
  await withHarness(async ({ harness }) => {
    // A harness with no bootstrap is a database that predates P1-14: the
    // schedule must refuse rather than claim the household has no meals.
    await assert.rejects(readFeeding(harness, context), FeedingUnavailableError);
  });
});

// --- HTTP, the stream and bootstrap ----------------------------------------

interface Fixture {
  dir: string;
  app: AppHandle;
  url: string;
  alexCookie: string;
  samCookie: string;
}

async function startSetupApp(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-setup-http-"));
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const stores = dataStores(dir);
  await stores.config.ensure();
  const samToken = newToken();
  const now = "2026-10-29T10:00:00.000Z";
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  await stores.config.update((current) => ({
    ...current,
    members: [
      { id: "owner", role: "owner", displayName: "Alex", createdAt: now, sessions: [] },
      {
        id: "partner",
        role: "member",
        displayName: "Sam",
        createdAt: now,
        sessions: [{ tokenHash: hashToken(samToken), createdAt: now, expiresAt: expires }],
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

function cookieFor(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

async function patch(
  fixture: Fixture,
  path: string,
  token: string,
  body: Record<string, unknown>,
  options: { key?: string; omitOrigin?: boolean; omitHeader?: boolean; contentType?: string } = {},
): Promise<Response> {
  return fetch(`${fixture.url}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": options.contentType ?? "application/json",
      ...(options.omitHeader ? {} : { [REQUEST_HEADER]: REQUEST_HEADER_VALUE }),
      ...(options.key === undefined ? {} : { "Idempotency-Key": options.key }),
      Cookie: cookieFor(token),
      ...(options.omitOrigin ? {} : { Origin: fixture.url }),
    },
    body: JSON.stringify(body),
  });
}

async function careView(fixture: Fixture, token: string): Promise<PuppyProfile> {
  const response = await fetch(`${fixture.url}/api/puppy`, { headers: { Cookie: cookieFor(token) } });
  assert.equal(response.status, 200);
  return (await response.json()) as PuppyProfile;
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

test("both setup routes require a session, an origin, the headers and a key", async () => {
  const fixture = await startSetupApp();
  try {
    const anonymous = await fetch(`${fixture.url}/api/household`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", [REQUEST_HEADER]: REQUEST_HEADER_VALUE },
      body: "{}",
    });
    assert.equal(anonymous.status, 401);

    for (const [path, body] of [
      ["/api/household", { rev: 0, timezone: "Europe/Paris" }],
      ["/api/feeding/slots", { rev: 0, slots: [BREAKFAST] }],
    ] as const) {
      assert.equal((await patch(fixture, path, fixture.alexCookie, body, { omitHeader: true })).status, 403, path);
      assert.equal((await patch(fixture, path, fixture.alexCookie, body, { omitOrigin: true })).status, 403, path);
      assert.equal((await patch(fixture, path, fixture.alexCookie, body)).status, 409, `${path} needs a key`);
      const plain = await patch(fixture, path, fixture.alexCookie, body, { key: "k1", contentType: "text/plain" });
      assert.equal(plain.status, 415, `${path} must be application/json`);
      assert.equal((await patch(fixture, path, fixture.alexCookie, { ...body, rev: "0" }, { key: "k1" })).status, 409);
      assert.equal((await patch(fixture, path, fixture.alexCookie, { ...body, extra: true }, { key: "k1" })).status, 409);
    }

    // A member may run setup: it is a care action (§14.1).
    const saved = await patch(
      fixture,
      "/api/household",
      fixture.samCookie,
      { rev: 0, timezone: "Europe/Paris" },
      { key: "sam-1" },
    );
    assert.equal(saved.status, 200);
  } finally {
    await stop(fixture);
  }
});

test("the wizard saves land in the care view and complete the checklist", async () => {
  const fixture = await startSetupApp();
  try {
    const initial = await careView(fixture, fixture.alexCookie);
    assert.deepEqual(initial.setup, { complete: false, missing: ["timezone", "puppy", "meals"] });
    assert.equal(initial.household.timezoneConfirmedAt, null);
    assert.deepEqual(initial.meals.slots, []);

    const zone = await patch(
      fixture,
      "/api/household",
      fixture.alexCookie,
      { rev: initial.household.rev, timezone: "Europe/Paris" },
      { key: "zone-1" },
    );
    assert.equal(zone.status, 200);
    const afterZone = (await zone.json()) as { profile: PuppyProfile; replayed: boolean };
    assert.equal(afterZone.replayed, false);
    assert.equal(afterZone.profile.household.timezone, "Europe/Paris");
    assert.ok(afterZone.profile.household.timezoneConfirmedAt);
    assert.deepEqual(afterZone.profile.setup.missing, ["puppy", "meals"]);

    const puppy = await patch(
      fixture,
      "/api/puppy",
      fixture.alexCookie,
      { rev: afterZone.profile.rev, name: "Biscuit", birthday: "2026-08-08" },
      { key: "puppy-1" },
    );
    assert.equal(puppy.status, 200);
    const afterPuppy = (await puppy.json()) as { profile: PuppyProfile };

    const slots = await patch(
      fixture,
      "/api/feeding/slots",
      fixture.alexCookie,
      { rev: afterPuppy.profile.meals.rev, slots: [BREAKFAST, DINNER] },
      { key: "slots-1" },
    );
    assert.equal(slots.status, 200);
    const final = (await slots.json()) as { profile: PuppyProfile };
    assert.deepEqual(final.profile.meals.slots, [BREAKFAST, DINNER]);
    assert.deepEqual(final.profile.setup, { complete: true, missing: [] });

    // A retried export is the same action, not a second revision or a conflict.
    const retry = await patch(
      fixture,
      "/api/feeding/slots",
      fixture.alexCookie,
      { rev: afterPuppy.profile.meals.rev, slots: [BREAKFAST, DINNER] },
      { key: "slots-1" },
    );
    assert.equal(retry.status, 200);
    assert.equal(((await retry.json()) as { replayed: boolean }).replayed, true);
  } finally {
    await stop(fixture);
  }
});

test("a stale timezone save answers 409 with the current care view", async () => {
  const fixture = await startSetupApp();
  try {
    const initial = await careView(fixture, fixture.alexCookie);
    const first = await patch(
      fixture,
      "/api/household",
      fixture.alexCookie,
      { rev: initial.household.rev, timezone: "Europe/Paris" },
      { key: "alex-1" },
    );
    assert.equal(first.status, 200);

    const stale = await patch(
      fixture,
      "/api/household",
      fixture.samCookie,
      { rev: initial.household.rev, timezone: "America/New_York" },
      { key: "sam-1" },
    );
    assert.equal(stale.status, 409);
    const conflict = (await stale.json()) as { error: string; profile: PuppyProfile };
    assert.equal(conflict.error, "stale");
    assert.equal(conflict.profile.household.timezone, "Europe/Paris");
    assert.equal(conflict.profile.household.rev, 1);

    // Sam re-reads and replaces it knowingly.
    const second = await patch(
      fixture,
      "/api/household",
      fixture.samCookie,
      { rev: conflict.profile.household.rev, timezone: "America/New_York" },
      { key: "sam-2" },
    );
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { profile: PuppyProfile }).profile.household.timezone, "America/New_York");
  } finally {
    await stop(fixture);
  }
});

test("a bad timezone is refused and the stored zone is untouched", async () => {
  const fixture = await startSetupApp();
  try {
    const initial = await careView(fixture, fixture.alexCookie);
    const refused = await patch(
      fixture,
      "/api/household",
      fixture.alexCookie,
      { rev: initial.household.rev, timezone: "Mars/Olympus" },
      { key: "bad-zone" },
    );
    assert.equal(refused.status, 409);
    const after = await careView(fixture, fixture.alexCookie);
    assert.equal(after.household.timezone, initial.household.timezone);
    assert.equal(after.household.rev, initial.household.rev);
  } finally {
    await stop(fixture);
  }
});

test("a timezone save and a meal save each reach the other caregiver as a profile frame", async () => {
  const fixture = await startSetupApp();
  try {
    const response = await fetch(`${fixture.url}/api/agent/events`, {
      headers: { Cookie: cookieFor(fixture.samCookie) },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    await nextFrame(reader, (event) => event === "snapshot");

    const initial = await careView(fixture, fixture.alexCookie);
    const zone = await patch(
      fixture,
      "/api/household",
      fixture.alexCookie,
      { rev: initial.household.rev, timezone: "Europe/Paris" },
      { key: "frame-zone" },
    );
    assert.equal(zone.status, 200);
    const zoneFrame = await nextFrame(reader, (event) => event === "profile");
    const zoneView = zoneFrame.data as PuppyProfile;
    assert.equal(zoneView.household.timezone, "Europe/Paris");
    assert.deepEqual(zoneView.setup.missing, ["puppy", "meals"]);

    const slots = await patch(
      fixture,
      "/api/feeding/slots",
      fixture.alexCookie,
      { rev: zoneView.meals.rev, slots: [BREAKFAST] },
      { key: "frame-slots" },
    );
    assert.equal(slots.status, 200);
    const slotFrame = await nextFrame(reader, (event) => event === "profile");
    const slotView = slotFrame.data as PuppyProfile;
    assert.deepEqual(slotView.meals.slots, [BREAKFAST]);
    assert.deepEqual(slotView.setup.missing, ["puppy"]);
  } finally {
    await stop(fixture);
  }
});

test("a household-less database with a feeding document is refused, not reset", async () => {
  await withHarness(async ({ harness }) => {
    await harness.commit(async (tx) => {
      Object.assign(await tx.doc(FeedingDoc), {
        schemaVersion: 2,
        rev: 0,
        slots: [],
        events: [],
        createdAt: NOW.toISOString(),
      });
    }, context);

    await assert.rejects(
      bootstrapSession(harness, {
        config: config(owner),
        context,
        timezone: "Europe/Paris",
        now: () => NOON,
      }),
      /app\.household is missing but app\.feeding exists/,
    );
    assert.ok(await harness.snapshot(FeedingDoc, context), "nothing was reset");
  });
});

test("a database from before P1-14 boots through the household migration and gets a feeding document", async () => {
  // A stored version-1 household: the document version is what the definition
  // that created it wrote, so this test-side definition is how a P1-13
  // database is reproduced. The build's own definition (version 2) must read
  // it through `migrate`, not refuse it.
  const LegacyHouseholdDoc = defineDoc<Record<string, never>>({
    kind: "app.household",
    version: 1,
    scope: "session",
    initial: () => ({}) as Record<string, never>,
    checkpointWhen: () => false,
  });

  await withHarness(async ({ harness }) => {
    const ids = await harness.commit(async (tx) => {
      const shared = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const system = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const legacy = await tx.doc(LegacyHouseholdDoc);
      Object.assign(legacy as unknown as Record<string, unknown>, {
        schemaVersion: 1,
        name: "Our household",
        timezone: "Europe/Paris",
        members: [{ id: "owner", name: "Alex" }],
        conversationId: shared.id,
        systemConversationId: system.id,
        createdAt: NOW.toISOString(),
        settings: {
          feedReminderDelayMin: 15,
          appointmentReminderOffsetsMin: [1440, 60],
          showerIntervalDays: 21,
          agentBudgetUsd: 10,
        },
      });
      return { shared: shared.id, system: system.id };
    }, context);
    assert.ok(ids.shared > 0);

    const boot = await bootstrapSession(harness, {
      config: config(owner),
      context,
      timezone: "Europe/Paris",
      now: () => NOON,
    });
    assert.equal(boot.created, false, "the household was migrated, not reset");
    assert.deepEqual(boot.docsCreated.sort(), [
      "app.activity",
      "app.commands",
      "app.feeding",
      "app.notifications",
      "app.puppy",
      "app.walks",
    ]);

    const household = await readHousehold(harness, context);
    assert.equal(household.timezone, "Europe/Paris", "the captured zone is kept");
    assert.equal(household.rev, 0);
    assert.equal(household.timezoneConfirmedAt, null, "the wizard asks for the zone once");
    assert.equal((await readFeeding(harness, context)).slots.length, 0);

    // The migrated household is a document this build can write to.
    assert.equal(
      await updateHouseholdTimezone(harness, context, {
        actor,
        actionId: "http:upgraded-1",
        rev: household.rev,
        timezone: "Europe/Paris",
        now: NOW,
      }),
      "updated",
    );
    assert.equal((await readHousehold(harness, context)).rev, 1);
  });
});

test("a caregiver the household does not carry yet writes as the household fallback", async () => {
  const fixture = await startSetupApp();
  try {
    // The invite's household mirror failed: config knows Sam, the document does
    // not. The write still lands, attributed as the household — never as a real
    // member id paired with the fallback label (§15.3).
    await fixture.app.app.commit(async (tx) => {
      const draft = await tx.doc(HouseholdDoc);
      draft.members = draft.members.filter((member) => member.id !== "partner");
    }, context);

    const saved = await patch(
      fixture,
      "/api/household",
      fixture.samCookie,
      { rev: 0, timezone: "Europe/Paris" },
      { key: "sam-first" },
    );
    assert.equal(saved.status, 200);
    const entries = (await fixture.app.app.snapshot(ActivityDoc, context))?.entries ?? [];
    const last = entries[entries.length - 1];
    assert.equal(last?.actorId, null);
    assert.equal(last?.actorLabel, "Household");
  } finally {
    await stop(fixture);
  }
});
