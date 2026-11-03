// P2-01: the `app.feeding` document (PLAN §8.1, §8.3, §8.5, §16 Phase 2).
//
// Three layers:
//   * the event shape: one logged meal, its optional fields, and the household
//     fallback fence;
//   * the list invariants the plan calls a "partial unique index" — one normal
//     feed per slot per local date, unique ids and action ids (append order is
//     not an invariant; the day view sorts) — which is where a double feed
//     becomes impossible rather than duplicated;
//   * the document: the version-1 → version-2 migration that keeps a P1-14
//     schedule, and the pure day view P2-03/P2-04 will serve.
//
// The write service, the routes, the tools and the UI are P2-02 onward; this
// file pins the shape they may rely on.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { emptyConfig, type AppConfig, type MemberRecord } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import {
  FeedingDoc,
  emptyFeeding,
  parseFeeding,
} from "../src/server/domain/docs.ts";
import { CLIENT_KEY_LIMIT, isCommandKey } from "../src/server/domain/commands.ts";
import { updateMealSlots } from "../src/server/domain/feeding.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import { localDateAt } from "../src/server/domain/time.ts";
import {
  FEED_ACTION_ID_LIMIT,
  FEED_AMOUNT_LIMIT,
  FEED_NOTE_LIMIT,
  feedingDay,
  parseFeedEvent,
  parseFeedEvents,
} from "../src/shared/feeding.ts";
import type { Feeding, FeedEvent, MealSlot } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
const CREATED = "2026-10-29T10:00:00.000Z";
const NOON = new Date("2026-10-29T12:00:00.000Z");
const actor = async () => ({ id: "owner", label: "Alex" });

function config(...members: MemberRecord[]): AppConfig {
  return { ...emptyConfig(), members };
}

const owner: MemberRecord = {
  id: "owner",
  role: "owner",
  displayName: "Alex",
  createdAt: "2026-10-29T10:00:00.000Z",
  sessions: [],
};

const BREAKFAST: MealSlot = { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true };
const DINNER: MealSlot = { id: "slot-d", label: "Dinner", timeLocal: "18:00", portion: "80 g", active: true };
const LUNCH: MealSlot = { id: "slot-l", label: "Lunch", timeLocal: "12:00", active: false };

/** Breakfast at 06:10 Paris time (05:10Z, CET after the October change), once. */
function feed(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    id: "feed-1",
    slotId: "slot-b",
    localDate: "2026-10-29",
    at: "2026-10-29T05:10:00.000Z",
    byUserId: "owner",
    byLabel: "Alex",
    source: "ui",
    actionId: "http:feed-1",
    ...overrides,
  };
}

function feedingWith(events: FeedEvent[], slots: MealSlot[] = [BREAKFAST, DINNER]): Feeding {
  return { schemaVersion: 2, rev: 1, slots, events, createdAt: CREATED };
}

// --- one logged meal --------------------------------------------------------

test("a logged meal round-trips, and empty optional fields are omitted", () => {
  assert.deepEqual(parseFeedEvent(feed()), feed());
  assert.deepEqual(parseFeedEvent(feed({ slotId: null })), feed({ slotId: null }), "an extra feeding has no slot");
  assert.deepEqual(parseFeedEvent(feed({ amount: "  80 g ", note: " ate fast " })), {
    ...feed(),
    amount: "80 g",
    note: "ate fast",
  });
  // An empty amount/note is "not set", not an empty string in the document.
  const blank = parseFeedEvent(feed({ amount: "  ", note: "   " }));
  assert.equal(blank?.amount, undefined);
  assert.equal(blank?.note, undefined);
  assert.equal(Object.hasOwn(blank ?? {}, "note"), false);
});

test("a logged meal refuses a shape this build does not understand", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["unknown key", { ...feed(), nickname: "Bfast" }],
    ["id with a space", { ...feed(), id: "feed 1" }],
    ["id too long", { ...feed(), id: "f".repeat(65) }],
    ["empty slot id", { ...feed(), slotId: "" }],
    ["slot id of the wrong type", { ...feed(), slotId: 3 }],
    ["local date as an instant", { ...feed(), localDate: "2026-10-29T00:00:00.000Z" }],
    ["impossible local date", { ...feed(), localDate: "2026-13-01" }],
    ["instant without Z", { ...feed(), at: "2026-10-29T05:10:00+01:00" }],
    ["nonsense instant", { ...feed(), at: "yesterday" }],
    ["a day February does not have", { ...feed(), at: "2026-02-30T00:00:00.000Z" }],
    ["the 24th hour", { ...feed(), at: "2026-10-29T24:00:00.000Z" }],
    ["a leap second", { ...feed(), at: "2026-10-29T05:10:60.000Z" }],
    ["month 13", { ...feed(), at: "2026-13-01T05:10:00.000Z" }],
    ["amount too long", { ...feed(), amount: "x".repeat(FEED_AMOUNT_LIMIT + 1) }],
    ["note too long", { ...feed(), note: "x".repeat(FEED_NOTE_LIMIT + 1) }],
    ["note with a newline", { ...feed(), note: "ate\nwell" }],
    ["note with a paragraph separator", { ...feed(), note: "ate\u2028well" }],
    ["label with a next-line control", { ...feed(), byLabel: "Al\u0085ex" }],
    ["member id with a control character", { ...feed(), byUserId: "own\u0000er" }],
    ["empty label", { ...feed(), byLabel: "   " }],
    ["label with a control character", { ...feed(), byLabel: "Al\u0000ex" }],
    ["unknown source", { ...feed(), source: "api" }],
    ["action id with a space", { ...feed(), actionId: "http:feed 1" }],
    ["action id too long", { ...feed(), actionId: `http:${"k".repeat(FEED_ACTION_ID_LIMIT)}` }],
  ];
  for (const [label, value] of bad) {
    assert.equal(parseFeedEvent(value), undefined, label);
  }

  // Each required field is really required.
  for (const key of ["id", "slotId", "localDate", "at", "byUserId", "byLabel", "source", "actionId"]) {
    const missing = { ...feed() } as Record<string, unknown>;
    delete missing[key];
    assert.equal(parseFeedEvent(missing), undefined, `missing ${key}`);
  }
});

test("a member label is the roster's text, not a bounded field", () => {
  // `byLabel` mirrors `app.household.members`, whose write sites do not cap the
  // name either. Capping it here would let a long display name make the parser
  // refuse the document — and a refused `app.feeding` fails boot (§8.1).
  const long = "A".repeat(200);
  assert.equal(parseFeedEvent(feed({ byLabel: long }))?.byLabel, long);
  // A member id is a config id; it is trimmed, but not invented here.
  assert.equal(parseFeedEvent(feed({ byUserId: " m-0123456789abcdef " }))?.byUserId, "m-0123456789abcdef");
});

test("a command key that can be used as an idempotency key parses as a feed action id", () => {
  // The cross-layer contract: HTTP namespaces its key as `http:<key>` and the
  // agent uses `tool:<taskId>`. Those strings become the event's `actionId`, and
  // a document the parser refuses fails boot — so the two charsets must agree.
  for (const key of ["a".repeat(100), "0f0e1d2c-3b4a-5968-7788-99aabbccddee", "k_1.2:3"]) {
    assert.ok(isCommandKey(key, CLIENT_KEY_LIMIT), key);
    const event = parseFeedEvent(feed({ actionId: `http:${key}` }));
    assert.equal(event?.actionId, `http:${key}`, "an accepted client key is a storable action id");
  }
  assert.ok(parseFeedEvent(feed({ actionId: "tool:42" }))?.actionId === "tool:42");
});

test("no member id always travels with the household label", () => {
  // §9.2's fence: the null id and "Household" are one attribution, so a care
  // record cannot show the fallback as if it were a person.
  assert.equal(parseFeedEvent(feed({ byUserId: null, byLabel: "Household" }))?.byUserId, null);
  assert.equal(parseFeedEvent(feed({ byUserId: null, byLabel: "Alex" })), undefined);
  // A real member may be called anything, including "Household" — the fence
  // only fixes the null-id direction.
  assert.equal(parseFeedEvent(feed({ byUserId: "owner", byLabel: "Household" }))?.byLabel, "Household");
});

// --- the list invariants ----------------------------------------------------

test("meals are one list: unique ids and action ids, one per slot per day", () => {
  const extra = feed({ id: "feed-2", slotId: null, at: "2026-10-29T15:00:00.000Z", actionId: "http:feed-2" });
  const valid = parseFeedEvents([feed(), extra]);
  assert.equal(valid?.length, 2);

  assert.equal(parseFeedEvents([feed(), feed({ at: "2026-10-29T06:00:00.000Z" })]), undefined, "same id twice");
  // A repeated action id is *not* a document error: the key is 24 h-scoped in
  // `app.commands`, so a key reused after the window is legal for the service
  // and must not wedge the document at boot. The slot+date rule still catches
  // the meal that would actually be duplicated.
  assert.equal(
    parseFeedEvents([feed(), feed({ id: "feed-2", slotId: null, at: "2026-10-29T06:00:00.000Z" })])?.length,
    2,
    "a repeated action id parses; P2-02 owns the answer",
  );
  // A backward clock jump must not wedge meal logging: append order is not a
  // chronological invariant, and the day view sorts by `at`.
  assert.equal(
    parseFeedEvents([
      feed({ at: "2026-10-29T09:00:00.000Z", actionId: "http:a" }),
      feed({ id: "feed-2", slotId: null, at: "2026-10-29T08:00:00.000Z", actionId: "http:b" }),
    ])?.length,
    2,
    "an event appended after a clock jump is still valid",
  );
  // Two events in the same millisecond are allowed; ids break the tie.
  assert.equal(
    parseFeedEvents([feed({ actionId: "http:a" }), feed({ id: "feed-2", slotId: null, actionId: "http:b" })])?.length,
    2,
  );
  // A normal feed and an extra do not share a slot, so they cannot collide.
  assert.equal(
    parseFeedEvents([
      feed({ actionId: "http:a" }),
      feed({ id: "feed-2", slotId: null, actionId: "http:b" }),
      feed({ id: "feed-3", slotId: null, at: "2026-10-29T18:00:00.000Z", actionId: "http:c" }),
    ])?.length,
    3,
    "several extras on one day are fine",
  );
  assert.equal(
    parseFeedEvents([
      feed({ actionId: "http:a" }),
      feed({ id: "feed-2", localDate: "2026-10-30", at: "2026-10-30T05:10:00.000Z", actionId: "http:b" }),
    ])?.length,
    2,
    "the same slot on the next day is a new meal",
  );
  assert.equal(
    parseFeedEvents([
      feed({ actionId: "http:a" }),
      feed({ id: "feed-2", actionId: "http:b" }),
    ]),
    undefined,
    "two normal feeds for one slot and date",
  );
  assert.equal(parseFeedEvents("not a list"), undefined);
  assert.deepEqual(parseFeedEvents([]), [], "a fresh document has no meals");
});

test("an event may name a slot the schedule no longer has", () => {
  // Removing a slot must not make the history unreadable.
  const removed = feed({ slotId: "slot-gone" });
  assert.ok(parseFeedEvent(removed));
  const events = parseFeedEvents([removed]);
  assert.equal(events?.[0]?.slotId, "slot-gone");
});

// --- the document and its migration ----------------------------------------

test("the document is the schedule plus its meals, and only the current shape parses", () => {
  assert.deepEqual(emptyFeeding(), { schemaVersion: 2, rev: 0, slots: [], events: [], createdAt: "" });
  const doc = feedingWith([feed()]);
  assert.deepEqual(parseFeeding(doc), doc);

  assert.equal(parseFeeding({ ...doc, schemaVersion: 1 }), undefined, "the parser takes the current shape only");
  assert.equal(parseFeeding({ ...doc, events: undefined }), undefined);
  assert.equal(parseFeeding({ ...doc, events: [feed(), feed()] }), undefined, "a double feed is not a document");
  assert.equal(parseFeeding({ ...doc, rev: -1 }), undefined);
  assert.equal(parseFeeding({ ...doc, createdAt: "2026-10-29" }), undefined);
  // The stored parser still allows an empty schedule; a write does not.
  assert.deepEqual(parseFeeding(feedingWith([], []))?.slots, []);
});

test("a version-1 schedule migrates to version 2, keeping the slots and the revision", () => {
  const migrate = FeedingDoc.definition.migrate;
  assert.ok(migrate, "the document declares its migration");
  const legacy = {
    schemaVersion: 1,
    rev: 4,
    slots: [BREAKFAST, DINNER],
    createdAt: CREATED,
  };
  const migrated = migrate(legacy as never, 1);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.rev, 4, "the revision is not invented or reset");
  assert.deepEqual(migrated.slots, [BREAKFAST, DINNER]);
  assert.deepEqual(migrated.events, []);
  assert.throws(() => migrate(legacy as never, 0), /no migration/);
});

test("a stored version-1 document keeps its schedule through the real migration", async () => {
  // The document version is what the definition that created it wrote, so this
  // test-side definition is how a P1-14 document is reproduced: the build's own
  // definition (version 2) must read it through `migrate`, not refuse it.
  const LegacyFeedingDoc = defineDoc<Record<string, never>>({
    kind: "app.feeding",
    version: 1,
    scope: "session",
    initial: () => ({}) as Record<string, never>,
    checkpointWhen: () => false,
  });

  await withHarness(async ({ harness }) => {
    await harness.commit(async (tx) => {
      const legacy = await tx.doc(LegacyFeedingDoc);
      Object.assign(legacy as unknown as Record<string, unknown>, {
        schemaVersion: 1,
        rev: 2,
        slots: [BREAKFAST, DINNER],
        createdAt: CREATED,
      });
    }, context);

    const migrated = await harness.snapshot(FeedingDoc, context);
    assert.equal(migrated?.schemaVersion, 2);
    assert.equal(migrated?.rev, 2);
    assert.deepEqual(migrated?.slots, [BREAKFAST, DINNER], "the wizard's meal times survive the upgrade");
    assert.deepEqual(migrated?.events, []);
    assert.ok(parseFeeding(migrated));
  });
});

async function withHarness(run: (opened: OpenedHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-feeding-"));
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

// --- the day view -----------------------------------------------------------

test("a day is the active slots in time order, each with the meal that claimed it", () => {
  const events = [
    feed(), // breakfast, 05:10Z
    feed({ id: "feed-2", slotId: null, at: "2026-10-29T15:00:00.000Z", actionId: "http:extra", note: "training treat" }),
  ];
  const day = feedingDay(feedingWith(events, [DINNER, LUNCH, BREAKFAST]), "2026-10-29");

  assert.equal(day.localDate, "2026-10-29");
  assert.deepEqual(
    day.slots.map((entry) => entry.slot.id),
    ["slot-b", "slot-d"],
    "time order, and an inactive slot is not expected today",
  );
  assert.equal(day.slots[0]?.feed?.id, "feed-1");
  assert.equal(day.slots[1]?.feed, null, "dinner is still pending");
  assert.deepEqual(
    day.extras.map((event) => event.id),
    ["feed-2"],
    "an extra feeding is not a slot",
  );
  assert.equal(day.events.length, 2);
  // The document keeps append order; a day reads chronologically.
  const jumped = [
    feed({ id: "feed-late", slotId: null, at: "2026-10-29T18:00:00.000Z", actionId: "http:late" }),
    feed({ id: "feed-early", slotId: null, at: "2026-10-29T06:00:00.000Z", actionId: "http:early" }),
  ];
  assert.deepEqual(
    feedingDay(feedingWith(jumped), "2026-10-29").extras.map((event) => event.id),
    ["feed-early", "feed-late"],
    "a day is read in time order even when the document is not",
  );

  // Another day does not leak in.
  const other = feedingDay(feedingWith(events), "2026-10-28");
  assert.deepEqual(other.events, []);
  assert.ok(other.slots.every((entry) => entry.feed === null));

  assert.throws(() => feedingDay(feedingWith(events), "29/10/2026"), /not a local date/);
});

test("history is not rewritten when a slot is deactivated or removed", () => {
  const events = [
    feed(), // breakfast
    feed({ id: "feed-2", slotId: "slot-l", at: "2026-10-29T10:30:00.000Z", actionId: "http:lunch" }),
  ];
  // Lunch was served, then the caregiver retired that slot.
  const day = feedingDay(feedingWith(events, [BREAKFAST, DINNER]), "2026-10-29");
  assert.equal(day.slots.length, 2, "the retired slot is not expected any more");
  assert.ok(
    day.events.some((event) => event.id === "feed-2"),
    "but the meal that was logged is still part of the day",
  );
  assert.ok(day.events.every((event) => event.slotId !== null));
});

test("the household calendar decides which day a meal belongs to, not UTC", () => {
  // A meal at 23:30Z is still 29 October in UTC and already 30 October in Paris;
  // §8.5 files it under the date the household lived, derived at write time.
  const instant = new Date("2026-10-29T23:30:00.000Z");
  assert.equal(localDateAt(instant, "UTC"), "2026-10-29");
  assert.equal(localDateAt(instant, "Europe/Paris"), "2026-10-30");

  const lateSupper = feed({
    id: "feed-late",
    slotId: null,
    at: instant.toISOString(),
    localDate: localDateAt(instant, "Europe/Paris"),
    actionId: "http:late",
  });
  const feeding = feedingWith([lateSupper]);
  assert.deepEqual(feedingDay(feeding, "2026-10-30").extras.map((event) => event.id), ["feed-late"]);
  assert.deepEqual(feedingDay(feeding, "2026-10-29").extras, []);
});

test("a zone change does not re-date or invalidate meals the household already lived", () => {
  // The stored localDate is the date the meal happened on. Moving the household
  // zone later must not make the document unreadable nor move the meal; P2-02
  // derives the date at write time only (§8.5), and this parser deliberately
  // does not compare it with the current zone.
  const served = feed({ localDate: "2026-10-29", at: "2026-10-29T23:30:00.000Z" });
  const feeding = feedingWith([served]);
  assert.deepEqual(parseFeeding(feeding), feeding);
  assert.deepEqual(feedingDay(feeding, "2026-10-29").events.map((event) => event.id), ["feed-1"]);
});

test("editing the meal schedule keeps the meals already logged", async () => {
  // P1-14's writer owns the slots; P2-01's events live beside them. Changing a
  // meal time must never erase the history, or a caregiver's rename would lose
  // the record of every feeding.
  await withHarness(async ({ harness }) => {
    await bootstrapSession(harness, {
      config: config(owner),
      context,
      timezone: "Europe/Paris",
      now: () => NOON,
    });
    assert.equal(
      await updateMealSlots(harness, context, {
        actor,
        actionId: "http:slots-1",
        rev: 0,
        slots: [BREAKFAST, DINNER],
        now: NOON,
      }),
      "updated",
    );

    // P2-02's service appends an event; until it exists, write the shape here.
    await harness.commit(async (tx) => {
      const draft = await tx.doc(FeedingDoc);
      draft.events = [feed()];
    }, context);

    assert.equal(
      await updateMealSlots(harness, context, {
        actor,
        actionId: "http:slots-2",
        rev: 1,
        slots: [{ ...BREAKFAST, timeLocal: "07:30" }, DINNER],
        now: NOON,
      }),
      "updated",
    );

    const doc = await harness.snapshot(FeedingDoc, context);
    assert.ok(doc);
    assert.equal(doc.events.length, 1, "the logged meal survives the schedule edit");
    assert.equal(doc.slots[0]?.timeLocal, "07:30");
    assert.equal(feedingDay(doc, "2026-10-29").slots[0]?.feed?.id, "feed-1");
  });
});
