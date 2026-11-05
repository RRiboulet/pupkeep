// P2-09: the feeding reminder task and the schedule that arms it (PLAN §8.4,
// §9.1, §10.3, §12.1, §12.2).
//
// What is pinned here:
//   * a wall-clock slot time becomes one instant in the household zone, with a
//     documented rule for the two DST oddities (Europe/Paris fixtures);
//   * the schedule write arms one **background** task per active slot on the
//     hidden system conversation, and persists the task ids in the household —
//     never a tool-owned task, never a model call;
//   * re-saving the same schedule reuses the tasks (no double reminder), while a
//     moved slot arms a new one and the old task no-ops when it wakes;
//   * a wake on time reports `due` and writes nothing (delivery is P4), a fed
//     slot is skipped, and a wake past the grace window is skipped rather than
//     fired late in a burst.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { emptyConfig, type AppConfig, type MemberRecord } from "../src/server/config.ts";
import { installAppExtensions } from "../src/server/app.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import {
  ActivityDoc,
  FeedingDoc,
  HouseholdDoc,
  NotificationsDoc,
  parseFeedReminderRefs,
} from "../src/server/domain/docs.ts";
import { logFeed, updateMealSlots } from "../src/server/domain/feeding.ts";
import { readHousehold, updateHouseholdTimezone } from "../src/server/domain/household.ts";
import { instantAtLocalWallClock, localDateAt } from "../src/server/domain/time.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import {
  FEED_REMINDER_GRACE_MS,
  FEED_REMINDER_TASK,
  FeedReminder,
  feedReminderDecision,
  createReminders,
} from "../src/server/reminders/feed-reminder.ts";
import { planFeedReminders } from "../src/server/reminders/schedule.ts";
import type { FeedReminderRef, Household, MealSlot } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
/** 06:00 in Europe/Paris (CET, +01) on an ordinary autumn Thursday. */
const START = Date.parse("2026-10-29T05:00:00Z");
const BREAKFAST: MealSlot = { id: "slot-a", label: "Breakfast", timeLocal: "07:00", active: true };
const DINNER: MealSlot = { id: "slot-b", label: "Dinner", timeLocal: "18:00", active: true };
/** 07:00 + the default 15-minute delay, in UTC. */
const BREAKFAST_DUE = Date.parse("2026-10-29T06:15:00Z");
const DINNER_DUE = Date.parse("2026-10-29T17:15:00Z");

const owner: MemberRecord = {
  id: "owner",
  role: "owner",
  displayName: "Alex",
  createdAt: "2026-10-29T04:00:00.000Z",
  sessions: [],
};
const partner: MemberRecord = {
  id: "partner",
  role: "member",
  displayName: "Sam",
  createdAt: "2026-10-29T04:00:00.000Z",
  sessions: [],
};

function config(...members: MemberRecord[]): AppConfig {
  return { ...emptyConfig(), members };
}

const alex = async () => ({ id: "owner", label: "Alex" });

// --- the wall-clock conversion (§8.4) ---------------------------------------

test("a slot's wall-clock time becomes one instant in the household zone, DST included", () => {
  // Ordinary autumn day: France is one hour ahead of UTC.
  assert.equal(instantAtLocalWallClock("2026-10-29", "07:00", "Europe/Paris").toISOString(), "2026-10-29T06:00:00.000Z");
  assert.equal(instantAtLocalWallClock("2026-10-29", "00:00", "Europe/Paris").toISOString(), "2026-10-28T23:00:00.000Z");
  // Summer time: two hours ahead.
  assert.equal(instantAtLocalWallClock("2026-07-01", "07:00", "Europe/Paris").toISOString(), "2026-07-01T05:00:00.000Z");

  // 29 March 2026: the clock jumps from 02:00 to 03:00. A 02:30 slot has no
  // wall-clock instant, so it moves **forward** by the gap: 03:30 on the new
  // clock, not a lost reminder and not an hour early.
  assert.equal(instantAtLocalWallClock("2026-03-29", "02:30", "Europe/Paris").toISOString(), "2026-03-29T01:30:00.000Z");

  // 25 October 2026: 02:00–03:00 happens twice. The **earlier** occurrence is
  // the one a wall clock shows first, so the reminder is not delayed an hour.
  assert.equal(instantAtLocalWallClock("2026-10-25", "02:30", "Europe/Paris").toISOString(), "2026-10-25T00:30:00.000Z");

  assert.throws(() => instantAtLocalWallClock("2026-02-30", "07:00", "Europe/Paris"), /not a local date/);
  assert.throws(() => instantAtLocalWallClock("2026-10-29", "7:00", "Europe/Paris"), /not a wall-clock time/);
});

// --- the plan and the decision (pure) ---------------------------------------

function household(overrides: Partial<Household> = {}): Household {
  return {
    schemaVersion: 3,
    rev: 0,
    name: "Our household",
    timezone: "Europe/Paris",
    timezoneConfirmedAt: "2026-10-29T04:00:00.000Z",
    members: [{ id: "owner", name: "Alex" }],
    conversationId: 1,
    systemConversationId: 2,
    createdAt: "2026-10-29T04:00:00.000Z",
    settings: {
      feedReminderDelayMin: 15,
      appointmentReminderOffsetsMin: [1440, 60],
      showerIntervalDays: 21,
      agentBudgetUsd: 10,
    },
    feedReminders: [],
    ...overrides,
  };
}

test("the planner arms active slots at slot time plus the delay, and skips a passed offset", () => {
  const atSix = new Date(START);
  assert.deepEqual(planFeedReminders(household(), [BREAKFAST, { ...DINNER, active: false }], atSix), [
    { slotId: "slot-a", label: "Breakfast", localDate: "2026-10-29", dueAt: BREAKFAST_DUE },
  ]);

  // Noon in Paris: breakfast is hours past its grace window (no burst after a
  // phone boots), dinner is still ahead.
  const noon = new Date("2026-10-29T11:00:00Z");
  assert.deepEqual(
    planFeedReminders(household(), [BREAKFAST, DINNER], noon).map((item) => item.slotId),
    ["slot-b"],
  );

  // Just past the slot time is still useful: the reminder fires inside grace.
  const justLate = new Date(BREAKFAST_DUE + FEED_REMINDER_GRACE_MS - 1);
  assert.deepEqual(
    planFeedReminders(household(), [BREAKFAST], justLate).map((item) => item.slotId),
    ["slot-a"],
  );
  const tooLate = new Date(BREAKFAST_DUE + FEED_REMINDER_GRACE_MS + 1);
  assert.deepEqual(planFeedReminders(household(), [BREAKFAST], tooLate), []);

  // The delay is the household's setting, and it is applied to the local slot.
  const prompt = planFeedReminders(
    household({ settings: { ...household().settings, feedReminderDelayMin: 0 } }),
    [BREAKFAST],
    atSix,
  );
  assert.equal(prompt[0]?.dueAt, Date.parse("2026-10-29T06:00:00Z"));

  // The local date is the household's, not UTC's: 23:30Z is already tomorrow
  // in Paris, so that is the day the reminder belongs to.
  const lateNight = new Date("2026-10-29T23:30:00Z");
  const tomorrow = planFeedReminders(household(), [{ ...BREAKFAST, timeLocal: "23:59" }], lateNight);
  assert.equal(localDateAt(lateNight, "Europe/Paris"), "2026-10-30");
  assert.equal(tomorrow[0]?.localDate, "2026-10-30");
});

const reminderInput = { slotId: "slot-a", label: "Breakfast", localDate: "2026-10-29", dueAt: BREAKFAST_DUE };

test("the waking decision is due, fed, late or stale, in that order of truth", () => {
  const feeding = { slots: [BREAKFAST], events: [] };
  assert.deepEqual(feedReminderDecision(household(), feeding, reminderInput, BREAKFAST_DUE), {
    kind: "due",
    slotId: "slot-a",
    label: "Breakfast",
    localDate: "2026-10-29",
    dueAt: BREAKFAST_DUE,
  });
  assert.equal(
    feedReminderDecision(household(), feeding, reminderInput, BREAKFAST_DUE + FEED_REMINDER_GRACE_MS).kind,
    "due",
    "the grace window is inclusive",
  );
  assert.equal(
    feedReminderDecision(household(), feeding, reminderInput, BREAKFAST_DUE + FEED_REMINDER_GRACE_MS + 1).kind,
    "late",
  );

  const fed = {
    ...feeding,
    events: [
      {
        id: "event-1",
        slotId: "slot-a",
        localDate: "2026-10-29",
        at: "2026-10-29T06:10:00.000Z",
        byUserId: "owner",
        byLabel: "Alex",
        source: "ui" as const,
        actionId: "http:feed-1",
      },
    ],
  };
  const decision = feedReminderDecision(household(), fed, reminderInput, BREAKFAST_DUE + 60_000);
  assert.deepEqual(decision, { kind: "fed", slotId: "slot-a", localDate: "2026-10-29", byLabel: "Alex" });
  // A fed slot stays skipped even if the wake is hours late: nothing is waiting.
  assert.equal(feedReminderDecision(household(), fed, reminderInput, BREAKFAST_DUE + 9 * 3_600_000).kind, "fed");

  // The schedule no longer matches the task: removed, deactivated or moved.
  assert.equal(feedReminderDecision(household(), { slots: [], events: [] }, reminderInput, BREAKFAST_DUE).kind, "rescheduled");
  assert.equal(
    feedReminderDecision(household(), { slots: [{ ...BREAKFAST, active: false }], events: [] }, reminderInput, BREAKFAST_DUE).kind,
    "rescheduled",
  );
  assert.equal(
    feedReminderDecision(household(), { slots: [{ ...BREAKFAST, timeLocal: "07:30" }], events: [] }, reminderInput, BREAKFAST_DUE).kind,
    "rescheduled",
  );
});

test("the reminder list parses strictly and a version-2 household migrates to an empty one", () => {
  const ref = { taskId: 7, slotId: "slot-a", localDate: "2026-10-29", dueAt: BREAKFAST_DUE };
  assert.deepEqual(parseFeedReminderRefs([ref]), [ref]);
  for (const bad of [
    [{}],
    [{ ...ref, taskId: 0 }],
    [{ ...ref, slotId: "" }],
    [{ ...ref, slotId: "a b" }],
    [{ ...ref, localDate: "2026-02-30" }],
    [{ ...ref, dueAt: -1 }],
    [{ ...ref, extra: true }],
    [ref, { ...ref }],
    [ref, { ...ref, taskId: 8 }],
  ]) {
    assert.equal(parseFeedReminderRefs(bad), undefined, JSON.stringify(bad));
  }

  const migrate = HouseholdDoc.definition.migrate;
  assert.ok(migrate);
  const versionTwo = {
    schemaVersion: 2,
    rev: 4,
    name: "Our household",
    timezone: "Europe/Paris",
    timezoneConfirmedAt: "2026-10-29T04:00:00.000Z",
    members: [{ id: "owner", name: "Alex" }],
    conversationId: 1,
    systemConversationId: 2,
    createdAt: "2026-10-29T04:00:00.000Z",
    settings: household().settings,
  };
  const migrated = migrate(versionTwo as never, 2);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.rev, 4, "a version-2 household keeps its revision");
  assert.deepEqual(migrated.feedReminders, []);
  assert.deepEqual(migrated.members, [{ id: "owner", name: "Alex" }]);
});

// --- the armed tasks against a fake harness clock ---------------------------

type FakeTimer = { at: number; fire: () => void; cancelled: boolean };

/** A harness clock and timer set, so a reminder's sleep can be advanced. */
function fakeClock(start: number) {
  let current = start;
  const timers = new Set<FakeTimer>();
  const fireDue = (): void => {
    for (;;) {
      const next = [...timers]
        .filter((timer) => !timer.cancelled && timer.at <= current)
        .sort((a, b) => a.at - b.at)[0];
      if (next === undefined) return;
      timers.delete(next);
      next.fire();
    }
  };
  return {
    now: () => current,
    setTimer: (callback: () => void, delayMs: number) => {
      const timer: FakeTimer = { at: current + delayMs, fire: callback, cancelled: false };
      timers.add(timer);
      return () => {
        timer.cancelled = true;
        timers.delete(timer);
      };
    },
    /** Jump the harness clock; due timers fire from `until()`'s next pass. */
    advanceTo: (instant: number) => {
      current = instant;
    },
    fireDue,
  };
}

type Clock = ReturnType<typeof fakeClock>;

/**
 * Poll a read until it answers, firing the fake timers that are due each pass
 * (the scheduler arms its next wake in a microtask after a phase commits).
 */
async function until<T>(probe: () => Promise<T | undefined>, label: string, clock: Clock): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    clock.fireDue();
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Ref ids are stored as plain numbers; the Harness brands its own. */
function taskId(id: number): TaskId {
  return id as TaskId;
}

async function resultOf(harness: OpenedHarness["harness"], id: number, clock: Clock): Promise<unknown> {
  const state = await until(async () => {
    const current = (await harness.getTask(taskId(id), context))?.state;
    return current?.status === "terminal" ? current : undefined;
  }, `task ${id} to be terminal`, clock);
  return state.outcome.result;
}

type Fixture = { opened: OpenedHarness; clock: Clock; refs: () => Promise<FeedReminderRef[]> };

/** Boot a two-caregiver household on a fake clock and save the meal slots. */
async function withReminders(
  run: (fixture: Fixture) => Promise<void>,
  slots: readonly MealSlot[] = [BREAKFAST, DINNER],
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-reminders-"));
  const clock = fakeClock(START);
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const registry = createRegistry();
  registry.install(createReminders());
  const opened = await openHarness({
    path: join(dir, "pupkeep.sqlite"),
    models,
    registry,
    now: clock.now,
    setTimer: clock.setTimer,
  });
  try {
    await bootstrapSession(opened.harness, {
      config: config(owner, partner),
      context,
      timezone: "Europe/Paris",
      now: () => new Date(clock.now()),
    });
    const saved = await updateMealSlots(opened.harness, context, {
      actor: alex,
      actionId: "http:slots-1",
      rev: 0,
      slots: [...slots],
      now: new Date(clock.now()),
    });
    assert.equal(saved, "updated");
    await run({
      opened,
      clock,
      refs: async () => (await readHousehold(opened.harness, context)).feedReminders,
    });
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

test("the meal-slot write arms one background task per slot on the system conversation", async () => {
  await withReminders(async ({ opened, clock, refs }) => {
    const household = await readHousehold(opened.harness, context);
    const armed = await refs();
    assert.deepEqual(
      armed.map((ref) => [ref.slotId, ref.localDate, ref.dueAt]),
      [
        ["slot-a", "2026-10-29", BREAKFAST_DUE],
        ["slot-b", "2026-10-29", DINNER_DUE],
      ],
    );
    assert.equal(new Set(armed.map((ref) => ref.taskId)).size, 2, "one task per slot");

    for (const ref of armed) {
      const record = await opened.harness.getTask(taskId(ref.taskId), context);
      assert.ok(record, "the persisted id names a real task");
      assert.equal(record.kind, FEED_REMINDER_TASK, "the id names a reminder task");
      assert.equal(record.conversationId, household.systemConversationId, "owned by the hidden system conversation");
      assert.equal(record.background, true, "background: never holds the human thread busy");
      assert.equal(record.owner, undefined, "a conversation-owned task, not a tool's child");
      assert.equal(record.state.status, "pending");
    }
    assert.deepEqual((await opened.harness.getTask(taskId(armed[0]!.taskId), context))?.input, {
      slotId: "slot-a",
      label: "Breakfast",
      localDate: "2026-10-29",
      dueAt: BREAKFAST_DUE,
    });

    // §9.1: the hidden conversation can never spend budget.
    const system = await opened.harness.conversation(household.systemConversationId as never, context);
    assert.ok(system);
    assert.equal((await system.agent(context)).model, undefined, "a reminder task has no model to call");
  });
});

test("re-saving the same schedule reuses the tasks instead of doubling the reminders", async () => {
  await withReminders(async ({ opened, clock, refs }) => {
    const first = await refs();
    assert.equal(
      await updateMealSlots(opened.harness, context, {
        actor: alex,
        actionId: "http:slots-2",
        rev: 1,
        slots: [BREAKFAST, DINNER],
        now: new Date(clock.now()),
      }),
      "updated",
    );
    assert.deepEqual(await refs(), first, "the same phase arms nothing new");

    opened.harness.resume();
    const live = await until(async () => {
      const tasks = (await opened.harness.inspect(context)).tasks.filter(
        (task) => task.record.kind === FEED_REMINDER_TASK,
      );
      return tasks.length === 2 ? tasks : undefined;
    }, "two live reminder tasks", clock);
    assert.equal(live.length, 2, "two slots, two tasks — never four");
  });
});

test("moving a slot arms a new task, and the old one no-ops when it wakes", async () => {
  await withReminders(async ({ opened, clock, refs }) => {
    const before = await refs();
    const oldBreakfast = before.find((ref) => ref.slotId === "slot-a");
    assert.ok(oldBreakfast);

    // Breakfast moves from 07:00 to 07:30, which is 07:45 local with the delay.
    assert.equal(
      await updateMealSlots(opened.harness, context, {
        actor: alex,
        actionId: "http:slots-2",
        rev: 1,
        slots: [{ ...BREAKFAST, timeLocal: "07:30" }, DINNER],
        now: new Date(clock.now()),
      }),
      "updated",
    );
    const after = await refs();
    const newBreakfast = after.find((ref) => ref.slotId === "slot-a");
    assert.ok(newBreakfast);
    assert.notEqual(newBreakfast.taskId, oldBreakfast.taskId, "a reschedule is a new task");
    assert.equal(newBreakfast.dueAt, Date.parse("2026-10-29T06:45:00Z"));
    assert.equal(newBreakfast.localDate, oldBreakfast.localDate);
    assert.equal(after.length, 2, "one ref per slot, not one per arm");

    opened.harness.resume();
    clock.advanceTo(BREAKFAST_DUE);
    assert.deepEqual(await resultOf(opened.harness, oldBreakfast.taskId, clock), {
      kind: "rescheduled",
      slotId: "slot-a",
      localDate: "2026-10-29",
    });
    // The new arm is still asleep until 07:45 local.
    assert.equal((await opened.harness.getTask(taskId(newBreakfast.taskId), context))?.state.status, "sleeping");
    clock.advanceTo(Date.parse("2026-10-29T06:45:00Z"));
    assert.equal((await resultOf(opened.harness, newBreakfast.taskId, clock) as { kind: string }).kind, "due");
  });
});

test("a save after midnight drops the previous day's reminders", async () => {
  await withReminders(async ({ opened, clock, refs }) => {
    const before = await refs();
    assert.deepEqual(before.map((ref) => ref.localDate), ["2026-10-29", "2026-10-29"]);

    // 06:00 in Paris the next day: yesterday's refs are pruned, not carried.
    clock.advanceTo(Date.parse("2026-10-30T05:00:00Z"));
    assert.equal(
      await updateMealSlots(opened.harness, context, {
        actor: alex,
        actionId: "http:slots-2",
        rev: 1,
        slots: [BREAKFAST, DINNER],
        now: new Date(clock.now()),
      }),
      "updated",
    );
    const after = await refs();
    assert.deepEqual(after.map((ref) => ref.localDate), ["2026-10-30", "2026-10-30"]);
    assert.deepEqual(after.map((ref) => ref.dueAt), [
      Date.parse("2026-10-30T06:15:00Z"),
      Date.parse("2026-10-30T17:15:00Z"),
    ]);
    assert.equal(
      after.some((ref) => before.some((old) => old.taskId === ref.taskId)),
      false,
      "a new day re-arms new tasks",
    );
  });
});

test("a timezone change leaves today's arm stale until the next save re-arms it", async () => {
  await withReminders(async ({ opened, clock, refs }) => {
    const breakfast = (await refs()).find((ref) => ref.slotId === "slot-a");
    assert.ok(breakfast);

    // Paris → Lisbon (no summer time by late October): 07:00 local is now an
    // hour later in UTC, so the armed instant no longer matches the schedule.
    assert.equal(
      await updateHouseholdTimezone(opened.harness, context, {
        actor: alex,
        actionId: "http:zone-1",
        rev: 0,
        timezone: "Europe/Lisbon",
        now: new Date(clock.now()),
      }),
      "updated",
    );
    opened.harness.resume();
    clock.advanceTo(BREAKFAST_DUE);
    assert.deepEqual(await resultOf(opened.harness, breakfast.taskId, clock), {
      kind: "rescheduled",
      slotId: "slot-a",
      localDate: "2026-10-29",
    });

    // The next schedule write arms the new instant; re-arming on a zone change
    // itself is P4-04's reconciliation, not this skeleton's.
    assert.equal(
      await updateMealSlots(opened.harness, context, {
        actor: alex,
        actionId: "http:slots-2",
        rev: 1,
        slots: [BREAKFAST, DINNER],
        now: new Date(clock.now()),
      }),
      "updated",
    );
    const rearmed = (await refs()).find((ref) => ref.slotId === "slot-a");
    assert.equal(rearmed?.dueAt, Date.parse("2026-10-29T07:15:00Z"));
    assert.equal(rearmed?.localDate, "2026-10-29");
  });
});

test("a renamed slot keeps its task and reminds with the current label", async () => {
  await withReminders(async ({ opened, clock, refs }) => {
    const before = (await refs()).find((ref) => ref.slotId === "slot-a");
    assert.ok(before);
    // Same time, new label: the due instant is unchanged, so the arm is reused.
    assert.equal(
      await updateMealSlots(opened.harness, context, {
        actor: alex,
        actionId: "http:slots-2",
        rev: 1,
        slots: [{ ...BREAKFAST, label: "Morning meal" }, DINNER],
        now: new Date(clock.now()),
      }),
      "updated",
    );
    const after = (await refs()).find((ref) => ref.slotId === "slot-a");
    assert.equal(after?.taskId, before.taskId, "a rename is not a new reminder");
    assert.equal((await opened.harness.getTask(taskId(before.taskId), context))?.input !== undefined, true);

    opened.harness.resume();
    clock.advanceTo(BREAKFAST_DUE);
    // The copy quotes the schedule as it is at wake time, never the stale arm.
    assert.deepEqual(await resultOf(opened.harness, before.taskId, clock), {
      kind: "due",
      slotId: "slot-a",
      label: "Morning meal",
      localDate: "2026-10-29",
      dueAt: BREAKFAST_DUE,
    });
  });
});

test("a long wait sleeps in six-hour chunks and re-arms, never one twelve-hour hop", async () => {
  await withReminders(async ({ opened, clock, refs }) => {
    const dinner = (await refs()).find((ref) => ref.slotId === "slot-b");
    assert.ok(dinner);
    opened.harness.resume();

    // §8.5: the sleep is capped, and each chunk is a durable checkpoint the
    // scheduler re-arms. Dinner is 12h15m away, so two chunks come first.
    const firstChunk = await until(async () => {
      const wake = opened.harness.wake();
      return wake.at === START + 6 * 3_600_000 ? wake : undefined;
    }, "the first six-hour chunk", clock);
    assert.equal(firstChunk.active, false, "the task is asleep, not runnable");
    assert.equal((await opened.harness.getTask(taskId(dinner.taskId), context))?.state.status, "sleeping");

    clock.advanceTo(START + 6 * 3_600_000);
    await until(async () => {
      const wake = opened.harness.wake();
      return wake.at === START + 12 * 3_600_000 ? wake : undefined;
    }, "the second six-hour chunk", clock);

    clock.advanceTo(DINNER_DUE);
    assert.deepEqual(await resultOf(opened.harness, dinner.taskId, clock), {
      kind: "due",
      slotId: "slot-b",
      label: "Dinner",
      localDate: "2026-10-29",
      dueAt: DINNER_DUE,
    });
  }, [DINNER]);
});

test("a reminder wakes at slot time plus the delay, reports due, and writes nothing", async () => {
  await withReminders(async ({ opened, clock, refs }) => {
    const breakfast = (await refs()).find((ref) => ref.slotId === "slot-a");
    assert.ok(breakfast);
    const householdBefore = await opened.harness.snapshot(HouseholdDoc, context);
    const feedingBefore = await opened.harness.snapshot(FeedingDoc, context);
    const activityBefore = await opened.harness.snapshot(ActivityDoc, context);

    opened.harness.resume();
    clock.advanceTo(BREAKFAST_DUE);
    // The outcome is the decision P4 turns into a notification intent; until
    // delivery lands, nothing else may be written.
    assert.deepEqual(await resultOf(opened.harness, breakfast.taskId, clock), {
      kind: "due",
      slotId: "slot-a",
      label: "Breakfast",
      localDate: "2026-10-29",
      dueAt: BREAKFAST_DUE,
    });
    assert.deepEqual(await opened.harness.snapshot(HouseholdDoc, context), householdBefore);
    assert.deepEqual(await opened.harness.snapshot(FeedingDoc, context), feedingBefore);
    assert.deepEqual(await opened.harness.snapshot(ActivityDoc, context), activityBefore);
    assert.deepEqual((await opened.harness.snapshot(NotificationsDoc, context))?.items, [], "delivery is P4");

    // Dinner's task was untouched by breakfast's wake.
    const dinner = (await refs()).find((ref) => ref.slotId === "slot-b");
    assert.ok(dinner);
    assert.equal((await opened.harness.getTask(taskId(dinner.taskId), context))?.state.status, "sleeping");
  });
});

test("a slot that was already fed is skipped, not reminded", async () => {
  await withReminders(async ({ opened, clock, refs }) => {
    const breakfast = (await refs()).find((ref) => ref.slotId === "slot-a");
    assert.ok(breakfast);

    const logged = await logFeed(opened.harness, context, {
      actor: alex,
      actionId: "http:feed-1",
      slotId: "slot-a",
      source: "ui",
      now: new Date(BREAKFAST_DUE - 60_000),
    });
    assert.equal(logged.kind, "logged");

    opened.harness.resume();
    clock.advanceTo(BREAKFAST_DUE);
    assert.deepEqual(await resultOf(opened.harness, breakfast.taskId, clock), {
      kind: "fed",
      slotId: "slot-a",
      localDate: "2026-10-29",
      byLabel: "Alex",
    });
  });
});

test("a wake past the grace window is skipped rather than fired late in a burst", async () => {
  await withReminders(async ({ opened, clock, refs }) => {
    const breakfast = (await refs()).find((ref) => ref.slotId === "slot-a");
    assert.ok(breakfast);

    opened.harness.resume();
    // The phone was off all morning: the reminder is due hours later, with the
    // slot still unfed. A burst would announce it now; the rule skips it.
    clock.advanceTo(BREAKFAST_DUE + FEED_REMINDER_GRACE_MS + 60_000);
    assert.deepEqual(await resultOf(opened.harness, breakfast.taskId, clock), {
      kind: "late",
      slotId: "slot-a",
      localDate: "2026-10-29",
      dueAt: BREAKFAST_DUE,
    });
    assert.deepEqual((await opened.harness.snapshot(NotificationsDoc, context))?.items, []);
  });
});

test("a reminder whose documents are gone skips and does not create them", async () => {
  // A stray task after a partial restore: the household and schedule are
  // absent. Reading through `tx.doc()` would create an empty household with no
  // conversations — a document boot then refuses — so the check must only read.
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-reminders-"));
  const clock = fakeClock(START);
  const registry = createRegistry();
  registry.install(createReminders());
  const opened = await openHarness({
    path: join(dir, "pupkeep.sqlite"),
    registry,
    now: clock.now,
    setTimer: clock.setTimer,
  });
  try {
    const conversation = await opened.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const id = await opened.harness.commit(
      (tx) =>
        tx.createTask(
          FeedReminder,
          { slotId: "slot-a", label: "Breakfast", localDate: "2026-10-29", dueAt: clock.now() },
          { ownership: { kind: "conversation" }, conversationId: conversation.id, background: true },
        ),
      context,
    );
    opened.harness.resume();
    assert.deepEqual(await resultOf(opened.harness, Number(id), clock), {
      kind: "rescheduled",
      slotId: "slot-a",
      localDate: "2026-10-29",
    });
    assert.equal(await opened.harness.snapshot(HouseholdDoc, context), undefined, "no household was created");
    assert.equal(await opened.harness.snapshot(FeedingDoc, context), undefined, "no schedule was created");
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("every server process installs the reminder task beside the care tools", () => {
  const registry = createRegistry();
  installAppExtensions(registry);
  const tasks = registry.snapshot().tasks().map((task) => task.definition.name);
  assert.ok(tasks.includes(FEED_REMINDER_TASK), "the task kind is installed, or an armed task could never run");
  const tools = registry.snapshot().tools().map((entry) => entry.tool.name);
  for (const name of ["log_feeding", "get_feeding_day", "start_walk", "end_walk", "get_context"]) {
    assert.ok(tools.includes(name), `${name} is installed`);
  }
});
