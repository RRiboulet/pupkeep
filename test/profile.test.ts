// P1-11: the puppy profile (PLAN §7.4, §8.1, §10.1/§10.2, §13.1, §15.1/§15.3).
//
// Three layers are covered here:
//   * the derived parts — local dates and age — as pure functions;
//   * the domain service over a real SQLite harness: revision conflict,
//     idempotent replay, one activity entry per accepted change, and the
//     migration that gives a P1-08 document its `rev`;
//   * the HTTP surface, the `profile` SSE frame and the agent tools, including
//     one real faux-provider run so the registry wiring is proven, not assumed.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { SESSION_COOKIE, Auth, hashToken, newToken } from "../src/server/auth.ts";
import { createProfileTools } from "../src/server/agent/tools.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { dataStores } from "../src/server/config.ts";
import { emptyConfig, type AppConfig, type MemberRecord } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import { ActivityDoc, HouseholdDoc, PuppyDoc, parsePuppy } from "../src/server/domain/docs.ts";
import { DomainConflictError } from "../src/server/domain/errors.ts";
import {
  ProfileUnavailableError,
  readProfile,
  updatePuppyProfile,
  type ProfileStore,
} from "../src/server/domain/profile.ts";
import { ageOf, addMonths, localDateAt, monthsBetween } from "../src/server/domain/time.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import { createLogger } from "../src/server/log.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import type { PuppyProfile } from "../src/shared/profile.ts";

const context = BACKGROUND_CONTEXT;
const OWNER_LABEL = "Alex";

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "owner",
    role: "owner",
    displayName: OWNER_LABEL,
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

const actor = async () => ({ id: "owner", label: OWNER_LABEL });

// --- derived values ---------------------------------------------------------

test("a local date is the household's date, not the UTC one", () => {
  const lateEvening = new Date("2026-10-29T23:30:00.000Z");
  assert.equal(localDateAt(lateEvening, "UTC"), "2026-10-29");
  assert.equal(localDateAt(lateEvening, "Europe/Paris"), "2026-10-30");
  assert.equal(localDateAt(new Date("2026-10-29T00:30:00.000Z"), "America/New_York"), "2026-10-28");
  // A zone Intl refuses must not silently become the system zone.
  assert.equal(localDateAt(lateEvening, "Not/AZone"), "2026-10-29");
});

test("age switches days → weeks → months → years and clamps a future birthday", () => {
  assert.deepEqual(ageOf(null, "2026-10-29"), null);
  assert.equal(ageOf("2026-10-29", "2026-10-29")?.label, "born today");
  assert.equal(ageOf("2026-10-28", "2026-10-29")?.label, "1 day old");
  assert.equal(ageOf("2026-10-22", "2026-10-29")?.label, "1 week old");
  assert.equal(ageOf("2026-10-24", "2026-10-29")?.label, "5 days old", "still days under a week");
  assert.equal(ageOf("2026-10-16", "2026-10-29")?.label, "1 week old", "13 days reads as one week, not thirteen days");
  assert.equal(ageOf("2026-08-08", "2026-10-29")?.label, "11 weeks old");
  assert.equal(ageOf("2026-07-29", "2026-10-29")?.label, "13 weeks old", "weeks up to 20, then months");
  assert.equal(ageOf("2026-05-29", "2026-10-29")?.label, "5 months old");
  assert.equal(ageOf("2025-10-29", "2026-10-29")?.label, "1 year old");
  assert.equal(ageOf("2024-08-29", "2026-10-29")?.label, "2 years, 2 months old");
  // A timezone move can make a real birthday look one day ahead for a few hours.
  assert.equal(ageOf("2026-10-30", "2026-10-29")?.days, 0);
});

test("calendar months clamp the day instead of averaging a month", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
  assert.equal(monthsBetween("2026-01-31", "2026-02-28"), 1);
  assert.equal(monthsBetween("2026-01-31", "2026-02-27"), 0);
  assert.equal(monthsBetween("2026-06-01", "2026-06-01"), 0);
});

// --- documents --------------------------------------------------------------

test("a version-1 app.puppy document migrates to rev 0 instead of failing boot", () => {
  const migrate = PuppyDoc.definition.migrate;
  assert.ok(migrate, "the document declares its migration");
  const legacy = {
    schemaVersion: 1,
    name: "Biscuit",
    birthday: "2026-08-08",
    breed: "Beagle",
    sex: "female",
    targetWeightKg: 12,
    createdAt: "2026-10-29T10:00:00.000Z",
  };
  const migrated = migrate(legacy as never, 1);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.rev, 0);
  assert.equal(migrated.name, "Biscuit");
  assert.throws(() => migrate(legacy as never, 0), /no migration/);
});

// --- domain service ---------------------------------------------------------

async function withProfileHarness(
  run: (opened: OpenedHarness) => Promise<void>,
  timezone = "Europe/Paris",
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-profile-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models });
  try {
    await bootstrapSession(opened.harness, {
      config: config(owner, partner),
      context,
      timezone,
      now: () => new Date("2026-10-29T12:00:00.000Z"),
    });
    await run(opened);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

const NOON = new Date("2026-10-29T12:00:00.000Z");

test("an edit bumps rev, appends one activity entry and returns the derived view", async () => {
  await withProfileHarness(async ({ harness }) => {
    const store: ProfileStore = harness;
    const outcome = await updatePuppyProfile(store, context, {
      actor,
      actionId: "action-1",
      rev: 0,
      patch: { name: "Biscuit", birthday: "2026-08-08", breed: "Beagle", sex: "female", targetWeightKg: 12 },
      now: NOON,
    });

    assert.equal(outcome.kind, "updated");
    const profile = outcome.profile;
    assert.equal(profile.rev, 1);
    assert.equal(profile.puppy.name, "Biscuit");
    assert.equal(profile.age?.label, "11 weeks old");
    assert.equal(profile.today, "2026-10-29");
    assert.equal(profile.household.timezone, "Europe/Paris");
    assert.deepEqual(profile.household.members, [
      { id: "owner", name: "Alex" },
      { id: "partner", name: "Sam" },
    ]);

    const activity = await harness.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries.length, 1);
    assert.equal(activity?.entries[0]?.kind, "profile.updated");
    assert.equal(activity?.entries[0]?.actorId, "owner");
    assert.equal(activity?.entries[0]?.actorLabel, "Alex");
    assert.match(activity?.entries[0]?.summary ?? "", /added Biscuit to the household/);

    const commands = await harness.snapshot(PuppyDoc, context);
    assert.equal(commands?.rev, 1);
  });
});

test("the same action replayed is success; the same key with another request is a conflict", async () => {
  await withProfileHarness(async ({ harness }) => {
    const store: ProfileStore = harness;
    const first = await updatePuppyProfile(store, context, {
      actor,
      actionId: "action-1",
      rev: 0,
      patch: { name: "Biscuit" },
      now: NOON,
    });
    assert.equal(first.kind, "updated");

    // The response was lost: the browser retries the *same* request with the
    // same key, and the current revision is now 1.
    const replay = await updatePuppyProfile(store, context, {
      actor,
      actionId: "action-1",
      rev: 0,
      patch: { name: "Biscuit" },
      now: NOON,
    });
    assert.equal(replay.kind, "replayed");
    assert.equal(replay.profile.rev, 1, "a replay does not bump the revision again");

    const activityAfterReplay = await harness.snapshot(ActivityDoc, context);
    assert.equal(activityAfterReplay?.entries.length, 1, "a replay writes no second activity entry");

    const conflict = await updatePuppyProfile(store, context, {
      actor,
      actionId: "action-1",
      rev: 1,
      patch: { name: "Not Biscuit" },
      now: NOON,
    });
    assert.equal(conflict.kind, "key-conflict");
    const puppy = parsePuppy(await harness.snapshot(PuppyDoc, context));
    assert.equal(puppy?.name, "Biscuit");
  });
});

test("a stale revision is refused with the current profile, not overwritten", async () => {
  await withProfileHarness(async ({ harness }) => {
    const store: ProfileStore = harness;
    await updatePuppyProfile(store, context, {
      actor,
      actionId: "alex-1",
      rev: 0,
      patch: { name: "Biscuit", breed: "Beagle" },
      now: NOON,
    });
    // Sam was looking at revision 0 when Alex saved.
    const stale = await updatePuppyProfile(store, context, {
      actor: async () => ({ id: "partner", label: "Sam" }),
      actionId: "sam-1",
      rev: 0,
      patch: { breed: "Poodle" },
      now: NOON,
    });
    assert.equal(stale.kind, "stale");
    assert.equal(stale.profile.rev, 1);
    assert.equal(stale.profile.puppy.breed, "Beagle", "the conflict answer carries the current values");

    const activity = await harness.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries.length, 1, "the refused write leaves no trace");
  });
});

test("a birthday in the household's future is refused, and clearing a field works", async () => {
  await withProfileHarness(async ({ harness }) => {
    const store: ProfileStore = harness;
    await assert.rejects(
      updatePuppyProfile(store, context, {
        actor,
        actionId: "future",
        rev: 0,
        patch: { name: "Biscuit", birthday: "2026-10-30" },
        now: NOON,
      }),
      DomainConflictError,
    );

    const cleared = await updatePuppyProfile(store, context, {
      actor,
      actionId: "clear",
      rev: 0,
      patch: { name: "Biscuit", birthday: "2026-08-08", breed: "Beagle" },
      now: NOON,
    });
    assert.equal(cleared.kind, "updated");
    const clearedAgain = await updatePuppyProfile(store, context, {
      actor,
      actionId: "clear-2",
      rev: cleared.profile.rev,
      patch: { breed: null },
      now: NOON,
    });
    assert.equal(clearedAgain.kind, "updated");
    assert.equal(clearedAgain.profile.puppy.breed, null);
    assert.equal(clearedAgain.profile.puppy.birthday, "2026-08-08", "an absent field is untouched");
  });
});

test("the profile is unavailable, not empty, when the puppy document is gone", async () => {
  await withProfileHarness(async ({ harness }) => {
    await harness.commit((tx: Tx) => tx.retireDoc(PuppyDoc), context);
    await assert.rejects(readProfile(harness, context, NOON), ProfileUnavailableError);
  });
});

// --- HTTP, SSE and the agent tools ------------------------------------------

type ResponseStep = AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

interface Fixture {
  dir: string;
  app: AppHandle;
  url: string;
  faux: ReturnType<typeof fauxProvider>;
  alexCookie: string;
  samCookie: string;
}

async function startProfileApp(responses: readonly ResponseStep[] = [() => fauxAssistantMessage("Done.")]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-profile-http-"));
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);

  const stores = dataStores(dir);
  await stores.config.ensure();
  const samToken = newToken();
  const now = "2026-10-29T10:00:00.000Z";
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  await stores.config.update((current) => ({
    ...current,
    members: [
      { id: "owner", role: "owner", displayName: OWNER_LABEL, createdAt: now, sessions: [] },
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
  return { dir, app: result.app, url: result.app.url, faux, alexCookie, samCookie: samToken };
}

async function stop(fixture: Fixture): Promise<void> {
  await fixture.app.close();
  await rm(fixture.dir, { recursive: true, force: true });
}

function cookieFor(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

async function getProfile(fixture: Fixture, token: string): Promise<Response> {
  return fetch(`${fixture.url}/api/puppy`, { headers: { Cookie: cookieFor(token) } });
}

async function patchProfile(
  fixture: Fixture,
  token: string,
  body: Record<string, unknown>,
  options: { key?: string; omitOrigin?: boolean; omitHeader?: boolean } = {},
): Promise<Response> {
  return fetch(`${fixture.url}/api/puppy`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(options.omitHeader ? {} : { [REQUEST_HEADER]: REQUEST_HEADER_VALUE }),
      ...(options.key === undefined ? {} : { "Idempotency-Key": options.key }),
      Cookie: cookieFor(token),
      ...(options.omitOrigin ? {} : { Origin: fixture.url }),
    },
    body: JSON.stringify(body),
  });
}

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, budgetMs = 5000): Promise<T> {
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

test("GET and PATCH require a session, an origin, the request header and a key", async () => {
  const fixture = await startProfileApp();
  try {
    const anonymous = await fetch(`${fixture.url}/api/puppy`);
    assert.equal(anonymous.status, 401);

    const noKey = await patchProfile(fixture, fixture.alexCookie, { rev: 0, name: "Biscuit" });
    assert.equal(noKey.status, 409, "an edit without an idempotency key is refused");

    const noHeader = await patchProfile(fixture, fixture.alexCookie, { rev: 0, name: "Biscuit" }, { key: "k1", omitHeader: true });
    assert.equal(noHeader.status, 403);

    const noOrigin = await patchProfile(fixture, fixture.alexCookie, { rev: 0, name: "Biscuit" }, { key: "k1", omitOrigin: true });
    assert.equal(noOrigin.status, 403);

    const noRev = await patchProfile(fixture, fixture.alexCookie, { name: "Biscuit" }, { key: "k1" });
    assert.equal(noRev.status, 409);

    const unknownField = await patchProfile(fixture, fixture.alexCookie, { rev: 0, nickname: "Bisc" }, { key: "k1" });
    assert.equal(unknownField.status, 409);

    const empty = await getProfile(fixture, fixture.alexCookie);
    assert.equal(empty.status, 200);
    const body = (await empty.json()) as PuppyProfile;
    assert.equal(body.rev, 0);
    assert.equal(body.puppy.name, "");
    assert.equal(body.household.members.length, 2);
  } finally {
    await stop(fixture);
  }
});

test("two caregivers edit the profile over HTTP: one wins, the other gets the current profile", async () => {
  const fixture = await startProfileApp();
  try {
    const first = await patchProfile(fixture, fixture.alexCookie, { rev: 0, name: "Biscuit", breed: "Beagle" }, { key: "alex-1" });
    assert.equal(first.status, 200);
    const saved = (await first.json()) as { profile: PuppyProfile; replayed: boolean };
    assert.equal(saved.replayed, false);
    assert.equal(saved.profile.rev, 1);

    // A retried save is success, not a second revision.
    const replay = await patchProfile(fixture, fixture.alexCookie, { rev: 0, name: "Biscuit", breed: "Beagle" }, { key: "alex-1" });
    assert.equal(replay.status, 200);
    const replayed = (await replay.json()) as { profile: PuppyProfile; replayed: boolean };
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.profile.rev, 1);

    // Sam still holds revision 0.
    const stale = await patchProfile(fixture, fixture.samCookie, { rev: 0, breed: "Poodle" }, { key: "sam-1" });
    assert.equal(stale.status, 409);
    const conflict = (await stale.json()) as { error: string; profile: PuppyProfile };
    assert.equal(conflict.error, "stale");
    assert.equal(conflict.profile.rev, 1);
    assert.equal(conflict.profile.puppy.breed, "Beagle");

    // Sam re-reads and saves against the new revision.
    const accepted = await patchProfile(fixture, fixture.samCookie, { rev: conflict.profile.rev, breed: "Poodle" }, { key: "sam-2" });
    assert.equal(accepted.status, 200);
    const final = (await accepted.json()) as { profile: PuppyProfile };
    assert.equal(final.profile.rev, 2);
    assert.equal(final.profile.puppy.breed, "Poodle");
    assert.equal(final.profile.puppy.name, "Biscuit");

    // Both keys together must not resurrect the older revision.
    const reused = await patchProfile(fixture, fixture.samCookie, { rev: 2, breed: "Poodle", name: "Other" }, { key: "sam-2" });
    assert.equal(reused.status, 409);
  } finally {
    await stop(fixture);
  }
});

test("a profile edit reaches the other caregiver's event stream as a profile frame", async () => {
  const fixture = await startProfileApp();
  try {
    const response = await fetch(`${fixture.url}/api/agent/events`, {
      headers: { Cookie: cookieFor(fixture.samCookie) },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    // Sam's stream is attached; Alex edits from another device.
    const reader = response.body!.getReader();
    await nextFrame(reader, (event) => event === "snapshot");
    const saved = await patchProfile(fixture, fixture.alexCookie, { rev: 0, name: "Biscuit" }, { key: "alex-sse" });
    assert.equal(saved.status, 200);

    const frame = await nextFrame(reader, (event) => event === "profile");
    const profile = frame.data as PuppyProfile;
    assert.equal(profile.rev, 1);
    assert.equal(profile.puppy.name, "Biscuit");
  } finally {
    await stop(fixture);
  }
});

test("a profile change does not wake the long-poll fallback, which is thread-only", async () => {
  const fixture = await startProfileApp();
  try {
    const started = Date.now();
    // Start from the thread's current counter: a fresh conversation already has
    // one batch (the agent configuration), so `since=0` would settle at once.
    const seq = fixture.app.threadBus?.seq ?? 0;
    const poll = fetch(`${fixture.url}/api/agent/events/poll?since=${seq}&ms=1200`, {
      headers: { Cookie: cookieFor(fixture.samCookie) },
    });
    // Let the poll attach before the write, so a seq bump would wake it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const saved = await patchProfile(fixture, fixture.alexCookie, { rev: 0, name: "Biscuit" }, { key: "alex-poll" });
    assert.equal(saved.status, 200);
    assert.equal(fixture.app.threadBus?.seq, seq, "a profile change is not thread news");

    const response = await poll;
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200, "the fallback answers with a full snapshot");
    assert.ok(elapsed >= 1100, `the poll waited out its window instead of waking early (${elapsed} ms)`);
    const snapshot = (await response.json()) as { entries: unknown[] };
    assert.ok(Array.isArray(snapshot.entries));
  } finally {
    await stop(fixture);
  }
});

/** A tool-execution API stand-in: committed reads, one commit, a fixed task id. */
function toolApi(fixture: Fixture, conversationId: number, taskId = "task-1"): ToolExecutionApi {
  return {
    taskId,
    conversationId: conversationId as ConversationId,
    now: () => Date.now(),
    snapshot: (token: never, ctx: never) => fixture.app.app.snapshot(token, ctx),
    commit: (change: never, ctx: never) => fixture.app.app.commit(change, ctx),
  } as unknown as ToolExecutionApi;
}

async function sharedConversationId(fixture: Fixture): Promise<number> {
  const household = await fixture.app.app.snapshot(HouseholdDoc, context);
  return household!.conversationId;
}

test("the tools read the profile, report what is not tracked, and attribute the write to the speaker", async () => {
  const fixture = await startProfileApp();
  try {
    const tools = createProfileTools().tools ?? [];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const getContext = byName.get("get_context");
    const getPuppy = byName.get("get_puppy");
    const update = byName.get("update_puppy_profile");
    assert.ok(getContext && getPuppy && update, "the extension provides all three tools");
    assert.equal(update.replay, "safe", "the domain write is idempotent on the task id");

    const conversationId = await sharedConversationId(fixture);
    const api = toolApi(fixture, conversationId, "task-42");

    const empty = await getContext!.execute({}, api, context);
    const emptyText = (empty.output as { text: string }[])[0]!.text;
    assert.match(emptyText, /caregivers: Alex, Sam/);
    assert.match(emptyText, /Not tracked by this build yet: meals/);

    const saved = await update!.execute({ rev: 0, name: "Biscuit", breed: "Beagle" }, api, context);
    const savedText = (saved.output as { text: string }[])[0]!.text;
    assert.match(savedText, /^Saved: name "Biscuit"/);

    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries.length, 1);
    // No chat entry in this transcript, so the actor is the household fallback
    // rather than a name the model supplied.
    assert.equal(activity?.entries[0]?.actorId, null);
    assert.equal(activity?.entries[0]?.actorLabel, "Household");

    const contextText = (await getPuppy!.execute({}, api, context)).output as { text: string }[];
    assert.match(contextText[0]!.text, /Biscuit/);

    // A second write with the *same* task id replays; a stale revision is an
    // error result that tells the model to re-read.
    const replay = await update!.execute({ rev: 0, name: "Biscuit", breed: "Beagle" }, api, context);
    assert.match((replay.output as { text: string }[])[0]!.text, /^Already saved:/);
    const stale = await update!.execute({ rev: 0, name: "Other" }, toolApi(fixture, conversationId, "task-43"), context);
    assert.equal(stale.isError, true);
    assert.match((stale.output as { text: string }[])[0]!.text, /Call get_puppy/);
  } finally {
    await stop(fixture);
  }
});

test("a real run calls the profile tool, and the activity entry names the caregiver who spoke", async () => {
  const fixture = await startProfileApp([
    () => fauxAssistantMessage([fauxToolCall("update_puppy_profile", { rev: 0, name: "Biscuit" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("Named the pup Biscuit."),
  ]);
  try {
    const posted = await fetch(`${fixture.url}/api/agent/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        Cookie: cookieFor(fixture.alexCookie),
        Origin: fixture.url,
      },
      body: JSON.stringify({ text: "The pup is Biscuit", clientMessageId: "m-profile-1" }),
    });
    assert.equal(posted.status, 202);

    const puppy = await until(async () => {
      const snapshot = await fixture.app.app.snapshot(PuppyDoc, context);
      return snapshot?.name === "Biscuit" ? snapshot : undefined;
    });
    assert.equal(puppy.rev, 1);

    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries[0]?.actorId, "owner");
    assert.equal(activity?.entries[0]?.actorLabel, "Alex");
    assert.match(activity?.entries[0]?.summary ?? "", /Alex added Biscuit/);

    const transcript = await until(async () => {
      const response = await fetch(`${fixture.url}/api/agent/thread`, {
        headers: { Cookie: cookieFor(fixture.alexCookie) },
      });
      const snapshot = (await response.json()) as { entries: { kind: string; toolName?: string; byLabel?: string; status?: string }[] };
      const tool = snapshot.entries.find((entry) => entry.kind === "tool");
      return tool ? snapshot.entries : undefined;
    });
    const card = transcript.find((entry) => entry.kind === "tool")!;
    assert.equal(card.toolName, "update_puppy_profile");
    assert.equal(card.status, "ok");
    assert.equal(card.byLabel, "Alex");
  } finally {
    await stop(fixture);
  }
});
