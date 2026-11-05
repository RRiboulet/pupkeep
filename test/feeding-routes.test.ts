// P2-03: the feed HTTP surface (PLAN §16 Phase 2, §7.3, §7.4, §13.1, §14.2).
//
// What is covered:
//   * the day view: the household-local date, the active slots with who fed
//     each and when, and the extras — the same `feedingDay` the agent tool
//     (P2-04) and the Today screen (P2-05) will use;
//   * logging a scheduled meal and an extra feeding over real HTTP against a
//     real SQLite harness, including the committed day in the answer;
//   * the 409 family: a second caregiver on a fed slot (`already_fed` with
//     who/when and the current day), a reused key with another body, an unknown
//     or inactive slot, and the shared mutation refusals (auth, origin,
//     `X-Pupkeep-Request`, content type, `Idempotency-Key`);
//   * `Cache-Control: no-store` on every answer (§14.2), so a phone never shows
//     a cached meal.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import type { FeedEvent, MealSlot } from "../src/shared/domain.ts";
import type { FeedWriteView, MealDayView } from "../src/shared/feeding.ts";
import type { PuppyProfile } from "../src/shared/profile.ts";
import { startTestApp, type TestApp } from "./support/app.ts";

const SLOTS: MealSlot[] = [
  { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true },
  { id: "slot-d", label: "Dinner", timeLocal: "18:00", portion: "80 g", active: true },
  // Inactive on purpose: it stays in the schedule but cannot be fed (P1-14).
  { id: "slot-off", label: "Lunch", timeLocal: "12:00", active: false },
];

type Fixture = TestApp & { alexCookie: string; samCookie: string };

async function startFixture(options: { now?: () => number } = {}): Promise<Fixture> {
  const base = await startTestApp({
    prefix: "pupkeep-feed-routes-",
    ...(options.now === undefined ? {} : { now: options.now }),
    partner: true,
  });
  const fixture: Fixture = { ...base, alexCookie: base.cookies.owner, samCookie: base.cookies.partner! };

  // The schedule is P1-14's write, over its own route: this test wants a real
  // `app.feeding`, not a hand-written document.
  const schedule = await mutate(fixture, "PATCH", "/api/feeding/slots", fixture.alexCookie, {
    body: { rev: 0, slots: SLOTS },
    key: "schedule-1",
  });
  assert.equal(schedule.status, 200, "the meal schedule must be storable");
  return fixture;
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

async function mutate(
  fixture: Fixture,
  method: "POST" | "PATCH",
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
  return fetch(`${fixture.url}${path}`, {
    method,
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
}

async function getDay(fixture: Fixture, token: string): Promise<{ day: MealDayView; response: Response }> {
  const response = await fetch(`${fixture.url}/api/feeding/day`, { headers: { Cookie: cookieFor(token) } });
  assert.equal(response.status, 200);
  return { day: (await response.json()) as MealDayView, response };
}

async function careView(fixture: Fixture, token: string): Promise<PuppyProfile> {
  const response = await fetch(`${fixture.url}/api/puppy`, { headers: { Cookie: cookieFor(token) } });
  assert.equal(response.status, 200);
  return (await response.json()) as PuppyProfile;
}

async function logFed(
  fixture: Fixture,
  token: string,
  body: Record<string, unknown>,
  key: string,
): Promise<Response> {
  return mutate(fixture, "POST", "/api/feeding/fed", token, { body, key });
}

async function logExtra(fixture: Fixture, token: string, body: Record<string, unknown>, key: string): Promise<Response> {
  return mutate(fixture, "POST", "/api/feeding/extra", token, { body, key });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

// --- the day view -----------------------------------------------------------

test("the day view is the local date's active slots, the feed that claimed one, and extras", async () => {
  const fixture = await startFixture();
  try {
    const today = (await careView(fixture, fixture.alexCookie)).today;

    const empty = await getDay(fixture, fixture.alexCookie);
    assert.equal(empty.day.localDate, today, "the date is the household's, not UTC's");
    assert.equal(empty.day.overdueAfterMin, 15, "§12.1's reminder delay rides with the day");
    assert.deepEqual(
      empty.day.slots.map((entry) => entry.slot.id),
      ["slot-b", "slot-d"],
      "inactive slots are not offered, and slots are in time order",
    );
    assert.deepEqual(empty.day.slots.map((entry) => entry.feed), [null, null]);
    assert.deepEqual(empty.day.events, []);
    assert.deepEqual(empty.day.extras, []);
    assert.match(empty.response.headers.get("cache-control") ?? "", /no-store/);

    const fed = await logFed(fixture, fixture.alexCookie, { slotId: "slot-b", amount: " 80 g " }, "feed-1");
    assert.equal(fed.status, 200);
    const written = await json<FeedWriteView>(fed);
    assert.equal(written.feed.slotId, "slot-b");
    assert.equal(written.feed.localDate, today);
    assert.equal(written.feed.byLabel, "Alex");
    assert.equal(written.feed.byUserId, "owner");
    assert.equal(written.feed.source, "ui");
    assert.equal(written.feed.actionId, "http:feed-1", "a client key cannot collide with a tool id");
    assert.equal(written.feed.amount, "80 g", "the value is trimmed by the domain");
    assert.equal(written.replayed, false);
    assert.match(fed.headers.get("cache-control") ?? "", /no-store/, "a write is never cached either");
    assert.equal(written.day.slots[0]?.feed?.id, written.feed.id, "the answer carries the committed day");
    assert.equal(written.day.slots[1]?.feed, null);

    const extra = await logExtra(fixture, fixture.alexCookie, { note: "training treat" }, "feed-2");
    assert.equal(extra.status, 200);
    const writtenExtra = await json<FeedWriteView>(extra);
    assert.equal(writtenExtra.feed.slotId, null, "an extra feeding never claims a slot");
    assert.equal(writtenExtra.day.extras.length, 1);
    assert.equal(writtenExtra.day.extras[0]?.note, "training treat");

    // The partner sees the same committed day, not a private copy (§9.4).
    const sam = await getDay(fixture, fixture.samCookie);
    assert.equal(sam.day.slots[0]?.feed?.id, written.feed.id);
    assert.equal(sam.day.extras.length, 1);
    assert.equal(sam.day.events.length, 2);
  } finally {
    await fixture.stop();
  }
});

// --- the 409 family ---------------------------------------------------------

test("a second caregiver on a fed slot is a 409 with who/when and the current day", async () => {
  const fixture = await startFixture();
  try {
    const first = await logFed(fixture, fixture.alexCookie, { slotId: "slot-b" }, "alex-feed");
    assert.equal(first.status, 200);
    const { feed } = await json<FeedWriteView>(first);

    const conflict = await logFed(fixture, fixture.samCookie, { slotId: "slot-b" }, "sam-feed");
    assert.equal(conflict.status, 409);
    const body = await json<{ error: string; message: string; feed: FeedEvent; day: MealDayView }>(conflict);
    assert.equal(body.error, "already_fed");
    assert.match(body.message, /Alex already logged this meal at \d{2}:\d{2}/);
    assert.equal(body.feed.id, feed.id, "the committed record, not a new attempt");
    assert.equal(body.feed.byLabel, "Alex");
    assert.equal(body.day.localDate, feed.localDate);
    assert.equal(body.day.slots[0]?.feed?.id, feed.id, "the client can render the conflict in place");

    const day = await getDay(fixture, fixture.alexCookie);
    assert.equal(day.day.events.length, 1, "the conflict wrote no second event");
  } finally {
    await fixture.stop();
  }
});

test("the same key and body replays as success; the same key with another body is a key conflict", async () => {
  const fixture = await startFixture();
  try {
    const first = await logFed(fixture, fixture.alexCookie, { slotId: "slot-b", note: "quick" }, "same-key");
    assert.equal(first.status, 200);
    const { feed } = await json<FeedWriteView>(first);

    const replay = await logFed(fixture, fixture.alexCookie, { slotId: "slot-b", note: "quick" }, "same-key");
    assert.equal(replay.status, 200);
    const replayed = await json<FeedWriteView>(replay);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.feed.id, feed.id, "a retry is the same meal");

    const other = await logFed(fixture, fixture.alexCookie, { slotId: "slot-b", note: "changed" }, "same-key");
    assert.equal(other.status, 409);
    assert.equal((await json<{ error: string }>(other)).error, "idempotency_conflict");

    const day = await getDay(fixture, fixture.alexCookie);
    assert.equal(day.day.events.length, 1);
  } finally {
    await fixture.stop();
  }
});

test("an unknown or inactive slot, and a malformed body, are refused without writing", async () => {
  const fixture = await startFixture();
  try {
    const unknown = await logFed(fixture, fixture.alexCookie, { slotId: "slot-gone" }, "unknown-slot");
    assert.equal(unknown.status, 409);
    assert.match((await json<{ error: string }>(unknown)).error, /no longer in the schedule/);

    const inactive = await logFed(fixture, fixture.alexCookie, { slotId: "slot-off" }, "inactive-slot");
    assert.equal(inactive.status, 409);
    assert.match((await json<{ error: string }>(inactive)).error, /not active/);

    const noSlot = await logFed(fixture, fixture.alexCookie, {}, "no-slot");
    assert.equal(noSlot.status, 409);
    assert.match((await json<{ error: string }>(noSlot)).error, /needs the slot/);

    const extraWithSlot = await logExtra(fixture, fixture.alexCookie, { slotId: "slot-b" }, "extra-slot");
    assert.equal(extraWithSlot.status, 409, "an extra feeding cannot name a slot");
    assert.match((await json<{ error: string }>(extraWithSlot)).error, /does not accept "slotId"/);

    const notText = await logExtra(fixture, fixture.alexCookie, { note: 5 }, "extra-note");
    assert.equal(notText.status, 409);
    assert.match((await json<{ error: string }>(notText)).error, /note is text/);

    const day = await getDay(fixture, fixture.alexCookie);
    assert.equal(day.day.events.length, 0, "every refusal left the day untouched");
  } finally {
    await fixture.stop();
  }
});

// --- the shared mutation guards ---------------------------------------------

test("the feed routes need a session, an origin, the request header, JSON and a key", async () => {
  const fixture = await startFixture();
  try {
    const anonymous = await fetch(`${fixture.url}/api/feeding/day`);
    assert.equal(anonymous.status, 401);
    const anonymousWrite = await mutate(fixture, "POST", "/api/feeding/fed", "");
    assert.equal(anonymousWrite.status, 401);

    const noOrigin = await mutate(fixture, "POST", "/api/feeding/fed", fixture.alexCookie, {
      body: { slotId: "slot-b" },
      key: "guarded",
      omitOrigin: true,
    });
    assert.equal(noOrigin.status, 403);

    const noHeader = await mutate(fixture, "POST", "/api/feeding/fed", fixture.alexCookie, {
      body: { slotId: "slot-b" },
      key: "guarded",
      omitHeader: true,
    });
    assert.equal(noHeader.status, 403);

    const notJson = await mutate(fixture, "POST", "/api/feeding/fed", fixture.alexCookie, {
      body: { slotId: "slot-b" },
      key: "guarded",
      contentType: "text/plain",
    });
    assert.equal(notJson.status, 415);

    const noKey = await logFed(fixture, fixture.alexCookie, { slotId: "slot-b" }, "");
    assert.equal(noKey.status, 409);
    const noKeyBody = await json<{ error: string }>(noKey);
    assert.match(noKeyBody.error, /Idempotency-Key/);

    // The mapper's refusal never carries a credential or a stack, only a sentence.
    const bodies = [
      await json<Record<string, unknown>>(noOrigin),
      await json<Record<string, unknown>>(noHeader),
      await json<Record<string, unknown>>(notJson),
      noKeyBody,
    ];
    for (const body of bodies) {
      assert.deepEqual(Object.keys(body), ["error"]);
      assert.doesNotMatch(JSON.stringify(body), /token=|cookie|stack/i);
    }

    const day = await getDay(fixture, fixture.alexCookie);
    assert.equal(day.day.events.length, 0);
  } finally {
    await fixture.stop();
  }
});

// --- the local date is the household's, not UTC's ---------------------------

test("the day is derived in the household's zone, not from the UTC date", async () => {
  // 23:30Z is already 30 October in Paris; a route that sliced the ISO string
  // would answer the 29th. The clock is pinned so the assertion is exact.
  const instant = new Date("2026-10-29T23:30:00.000Z");
  const fixture = await startFixture({ now: () => instant.getTime() });
  try {
    // The fixture set the zone (UTC) through the same route, so read the
    // revision it left rather than assuming the boot value.
    const current = await careView(fixture, fixture.alexCookie);
    const zone = await mutate(fixture, "PATCH", "/api/household", fixture.alexCookie, {
      body: { rev: current.household.rev, timezone: "Europe/Paris" },
      key: "zone-1",
    });
    assert.equal(zone.status, 200);

    const day = await getDay(fixture, fixture.alexCookie);
    assert.equal(day.day.localDate, "2026-10-30", "the household's next day, not the UTC date");
    assert.notEqual(day.day.localDate, instant.toISOString().slice(0, 10));

    const fed = await logFed(fixture, fixture.alexCookie, { slotId: "slot-d" }, "paris-feed");
    assert.equal(fed.status, 200);
    const written = await json<FeedWriteView>(fed);
    assert.equal(written.feed.at, "2026-10-29T23:30:00.000Z", "the instant is the server's");
    assert.equal(written.feed.localDate, "2026-10-30", "the event is filed on the household's date");
    assert.equal(written.day.localDate, "2026-10-30");

    const conflict = await logFed(fixture, fixture.samCookie, { slotId: "slot-d" }, "paris-sam");
    assert.equal(conflict.status, 409);
    assert.equal((await json<{ day: MealDayView }>(conflict)).day.localDate, "2026-10-30");
  } finally {
    await fixture.stop();
  }
});

// --- what a write must not disturb ------------------------------------------

test("a feed leaves the meal-schedule revision alone, so an open wizard is not invalidated", async () => {
  const fixture = await startFixture();
  try {
    const before = await careView(fixture, fixture.alexCookie);
    const fed = await logFed(fixture, fixture.alexCookie, { slotId: "slot-b" }, "no-rev-bump");
    assert.equal(fed.status, 200);
    const after = await careView(fixture, fixture.alexCookie);
    assert.equal(after.meals.rev, before.meals.rev, "rev is the schedule's, not the meal log's");
    assert.deepEqual(after.meals.slots, before.meals.slots);
  } finally {
    await fixture.stop();
  }
});

test("the same key on /fed and /extra is a key conflict, not a replay or a second meal", async () => {
  const fixture = await startFixture();
  try {
    const fed = await logFed(fixture, fixture.alexCookie, { slotId: "slot-b" }, "one-key");
    assert.equal(fed.status, 200);
    const extra = await logExtra(fixture, fixture.alexCookie, {}, "one-key");
    assert.equal(extra.status, 409);
    assert.equal((await json<{ error: string }>(extra)).error, "idempotency_conflict");

    const day = await getDay(fixture, fixture.alexCookie);
    assert.equal(day.day.events.length, 1, "the refused extra wrote nothing");
  } finally {
    await fixture.stop();
  }
});

test("an empty optional field may be null, and a slot id is whitespace-trimmed", async () => {
  const fixture = await startFixture();
  try {
    const fed = await logFed(fixture, fixture.alexCookie, { slotId: " slot-b ", amount: null, note: null }, "nulls");
    assert.equal(fed.status, 200, "null is how a form spells an empty optional");
    const written = await json<FeedWriteView>(fed);
    assert.equal(written.feed.slotId, "slot-b", "the client's whitespace is not a missing slot");
    assert.equal(written.feed.amount, undefined);
    assert.equal(written.feed.note, undefined);
  } finally {
    await fixture.stop();
  }
});

test("an over-long note is refused by the domain, not silently truncated", async () => {
  const fixture = await startFixture();
  try {
    const response = await logExtra(fixture, fixture.alexCookie, { note: "x".repeat(281) }, "long-note");
    assert.equal(response.status, 409);
    assert.match((await json<{ error: string }>(response)).error, /could not be logged/);

    const day = await getDay(fixture, fixture.alexCookie);
    assert.equal(day.day.events.length, 0);
  } finally {
    await fixture.stop();
  }
});
