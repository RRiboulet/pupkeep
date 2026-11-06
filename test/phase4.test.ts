// P4-10: the Phase 4 slice — Gate G4's reminder sentences (PLAN §12.2, §8.4,
// §15.3, §16 P4-10).
//
// Gate G4 says: *a reminder fires after a restart; cancel removes it.* Both
// sentences are about durability across a process death, which is exactly what
// the per-task suites cannot show on their own: P4-03's tests arm and wake a
// task in one open harness, and P4-04's prove a planner survives a reopen. This
// suite closes a harness **while the reminder is still sleeping**, opens the
// same SQLite file again, resumes, and only then moves the clock.
//
// What is pinned:
//   * a sleeping `app.reminder` survives the close, `resume()` re-registers it,
//     and it fires for both caregivers exactly once when its instant arrives;
//   * the write of two offsets produces two distinct intents (the dedupe key
//     carries the offset), and a second resume cannot double them;
//   * cancelling retires the armed tasks, and the reopened process never fires
//     them: no intent is written for a cancelled visit;
//   * the server-side dedupe key is authoritative: the same intent appended
//     again is dropped, so a re-fired reminder cannot duplicate an item.
//
// Not here, on purpose: the approval gate (approval changes nothing until
// confirmed, a double confirm replays, expiry refuses) is pinned in
// `test/approvals.test.ts` and `test/approval-routes.test.ts`, and the push/ntfy/
// Termux delivery in `test/outbox.test.ts`. The device legs of G4 — a real
// Termux:API notification, Web Push over the quick tunnel, the partner's iPhone
// receipt — are P0-10/P4-09's and are not claimed by an automated test.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { emptyConfig, type MemberRecord } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import { cancelAppointment, createAppointment, readCalendar } from "../src/server/domain/calendar.ts";
import { NotificationsDoc } from "../src/server/domain/docs.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import { createReminders } from "../src/server/reminders/feed-reminder.ts";
import { retireAppointmentReminders } from "../src/server/reminders/appointment-schedule.ts";
import type { NotificationIntent } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
/** 06:00 in Paris (CET, +01) on an ordinary autumn Thursday. */
const START = Date.parse("2026-10-29T05:00:00Z");
/** The visit starts at 10:00 Paris = 09:00Z; its offsets are 60 minutes and 0. */
const DUE_60 = Date.parse("2026-10-29T08:00:00Z");
const DUE_0 = Date.parse("2026-10-29T09:00:00Z");

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

const FIELDS = {
  title: "Vet visit",
  localDate: "2026-10-29",
  timeLocal: "10:00",
  durationMin: 30,
  reminderOffsetsMin: [60, 0],
};

type FakeTimer = { at: number; fire: () => void; cancelled: boolean };

/** The harness clock and timer set, so a reminder's sleep can be advanced. */
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

/** Poll while firing due timers, until `probe` answers or the budget runs out. */
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

async function intents(harness: OpenedHarness["harness"]): Promise<NotificationIntent[]> {
  return ((await harness.snapshot(NotificationsDoc, context))?.items as NotificationIntent[] | undefined) ?? [];
}

async function taskState(harness: OpenedHarness["harness"], id: number): Promise<string | undefined> {
  return (await harness.getTask(id as TaskId, context))?.state.status;
}

/**
 * One data directory, opened and closed by each test. `open()` is the same boot
 * the server does: open, bootstrap (a no-op repair after the first time) and
 * `resume()`, which is what re-registers a sleeping reminder after a restart.
 */
async function withDataDir(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-phase4-"));
  try {
    await run(join(dir, "pupkeep.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function boot(path: string, clock: Clock): Promise<OpenedHarness> {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const registry = createRegistry();
  registry.install(createReminders());
  const opened = await openHarness({
    path,
    models,
    registry,
    now: clock.now,
    setTimer: clock.setTimer,
  });
  try {
    await bootstrapSession(opened.harness, {
      config: { ...emptyConfig(), members: [owner, partner] },
      context,
      timezone: "Europe/Paris",
      now: () => new Date(clock.now()),
    });
    // What every server start does (P1-07); a reminder sleeps until this runs.
    opened.harness.resume();
    return opened;
  } catch (error) {
    await opened.harness.close(context);
    throw error;
  }
}

async function seedAppointment(opened: OpenedHarness, clock: Clock) {
  const outcome = await createAppointment(opened.harness, context, {
    actor: alex,
    actionId: "http:seed",
    fields: FIELDS,
    now: new Date(clock.now()),
    id: "appointment-1",
  });
  assert.equal(outcome.kind, "created");
  return outcome.appointment;
}

// --- G4: a reminder fires after a restart -----------------------------------

test("a reminder armed before a restart fires after it, once per caregiver per offset", async () => {
  await withDataDir(async (path) => {
    const clock = fakeClock(START);
    let armedTaskIds: number[] = [];

    const first = await boot(path, clock);
    try {
      const appointment = await seedAppointment(first, clock);
      armedTaskIds = appointment.reminders.map((ref) => ref.taskId);
      assert.equal(armedTaskIds.length, 2, "one task per future offset");
      // No reminder is due yet: nothing has been written.
      assert.deepEqual(await intents(first.harness), []);
    } finally {
      // The close is what a kill leaves behind: the tasks are still sleeping, so
      // nothing about them has been decided. The next open has to find them.
      await first.harness.close(context);
    }

    const second = await boot(path, clock);
    try {
      // `resume()` schedules asynchronously; wait for the arm to be sleeping
      // again before the clock moves, exactly as a booted phone would.
      await until(
        async () => ((await taskState(second.harness, armedTaskIds[0]!)) === "sleeping" ? true : undefined),
        "the arm to resume sleeping",
        clock,
      );

      // The 60-minute reminder's instant arrives.
      clock.advanceTo(DUE_60);
      const afterFirst = await until(
        async () => ((await intents(second.harness)).length === 2 ? await intents(second.harness) : undefined),
        "the first offset's intents",
        clock,
      );
      assert.deepEqual(
        afterFirst.map((item) => [item.category, item.userId]).sort(),
        [
          ["appointment", "owner"],
          ["appointment", "partner"],
        ],
        "both caregivers are reminded, once each",
      );
      // The dedupe key carries the offset and the start instant, which is what
      // makes the second offset a second intent rather than a dropped duplicate.
      const keyOf = (userId: string): string =>
        afterFirst.find((item) => item.userId === userId)!.dedupeKey;
      assert.equal(keyOf("owner"), `appointment|appointment-1|60|${DUE_0}|owner`);
      assert.equal(
        keyOf("partner"),
        `appointment|appointment-1|60|${DUE_0}|partner`,
        "the member id is part of the key, so the two caregivers are two items",
      );
      assert.match(afterFirst[0]!.body, /"Vet visit" at 10:00/);
      await until(
        async () => ((await taskState(second.harness, armedTaskIds[0]!)) === "terminal" ? true : undefined),
        "the first offset's task to finish",
        clock,
      );
      assert.equal(await taskState(second.harness, armedTaskIds[1]!), "sleeping");

      // The start-time reminder arrives too.
      clock.advanceTo(DUE_0);
      const afterSecond = await until(
        async () => ((await intents(second.harness)).length === 4 ? await intents(second.harness) : undefined),
        "the second offset's intents",
        clock,
      );
      assert.equal(afterSecond.length, 4, "two offsets × two caregivers");
      await until(
        async () => ((await taskState(second.harness, armedTaskIds[1]!)) === "terminal" ? true : undefined),
        "the second offset's task to finish",
        clock,
      );
    } finally {
      await second.harness.close(context);
    }

    // A third start must not re-fire a terminal reminder: resuming a finished
    // task is not "run it again". The direct observable is the task state — an
    // intent count alone would pass even if a task re-ran, because the second
    // write carries the same dedupe key and is dropped.
    const third = await boot(path, clock);
    try {
      for (const id of armedTaskIds) {
        assert.equal(await taskState(third.harness, id), "terminal", "a terminal arm is not resumed");
      }
      clock.advanceTo(DUE_0 + 60 * 60_000);
      clock.fireDue();
      assert.equal((await intents(third.harness)).length, 4, "and no intent was written twice");
    } finally {
      await third.harness.close(context);
    }
  });
});

// --- G4: cancel removes it --------------------------------------------------

test("cancelling retires the armed reminder, so a restarted process never fires it", async () => {
  await withDataDir(async (path) => {
    const clock = fakeClock(START);
    let retired: number[] = [];

    const first = await boot(path, clock);
    try {
      const appointment = await seedAppointment(first, clock);
      const cancelled = await cancelAppointment(first.harness, context, {
        actor: alex,
        actionId: "http:cancel",
        id: appointment.id,
        rev: appointment.rev,
        now: new Date(clock.now()),
      });
      assert.equal(cancelled.kind, "changed");
      if (cancelled.kind !== "changed") return;
      retired = cancelled.retiredTaskIds;
      assert.deepEqual([...retired].sort(), appointment.reminders.map((ref) => ref.taskId).sort());
      // The HTTP route's post-commit step; the domain commits the cancellation,
      // the caller retires the tasks it replaced.
      assert.deepEqual(await retireAppointmentReminders(first.harness, retired, context), []);
      assert.equal((await readCalendar(first.harness, context)).appointments[0]!.status, "cancelled");
      assert.deepEqual(await intents(first.harness), [], "cancelling before the due instant writes nothing");
    } finally {
      await first.harness.close(context);
    }

    const second = await boot(path, clock);
    try {
      for (const id of retired) {
        assert.equal(await taskState(second.harness, id), "terminal", "the retired arm is terminal, not sleeping");
      }
      // Walk the clock past both instants: a retired task that somehow ran again
      // would still no-op on the record's status, so this also pins the guard.
      clock.advanceTo(DUE_0 + 60 * 60_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      clock.fireDue();
      assert.deepEqual(await intents(second.harness), [], "a cancelled visit never reminds");
    } finally {
      await second.harness.close(context);
    }
  });
});

// --- the dedupe key is authoritative ----------------------------------------

test("the same intent appended twice is one item, so a duplicate reminder cannot double it", async () => {
  await withDataDir(async (path) => {
    const clock = fakeClock(START);
    const opened = await boot(path, clock);
    try {
      await seedAppointment(opened, clock);
      const appendIntents = async (): Promise<void> => {
        const { notificationIntent, notificationKey } = await import("../src/shared/notifications.ts");
        const { appendNotificationIntents } = await import("../src/server/notifications/intents.ts");
        await opened.harness.commit(async (tx) => {
          await appendNotificationIntents(
            tx,
            (["owner", "partner"] as const).map((userId) =>
              notificationIntent({
                dedupeKey: notificationKey("appointment", "appointment-1", "60", String(DUE_0), userId),
                category: "appointment",
                userId,
                body: '"Vet visit" at 10:00 (60 minutes before, Europe/Paris).',
                now: new Date(clock.now()),
              }),
            ),
            new Date(clock.now()),
          );
        }, context);
      };

      await appendIntents();
      await appendIntents();
      const stored = await intents(opened.harness);
      assert.equal(stored.length, 2, "one item per caregiver, not four");
      assert.ok(
        stored.every((item) => item.category === "appointment" && item.readAt === null),
        "the item is the same record, unread",
      );
    } finally {
      await opened.harness.close(context);
    }
  });
});
