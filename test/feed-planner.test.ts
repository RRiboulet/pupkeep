// P4-04: the daily feed planner and boot reconciliation (PLAN §8.4, §9.1,
// §10.3, §12.2).
//
// What is pinned here:
//   * exactly one planner task, owned by the hidden system conversation with no
//     model, persisted in the household; a second reconciliation reuses it and
//     arms nothing;
//   * boot reconciliation repairs: missing refs and a terminal planner are
//     re-created, a ref whose task went terminal is replaced by reading the task
//     state (the P2-09 carried note), and past offsets are skipped rather than
//     fired late;
//   * the planner wakes at household-local midnight, plans the new day once, and
//     does not re-plan while that day is its checkpoint;
//   * a timezone change re-arms today's reminders in the new zone in the same
//     commit, so the arms do not wait for midnight;
//   * the planner survives a reopen of the database without a duplicate.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { emptyConfig, type MemberRecord } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import { HouseholdDoc } from "../src/server/domain/docs.ts";
import { updateMealSlots } from "../src/server/domain/feeding.ts";
import { readHousehold, updateHouseholdTimezone } from "../src/server/domain/household.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import { createReminders } from "../src/server/reminders/feed-reminder.ts";
import {
  FEED_PLANNER_TASK,
  feedPlannerWake,
  reconcileFeedReminders,
} from "../src/server/reminders/feed-planner.ts";
import type { Household, MealSlot } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
/** 06:00 in Europe/Paris (CET, +01) on an ordinary autumn Thursday. */
const START = Date.parse("2026-10-29T05:00:00Z");

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

const alex = async () => ({ id: "owner", label: "Alex" });
const BREAKFAST: MealSlot = { id: "slot-a", label: "Breakfast", timeLocal: "07:00", active: true };
const DINNER: MealSlot = { id: "slot-b", label: "Dinner", timeLocal: "18:00", active: true };
/** 07:00 + the default 15-minute delay, in UTC. */
const BREAKFAST_DUE = Date.parse("2026-10-29T06:15:00Z");
/** 18:00 + 15 minutes. */
const DINNER_DUE = Date.parse("2026-10-29T17:15:00Z");

// --- the fake harness clock -------------------------------------------------

type FakeTimer = { at: number; fire: () => void; cancelled: boolean };

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
    advanceTo: (instant: number) => {
      current = instant;
    },
    fireDue,
  };
}

type Clock = ReturnType<typeof fakeClock>;

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

function taskId(id: number): TaskId {
  return id as TaskId;
}

async function terminalOutcome(harness: OpenedHarness["harness"], id: number, clock: Clock) {
  return until(async () => {
    const current = (await harness.getTask(taskId(id), context))?.state;
    return current?.status === "terminal" ? current.outcome : undefined;
  }, `task ${id} to be terminal`, clock);
}

// --- the fixture ------------------------------------------------------------

type Fixture = {
  opened: OpenedHarness;
  clock: Clock;
  path: string;
  household: () => Promise<Household>;
  boot: () => Promise<void>;
};

/**
 * Boot a two-caregiver household at the fixture's clock. `boot` is reusable so
 * a reopen test can run the same session against the same file.
 */
async function withPlanner(
  run: (fixture: Fixture) => Promise<void>,
  options: { start?: number; slots?: readonly MealSlot[]; timezone?: string } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-feed-planner-"));
  const path = join(dir, "pupkeep.sqlite");
  const clock = fakeClock(options.start ?? START);
  const registry = createRegistry();
  registry.install(createReminders());
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const opened = await openHarness({ path, models, registry, now: clock.now, setTimer: clock.setTimer });
  const boot = async (): Promise<void> => {
    await bootstrapSession(opened.harness, {
      config: { ...emptyConfig(), members: [owner, partner] },
      context,
      timezone: options.timezone ?? "Europe/Paris",
      now: () => new Date(clock.now()),
    });
    await updateMealSlots(opened.harness, context, {
      actor: alex,
      actionId: "http:slots-1",
      rev: 0,
      slots: [...(options.slots ?? [BREAKFAST, DINNER])],
      now: new Date(clock.now()),
    });
  };
  try {
    await boot();
    await run({
      opened,
      clock,
      path,
      boot,
      household: () => readHousehold(opened.harness, context),
    });
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

// --- reconciliation ---------------------------------------------------------

test("reconciliation creates exactly one planner and repairs the day's missing reminders", async () => {
  await withPlanner(async ({ opened, clock, household }) => {
    // Simulate a pre-P4-04 document: no planner id and no refs, though the
    // schedule is saved.
    await opened.harness.commit(async (tx) => {
      const draft = await tx.doc(HouseholdDoc);
      draft.feedReminders = [];
      draft.feedPlannerTaskId = null;
    }, context);

    const first = await reconcileFeedReminders(opened.harness, context, new Date(clock.now()));
    assert.equal(first.createdPlanner, true);
    assert.equal(first.armedReminders, 2, "both slots are ahead at 06:00 local");
    const saved = await household();
    assert.ok((saved.feedPlannerTaskId ?? 0) > 0);
    assert.deepEqual(
      saved.feedReminders.map((ref) => [ref.slotId, ref.localDate, ref.dueAt]),
      [
        ["slot-a", "2026-10-29", BREAKFAST_DUE],
        ["slot-b", "2026-10-29", DINNER_DUE],
      ],
    );

    const record = await opened.harness.getTask(taskId(saved.feedPlannerTaskId!), context);
    assert.ok(record);
    assert.equal(record.kind, FEED_PLANNER_TASK);
    assert.equal(record.conversationId, saved.systemConversationId, "owned by the hidden system conversation");
    assert.equal(record.background, true, "background: never holds the human thread busy");
    assert.equal(record.owner, undefined, "a conversation-owned task, not a tool's child");
    // §9.1: the hidden conversation can never spend budget.
    const system = await opened.harness.conversation(saved.systemConversationId as never, context);
    assert.ok(system);
    assert.equal((await system.agent(context)).model, undefined);

    const second = await reconcileFeedReminders(opened.harness, context, new Date(clock.now()));
    assert.equal(second.createdPlanner, false, "a second boot reuses the planner");
    assert.equal(second.armedReminders, 0, "the same day does not re-arm");
    assert.equal((await household()).feedPlannerTaskId, saved.feedPlannerTaskId);
  });
});

test("a past offset is skipped and a ref whose task went terminal is replaced", async () => {
  // 13:00 local: breakfast (07:00) is past, dinner (18:00) is still ahead.
  await withPlanner(
    async ({ opened, clock, household }) => {
      await opened.harness.commit(async (tx) => {
        const draft = await tx.doc(HouseholdDoc);
        draft.feedReminders = [];
        draft.feedPlannerTaskId = null;
      }, context);

      const first = await reconcileFeedReminders(opened.harness, context, new Date(clock.now()));
      assert.equal(first.armedReminders, 1, "the passed breakfast offset is not fired late");
      const armed = await household();
      assert.deepEqual(armed.feedReminders.map((ref) => ref.slotId), ["slot-b"]);
      const oldTask = armed.feedReminders[0]!.taskId;

      // A task that already went terminal is not a reminder: the ref outlives
      // its task, so reconciliation must read the state (the P2-09 note).
      opened.harness.resume();
      assert.deepEqual(await opened.harness.abortTask(taskId(oldTask), context), "marked");
      await terminalOutcome(opened.harness, oldTask, clock);

      // Either the daily plan (already resumed above) or this reconciliation
      // repairs the dead ref; both read the task state and replace it.
      await reconcileFeedReminders(opened.harness, context, new Date(clock.now()));
      const after = await household();
      assert.equal(after.feedReminders.length, 1);
      assert.notEqual(after.feedReminders[0]!.taskId, oldTask, "the dead task id is not trusted");
      assert.equal(after.feedReminders[0]!.dueAt, DINNER_DUE);
    },
    { start: Date.parse("2026-10-29T12:00:00Z") },
  );
});

test("a terminal planner is replaced, and its replacement is the only one", async () => {
  await withPlanner(async ({ opened, clock, household }) => {
    const first = await reconcileFeedReminders(opened.harness, context, new Date(clock.now()));
    assert.equal(first.createdPlanner, true);
    const planner = first.plannerTaskId;
    assert.ok(planner !== null);

    opened.harness.resume();
    await opened.harness.abortTask(taskId(planner), context);
    await terminalOutcome(opened.harness, planner, clock);
    assert.equal((await household()).feedPlannerTaskId, planner, "the dead id is still persisted");

    const repaired = await reconcileFeedReminders(opened.harness, context, new Date(clock.now()));
    assert.equal(repaired.createdPlanner, true);
    assert.ok(repaired.plannerTaskId !== null && repaired.plannerTaskId !== planner);
    assert.equal((await household()).feedPlannerTaskId, repaired.plannerTaskId);
  });
});

// --- the day boundary -------------------------------------------------------

test("the planner wakes at household midnight, plans the new day once and skips nothing late", async () => {
  // 22:00 local: both slots are past, so the day arms nothing. The planner then
  // sleeps to 00:01 and arms the next day in one plan.
  await withPlanner(
    async ({ opened, clock, household }) => {
      const reconciled = await reconcileFeedReminders(opened.harness, context, new Date(clock.now()));
      assert.equal(reconciled.armedReminders, 0);
      assert.deepEqual((await household()).feedReminders, []);

      opened.harness.resume();
      clock.advanceTo(Date.parse("2026-10-29T23:01:00Z")); // 00:01 on the 30th
      const next = await until(async () => {
        const refs = (await household()).feedReminders;
        return refs.length === 2 ? refs : undefined;
      }, "the next day's two reminders", clock);
      assert.deepEqual(
        next.map((ref) => [ref.slotId, ref.localDate]),
        [
          ["slot-a", "2026-10-30"],
          ["slot-b", "2026-10-30"],
        ],
      );

      // It does not re-plan the same day: no new tasks appear on a second wake.
      const before = next.map((ref) => ref.taskId).sort();
      clock.advanceTo(Date.parse("2026-10-30T00:00:00Z"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      clock.fireDue();
      const after = (await household()).feedReminders.map((ref) => ref.taskId).sort();
      assert.deepEqual(after, before);
    },
    { start: Date.parse("2026-10-29T21:00:00Z") },
  );
});

test("feedPlannerWake is the next local midnight plus a minute, capped by the chunk", () => {
  const paris = feedPlannerWake("2026-10-29", "Europe/Paris", Date.parse("2026-10-29T05:00:00Z"));
  assert.equal(paris, Date.parse("2026-10-29T11:00:00Z"), "the six-hour chunk, well before midnight");
  const capped = feedPlannerWake("2026-10-29", "Europe/Paris", Date.parse("2026-10-29T20:00:00Z"));
  assert.equal(capped, Date.parse("2026-10-29T23:01:00Z"), "midnight is inside the chunk");
  const morning = feedPlannerWake("2026-10-29", "Europe/Paris", Date.parse("2026-10-29T00:30:00Z"));
  assert.equal(morning, Date.parse("2026-10-29T06:30:00Z"), "a 6-hour chunk, not 23 hours");
});

// --- reschedules ------------------------------------------------------------

test("a timezone change re-arms today's reminders in the new zone in the same commit", async () => {
  await withPlanner(
    async ({ opened, clock, household }) => {
      await reconcileFeedReminders(opened.harness, context, new Date(clock.now()));
      const before = await household();
      const breakfast = before.feedReminders.find((ref) => ref.slotId === "slot-a");
      assert.ok(breakfast);
      assert.equal(breakfast.dueAt, BREAKFAST_DUE, "07:00 CET plus the 15-minute delay");

      assert.equal(
        await updateHouseholdTimezone(opened.harness, context, {
          actor: alex,
          actionId: "http:zone-1",
          rev: before.rev,
          timezone: "America/New_York",
          now: new Date(clock.now()),
        }),
        "updated",
      );
      const after = await household();
      const moved = after.feedReminders.find((ref) => ref.slotId === "slot-a");
      assert.ok(moved);
      // 07:00 in New York on 29 October is 11:00Z (EDT), +15 minutes.
      assert.equal(moved.dueAt, Date.parse("2026-10-29T11:15:00Z"));
      assert.notEqual(moved.taskId, breakfast.taskId, "the stale arm is replaced, not reused");
      // Dinner (18:00 NY = 22:00Z) is still ahead too.
      assert.equal(after.feedReminders.length, 2);
    },
    { slots: [BREAKFAST, DINNER] },
  );
});

test("the planner and its refs survive a reopen without a duplicate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-feed-planner-reopen-"));
  const path = join(dir, "pupkeep.sqlite");
  const clock = fakeClock(START);
  const registry = createRegistry();
  registry.install(createReminders());
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  try {
    const first = await openHarness({ path, models, registry, now: clock.now, setTimer: clock.setTimer });
    let planner: number | null;
    try {
      await bootstrapSession(first.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => new Date(clock.now()),
      });
      await updateMealSlots(first.harness, context, {
        actor: alex,
        actionId: "http:slots-1",
        rev: 0,
        slots: [BREAKFAST, DINNER],
        now: new Date(clock.now()),
      });
      const reconciled = await reconcileFeedReminders(first.harness, context, new Date(clock.now()));
      planner = reconciled.plannerTaskId;
      assert.equal(reconciled.armedReminders, 0, "the schedule write already armed today's refs");
      assert.equal((await readHousehold(first.harness, context)).feedReminders.length, 2);
    } finally {
      await first.harness.close(context);
    }

    const second = await openHarness({ path, models, registry, now: clock.now, setTimer: clock.setTimer });
    try {
      const boot = await bootstrapSession(second.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => new Date(clock.now()),
      });
      assert.equal(boot.created, false);
      const reconciled = await reconcileFeedReminders(second.harness, context, new Date(clock.now()));
      assert.equal(reconciled.createdPlanner, false, "the persisted planner is reused");
      assert.equal(reconciled.plannerTaskId, planner);
      assert.equal(reconciled.armedReminders, 0, "the same day's refs are intact");
      assert.equal((await readHousehold(second.harness, context)).feedReminders.length, 2);
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
