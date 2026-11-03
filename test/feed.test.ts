// P2-02: the feed domain service and the notification intents it commits
// (PLAN §7.2, §7.3, §8.1, §8.5, §12.3, §16 Phase 2).
//
// What is pinned here:
//   * `logFeed` is one commit: the event, one activity entry, one intent per
//     other caregiver and the idempotency record land together or not at all;
//   * the same `actionId` replays as success, a different one on an already-fed
//     slot is a 409 carrying who/when, and neither writes anything else;
//   * the local date comes from the server clock in the household zone, and a
//     feed does not move the schedule's revision;
//   * `app.notifications` keeps the intent, refuses a duplicate dedupe key and
//     never prunes an unread item.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { emptyConfig, type AppConfig, type MemberRecord } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import {
  ActivityDoc,
  CommandsDoc,
  FeedingDoc,
  NotificationsDoc,
  emptyNotifications,
  parseNotifications,
} from "../src/server/domain/docs.ts";
import { FeedConflictError, logFeed, readFeeding, updateMealSlots } from "../src/server/domain/feeding.ts";
import { DomainConflictError } from "../src/server/domain/errors.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import {
  NOTIFICATION_LIMIT,
  NOTIFICATION_TITLES,
  appendIntents,
  notificationKey,
  parseNotificationIntent,
  parseNotificationIntents,
} from "../src/shared/notifications.ts";
import type { MealSlot, NotificationIntent } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
const NOON = new Date("2026-10-29T12:00:00.000Z");

const BREAKFAST: MealSlot = { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true };
const LUNCH: MealSlot = { id: "slot-l", label: "Lunch", timeLocal: "12:00", active: false };

const owner: MemberRecord = {
  id: "owner",
  role: "owner",
  displayName: "Alex",
  createdAt: "2026-10-29T10:00:00.000Z",
  sessions: [],
};
const partner: MemberRecord = {
  id: "partner",
  role: "member",
  displayName: "Sam",
  createdAt: "2026-10-29T10:00:00.000Z",
  sessions: [],
};

function config(...members: MemberRecord[]): AppConfig {
  return { ...emptyConfig(), members };
}

const alex = async () => ({ id: "owner", label: "Alex" });

function intent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    id: "notice-1",
    dedupeKey: "fed|2026-10-29|slot|slot-b|partner",
    category: "fed",
    userId: "partner",
    title: NOTIFICATION_TITLES.fed,
    body: 'Alex fed "Breakfast" at 13:00',
    createdAt: NOON.toISOString(),
    readAt: null,
    ...overrides,
  };
}

/** A bootstrapped harness with a two-caregiver household and one meal time. */
async function withFeedHarness(
  run: (opened: OpenedHarness) => Promise<void>,
  members: MemberRecord[] = [owner, partner],
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-feed-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
  try {
    await bootstrapSession(opened.harness, {
      config: config(...members),
      context,
      timezone: "Europe/Paris",
      now: () => NOON,
    });
    await updateMealSlots(opened.harness, context, {
      actor: alex,
      actionId: "http:setup",
      rev: 0,
      slots: [BREAKFAST],
      now: NOON,
    });
    await run(opened);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

async function activityCount(harness: OpenedHarness["harness"]): Promise<number> {
  return (await harness.snapshot(ActivityDoc, context))?.entries.length ?? 0;
}

async function intents(harness: OpenedHarness["harness"]): Promise<NotificationIntent[]> {
  return (await harness.snapshot(NotificationsDoc, context))?.items ?? [];
}

// --- the document and its retention ----------------------------------------

test("an intent is a category title, in-app copy, a dedupe key and a reader", () => {
  assert.deepEqual(parseNotificationIntent(intent()), intent());
  assert.deepEqual(emptyNotifications(), { schemaVersion: 1, items: [], createdAt: "" });
  // `emptyNotifications()` is the in-memory initial (no `createdAt` yet); a
  // stored document always has one, which is what the parser requires.
  const stored = { ...emptyNotifications(), createdAt: NOON.toISOString() };
  assert.deepEqual(parseNotifications(stored), stored);

  const bad: Array<[string, Record<string, unknown>]> = [
    ["unknown key", { ...intent(), extra: true }],
    ["unknown category", { ...intent(), category: "appointment" }],
    ["empty body", { ...intent(), body: "   " }],
    ["body with a newline", { ...intent(), body: "fed\nBreakfast" }],
    ["bad instant", { ...intent(), createdAt: "2026-02-30T00:00:00.000Z" }],
    ["bad read instant", { ...intent(), readAt: "yesterday" }],
    ["id with a space", { ...intent(), id: "notice 1" }],
    ["dedupe key with a control character", { ...intent(), dedupeKey: "fed\u0000key" }],
  ];
  for (const [label, value] of bad) {
    assert.equal(parseNotificationIntent(value), undefined, label);
  }
  assert.equal(
    parseNotifications({ ...stored, items: [intent({ title: "Breakfast was logged" })] }),
    undefined,
    "a title that is not the category text",
  );
  assert.equal(parseNotifications({ ...stored, items: [intent(), intent()] }), undefined, "duplicate key");
  assert.equal(
    parseNotifications({ ...stored, items: [intent(), intent({ id: "notice-2" })] }),
    undefined,
    "duplicate id",
  );
});

test("appendIntents drops a duplicate key and never prunes an unread item", () => {
  const first = intent();
  assert.deepEqual(appendIntents([], [first]), [first]);
  assert.deepEqual(
    appendIntents([first], [intent({ id: "notice-2" })], 10),
    [first],
    "the same dedupe key is the same intent",
  );

  const unread = Array.from({ length: NOTIFICATION_LIMIT + 5 }, (_item, index) =>
    intent({ id: `notice-${index}`, dedupeKey: `fed|2026-10-29|slot|slot-${index}|partner` }),
  );
  assert.equal(appendIntents([], unread).length, unread.length, "unread items are never dropped");

  // Among read items the newest NOTIFICATION_LIMIT win; unread survive regardless.
  const read = unread.map((item) => ({ ...item, readAt: NOON.toISOString() }));
  const kept = appendIntents([], [...read, first]);
  assert.equal(kept.length, NOTIFICATION_LIMIT + 1);
  assert.ok(kept.includes(first), "the unread intent survives");
  assert.deepEqual(
    kept.filter((item) => item.readAt !== null).map((item) => item.id),
    read.slice(-NOTIFICATION_LIMIT).map((item) => item.id),
    "the newest read items are kept, in order",
  );
});

// --- logging a meal ---------------------------------------------------------

test("a normal feed is one commit: event, activity, partner intent, command record", async () => {
  await withFeedHarness(async ({ harness }) => {
    const outcome = await logFeed(harness, context, {
      actor: alex,
      actionId: "http:feed-1",
      slotId: "slot-b",
      amount: " 80 g ",
      source: "ui",
      now: NOON,
    });
    assert.equal(outcome.kind, "logged");
    const event = outcome.kind === "logged" ? outcome.event : undefined;
    assert.ok(event);

    const feeding = await readFeeding(harness, context);
    assert.equal(feeding.events.length, 1);
    assert.deepEqual(feeding.events[0], event);
    assert.equal(event.slotId, "slot-b");
    assert.equal(event.localDate, "2026-10-29", "the household-local date");
    assert.equal(event.at, NOON.toISOString());
    assert.equal(event.amount, "80 g", "the amount is trimmed before it is stored");
    assert.equal(event.byUserId, "owner");
    assert.equal(event.byLabel, "Alex");
    assert.equal(event.source, "ui");
    assert.equal(event.actionId, "http:feed-1");
    assert.equal(feeding.rev, 1, "a feed does not move the schedule's revision");

    const activity = await harness.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries.length, 2, "the schedule setup and this feed");
    assert.equal(activity?.entries[1]?.kind, "feed.logged");
    assert.equal(activity?.entries[1]?.summary, 'Alex fed "Breakfast"');
    assert.equal(activity?.entries[1]?.actorId, "owner");

    const notices = await intents(harness);
    assert.equal(notices.length, 1, "the partner, not the actor");
    assert.equal(notices[0]?.userId, "partner");
    assert.equal(notices[0]?.category, "fed");
    assert.equal(notices[0]?.title, NOTIFICATION_TITLES.fed);
    assert.equal(notices[0]?.body, 'Alex fed "Breakfast" at 13:00');
    assert.equal(notices[0]?.dedupeKey, "fed|2026-10-29|slot|slot-b|partner");
    assert.equal(notices[0]?.readAt, null);

    const commands = await harness.snapshot(CommandsDoc, context);
    assert.ok(commands?.entries.some((entry) => entry.key === "http:feed-1"));
  });
});

test("the local date is the household's day, and the source is recorded", async () => {
  await withFeedHarness(async ({ harness }) => {
    // 23:30Z is already the next day in Paris; a caregiver's late supper belongs
    // to the day the household lived, not the UTC date.
    const late = new Date("2026-10-29T23:30:00.000Z");
    const outcome = await logFeed(harness, context, {
      actor: alex,
      actionId: "http:late",
      slotId: "slot-b",
      source: "agent",
      now: late,
    });
    assert.equal(outcome.kind, "logged");
    const event = outcome.kind === "logged" ? outcome.event : undefined;
    assert.equal(event?.localDate, "2026-10-30");
    assert.equal(event?.source, "agent");
    // The intent follows the same date.
    const notices = await intents(harness);
    assert.equal(notices[0]?.dedupeKey, "fed|2026-10-30|slot|slot-b|partner");
  });
});

test("an extra feeding has no slot, never conflicts, and notifies once per event", async () => {
  await withFeedHarness(async ({ harness }) => {
    const first = await logFeed(harness, context, {
      actor: alex,
      actionId: "http:extra-1",
      slotId: null,
      note: " training treat ",
      source: "ui",
      now: NOON,
    });
    const second = await logFeed(harness, context, {
      actor: alex,
      actionId: "http:extra-2",
      slotId: null,
      source: "ui",
      now: NOON,
    });
    assert.equal(first.kind, "logged");
    assert.equal(second.kind, "logged");
    const event = first.kind === "logged" ? first.event : undefined;
    assert.equal(event?.slotId, null);
    assert.equal(event?.note, "training treat");
    assert.equal((await readFeeding(harness, context)).events.length, 2);

    const notices = await intents(harness);
    assert.equal(notices.length, 2, "each event gets its own intent");
    assert.notEqual(notices[0]?.dedupeKey, notices[1]?.dedupeKey);
    assert.match(notices[0]?.body ?? "", /^Alex added an extra feeding at /);
  });
});

test("a slot that is unknown or inactive is refused without writing", async () => {
  await withFeedHarness(async ({ harness }) => {
    // Keep the schedule valid (one active slot) and add a retired one: an
    // unknown id and an inactive slot are the two refusals.
    await updateMealSlots(harness, context, {
      actor: alex,
      actionId: "http:setup-2",
      rev: 1,
      slots: [{ ...BREAKFAST, id: "slot-old", timeLocal: "06:00" }, BREAKFAST, LUNCH],
      now: NOON,
    });
    const before = await activityCount(harness);

    await assert.rejects(
      logFeed(harness, context, {
        actor: alex,
        actionId: "http:x1",
        slotId: "slot-gone",
        source: "ui",
        now: NOON,
      }),
      (error: unknown) => error instanceof DomainConflictError && /no longer in the schedule/.test(error.message),
    );
    await assert.rejects(
      logFeed(harness, context, {
        actor: alex,
        actionId: "http:x2",
        slotId: "slot-l",
        source: "ui",
        now: NOON,
      }),
      (error: unknown) => error instanceof DomainConflictError && /not active/.test(error.message),
    );
    await assert.rejects(
      logFeed(harness, context, {
        actor: alex,
        actionId: "http:x3",
        slotId: "slot-old",
        amount: "x".repeat(200),
        source: "ui",
        now: NOON,
      }),
      DomainConflictError,
      "a malformed event is refused by the backstop",
    );

    assert.equal((await readFeeding(harness, context)).events.length, 0);
    assert.equal(await activityCount(harness), before, "no activity entry");
    assert.deepEqual(await intents(harness), [], "no notification intent");
    const commands = await harness.snapshot(CommandsDoc, context);
    assert.ok(!commands?.entries.some((entry) => entry.key === "http:x1"), "no idempotency record");
  });
});

test("the same action replays; a different action on a fed slot is a 409 with who/when", async () => {
  await withFeedHarness(async ({ harness }) => {
    const input = {
      actor: alex,
      actionId: "http:feed-1",
      slotId: "slot-b",
      source: "ui" as const,
      now: NOON,
    };
    const first = await logFeed(harness, context, input);
    assert.equal(first.kind, "logged");
    const replay = await logFeed(harness, context, input);
    assert.equal(replay.kind, "replayed");
    assert.deepEqual(
      replay.kind === "replayed" ? replay.event : undefined,
      first.kind === "logged" ? first.event : undefined,
      "a replay returns the committed event",
    );
    assert.equal((await readFeeding(harness, context)).events.length, 1);
    assert.equal(await activityCount(harness), 2, "no second activity entry");
    assert.equal((await intents(harness)).length, 1, "no second intent");

    // Same key, different body: a key collision, not a replay.
    const reused = await logFeed(harness, context, { ...input, amount: "80 g" });
    assert.equal(reused.kind, "key-conflict");

    // A different caregiver with their own key hits the slot conflict.
    const sam = async () => ({ id: "partner", label: "Sam" });
    await assert.rejects(
      logFeed(harness, context, { ...input, actor: sam, actionId: "http:feed-sam" }),
      (error: unknown) => {
        if (!(error instanceof FeedConflictError)) return false;
        assert.equal(error.existing.byLabel, "Alex");
        assert.equal(error.existing.slotId, "slot-b");
        assert.match(error.message, /Alex already logged this meal at 13:00/);
        assert.equal(error.status, 409);
        return true;
      },
    );
    assert.equal((await readFeeding(harness, context)).events.length, 1, "the conflict wrote nothing");
    assert.equal(await activityCount(harness), 2);
    assert.equal((await intents(harness)).length, 1);
  });
});

test("two caregivers racing one slot: one feed, one conflict", async () => {
  await withFeedHarness(async ({ harness }) => {
    const sam = async () => ({ id: "partner", label: "Sam" });
    const settled = await Promise.allSettled([
      logFeed(harness, context, {
        actor: alex,
        actionId: "http:race-alex",
        slotId: "slot-b",
        source: "ui",
        now: NOON,
      }),
      logFeed(harness, context, {
        actor: sam,
        actionId: "http:race-sam",
        slotId: "slot-b",
        source: "ui",
        now: NOON,
      }),
    ]);
    const logged = settled.filter((result) => result.status === "fulfilled" && result.value.kind === "logged");
    const conflicts = settled.filter(
      (result) => result.status === "rejected" && result.reason instanceof FeedConflictError,
    );
    assert.equal(logged.length, 1, "exactly one feed commits");
    assert.equal(conflicts.length, 1, "the loser gets 409, not a duplicate");
    assert.equal((await readFeeding(harness, context)).events.length, 1);
  });
});

test("a feed does not invalidate an open meal-schedule edit", async () => {
  // `rev` is the schedule's revision (P1-14): a caregiver logging breakfast must
  // not make the other phone's open wizard save report a stale conflict.
  await withFeedHarness(async ({ harness }) => {
    await logFeed(harness, context, {
      actor: alex,
      actionId: "http:feed-1",
      slotId: "slot-b",
      source: "ui",
      now: NOON,
    });
    const saved = await updateMealSlots(harness, context, {
      actor: alex,
      actionId: "http:schedule-2",
      rev: 1,
      slots: [{ ...BREAKFAST, timeLocal: "07:30" }],
      now: NOON,
    });
    assert.equal(saved, "updated");
    const feeding = await readFeeding(harness, context);
    assert.equal(feeding.rev, 2);
    assert.equal(feeding.events.length, 1, "the meal survives the schedule edit");
  });
});

test("a one-caregiver household commits no intent, and the document stays empty", async () => {
  await withFeedHarness(async ({ harness }) => {
    const outcome = await logFeed(harness, context, {
      actor: alex,
      actionId: "http:feed-1",
      slotId: "slot-b",
      source: "ui",
      now: NOON,
    });
    assert.equal(outcome.kind, "logged");
    assert.deepEqual(await intents(harness), [], "the actor is the only member");
  }, [owner]);
});

test("a dedupe key cannot be forged by ids that run together", () => {
  // Every part is percent-encoded before the join, so a colon inside an id can
  // never make two different (slot, member) pairs produce one key — a silent
  // drop would otherwise lose an intent.
  assert.notEqual(
    notificationKey("fed", "2026-10-29", "slot", "a:b", "c"),
    notificationKey("fed", "2026-10-29", "slot", "a", "b:c"),
  );
  assert.equal(notificationKey("fed", "2026-10-29", "slot", "slot-b", "partner"), "fed|2026-10-29|slot|slot-b|partner");
  // A `|` in an id is encoded too, so the separator stays unambiguous.
  assert.equal(notificationKey("a|b"), "a%7Cb");
});

test("a long display name logs a meal instead of breaking the next boot", async () => {
  // The roster and config do not cap a display name, and a notification body
  // carries it. A cap here would let one long name commit an unparseable intent
  // and hard-fail every later boot; the rule is "non-empty, no control chars".
  const longName = "A".repeat(400);
  const longOwner = { ...owner, displayName: longName };
  await withFeedHarness(async ({ harness }) => {
    const outcome = await logFeed(harness, context, {
      actor: async () => ({ id: "owner", label: longName }),
      actionId: "http:feed-long",
      slotId: "slot-b",
      source: "ui",
      now: NOON,
    });
    assert.equal(outcome.kind, "logged");
    const items = await intents(harness);
    assert.equal(items.length, 1);
    assert.ok((items[0]?.body.length ?? 0) > 300, "the body carries the name");
    assert.ok(parseNotificationIntents(items), "and the stored document still parses");
  }, [longOwner, partner]);
});

test("a malformed stored app.notifications refuses boot instead of being reset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-feed-boot-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
  try {
    await bootstrapSession(opened.harness, { config: config(owner, partner), context, timezone: "Europe/Paris", now: () => NOON });
    // A stored document whose title is no longer its category's catalog text is
    // exactly what a careless reword would produce.
    await opened.harness.commit(async (tx) => {
      const draft = await tx.doc(NotificationsDoc);
      draft.items = [intent({ title: "Breakfast was logged" })];
    }, context);

    await assert.rejects(
      bootstrapSession(opened.harness, { config: config(owner, partner), context, timezone: "Europe/Paris", now: () => NOON }),
      /app\.notifications is not a shape/,
    );
    assert.ok(await opened.harness.snapshot(NotificationsDoc, context), "nothing was reset");
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("the household fallback actor notifies every member and stores a null id", async () => {
  await withFeedHarness(async ({ harness }) => {
    const outcome = await logFeed(harness, context, {
      actor: async () => ({ id: null, label: "Household" }),
      actionId: "tool:42",
      slotId: "slot-b",
      source: "agent",
      now: NOON,
    });
    assert.equal(outcome.kind, "logged");
    const event = outcome.kind === "logged" ? outcome.event : undefined;
    assert.equal(event?.byUserId, null);
    assert.equal(event?.byLabel, "Household");
    const items = await intents(harness);
    assert.deepEqual(items.map((item) => item.userId).sort(), ["owner", "partner"]);
    assert.match(items[0]?.body ?? "", /^Household fed /);
  });
});

test("a key reused after the 24 h window is a new action, not a silent replay", async () => {
  await withFeedHarness(async ({ harness }) => {
    const first = await logFeed(harness, context, {
      actor: alex,
      actionId: "http:extra-1",
      slotId: null,
      source: "ui",
      now: NOON,
    });
    assert.equal(first.kind, "logged");

    // 25 hours later the `app.commands` record has expired (§7.3's 24 h TTL), so
    // the same key runs at all: an extra feeding is a new event, never a replay
    // of yesterday's — and the document still obeys the invariants.
    const later = new Date(NOON.getTime() + 25 * 60 * 60 * 1000);
    const second = await logFeed(harness, context, {
      actor: alex,
      actionId: "http:extra-1",
      slotId: null,
      source: "ui",
      now: later,
    });
    assert.equal(second.kind, "logged");
    const events = (await readFeeding(harness, context)).events;
    assert.equal(events.length, 2, "both meals are recorded");

    // A normal feed's key, reused a day later, lands on the next local date: the
    // slot+date invariant allows it, because it is a different day's meal.
    await logFeed(harness, context, {
      actor: alex,
      actionId: "http:feed-day1",
      slotId: "slot-b",
      source: "ui",
      now: NOON,
    });
    const nextDay = await logFeed(harness, context, {
      actor: alex,
      actionId: "http:feed-day1",
      slotId: "slot-b",
      source: "ui",
      now: later,
    });
    assert.equal(nextDay.kind, "logged");
    assert.notEqual(
      nextDay.kind === "logged" ? nextDay.event.localDate : undefined,
      "2026-10-29",
      "25 hours later is the next household day",
    );
  });
});
