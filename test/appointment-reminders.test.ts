// P4-03: appointment reminder tasks (PLAN §8.4, §9.1, §10.3, §12.1, §12.2).
//
// What is pinned here:
//   * the pure decision a waking task makes: due, passed, rescheduled (a newer
//     revision or a moved instant), cancelled, completed, missing;
//   * the arming rule: one background task per offset still ahead, owned by the
//     hidden system conversation, never a tool's child, with the record's
//     revision in its input; a past offset is skipped, and a DST-side start is
//     derived in the appointment's own zone;
//   * rescheduling and cancelling: the commit replaces the refs, the caller
//     aborts the replaced tasks, and a task that survives the abort no-ops on
//     its revision/status check instead of reminding at the wrong time;
//   * a replay of the create does not arm a second round of tasks.

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
import { cancelAppointment, createAppointment, readCalendar, updateAppointment } from "../src/server/domain/calendar.ts";
import { HouseholdDoc, NotificationsDoc } from "../src/server/domain/docs.ts";
import { readHousehold } from "../src/server/domain/household.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import { createReminders } from "../src/server/reminders/feed-reminder.ts";
import {
  APPOINTMENT_REMINDER_TASK,
  appointmentReminderDecision,
  type AppointmentReminderInput,
} from "../src/server/reminders/appointment-reminder.ts";
import {
  planAppointmentReminders,
  retireAppointmentReminders,
} from "../src/server/reminders/appointment-schedule.ts";
import type { Appointment, Household } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
/** 06:00 in Europe/Paris (CET, +01) on an ordinary autumn Thursday. */
const START = Date.parse("2026-10-29T05:00:00Z");
/** 10:00 Paris = 09:00Z; the test visit starts then. */
const START_AT = Date.parse("2026-10-29T09:00:00Z");

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
  // 300 minutes is already past at 06:00 local; 60 and 0 are still ahead.
  reminderOffsetsMin: [300, 60, 0],
};

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appointment-1",
    title: "Vet visit",
    localDate: "2026-10-29",
    timeLocal: "10:00",
    timezone: "Europe/Paris",
    durationMin: 30,
    status: "scheduled",
    reminderOffsetsMin: [60, 0],
    reminders: [],
    createdBy: "owner",
    createdByLabel: "Alex",
    updatedAt: "2026-10-29T05:00:00.000Z",
    rev: 0,
    actionId: "http:a-1",
    ...overrides,
  };
}

// --- the pure decisions -----------------------------------------------------

test("the arming rule skips past offsets, derives the instant in the record's zone and stops at the start", () => {
  const plan = planAppointmentReminders(
    {
      id: "a-1",
      rev: 3,
      localDate: "2026-12-20",
      timeLocal: "09:00",
      timezone: "Europe/Paris",
      reminderOffsetsMin: [1440, 60, 0],
    },
    new Date("2026-10-29T05:00:00Z"),
  );
  assert.deepEqual(plan, [
    // 09:00 Paris on 20 December is 08:00Z (CET), so one day before is the 19th
    // at 08:00Z — the wall clock, not the booking day's offset, decides.
    { appointmentId: "a-1", rev: 3, offsetMin: 1440, dueAt: Date.parse("2026-12-19T08:00:00Z") },
    { appointmentId: "a-1", rev: 3, offsetMin: 60, dueAt: Date.parse("2026-12-20T07:00:00Z") },
    { appointmentId: "a-1", rev: 3, offsetMin: 0, dueAt: Date.parse("2026-12-20T08:00:00Z") },
  ]);

  // A visit that has already started arms nothing, even at offset 0.
  assert.deepEqual(
    planAppointmentReminders(
      {
        id: "a-2",
        rev: 0,
        localDate: "2026-10-29",
        timeLocal: "09:00",
        timezone: "Europe/Paris",
        reminderOffsetsMin: [0],
      },
      new Date(START_AT),
    ),
    [],
  );
});

test("a waking task decides due, passed or stale before it decides anything else", () => {
  const input: AppointmentReminderInput = {
    appointmentId: "appointment-1",
    rev: 0,
    offsetMin: 60,
    dueAt: START_AT - 60 * 60_000,
  };
  const armed = appointment({
    reminders: [{ taskId: 1, offsetMin: 60, dueAt: START_AT - 60 * 60_000 }],
  });
  const calendar = { appointments: [armed] };

  assert.deepEqual(appointmentReminderDecision(calendar, input, input.dueAt), {
    kind: "due",
    appointmentId: "appointment-1",
    title: "Vet visit",
    localDate: "2026-10-29",
    timeLocal: "10:00",
    startsAt: START_AT,
    offsetMin: 60,
    dueAt: input.dueAt,
  });
  assert.equal(
    appointmentReminderDecision(calendar, input, START_AT).kind,
    "passed",
    "a wake after the visit started is not a reminder",
  );
  assert.equal(
    appointmentReminderDecision({ appointments: [appointment({ ...armed, rev: 1 })] }, input, input.dueAt).kind,
    "rescheduled",
  );
  assert.equal(
    appointmentReminderDecision(
      { appointments: [appointment({ ...armed, timeLocal: "11:00" })] },
      input,
      input.dueAt,
    ).kind,
    "rescheduled",
    "the same offset against a moved start instant is a stale arm",
  );
  assert.equal(
    appointmentReminderDecision({ appointments: [appointment({ ...armed, status: "cancelled" })] }, input, input.dueAt).kind,
    "cancelled",
  );
  assert.equal(
    appointmentReminderDecision({ appointments: [appointment({ ...armed, status: "completed" })] }, input, input.dueAt).kind,
    "completed",
  );
  assert.equal(
    appointmentReminderDecision({ appointments: [appointment({ reminders: [] })] }, input, input.dueAt).kind,
    "rescheduled",
    "a restore that dropped the ref does not fire",
  );
  assert.equal(appointmentReminderDecision({ appointments: [] }, input, input.dueAt).kind, "missing");
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

async function stateOf(harness: OpenedHarness["harness"], id: number, clock: Clock) {
  return until(async () => {
    const current = (await harness.getTask(taskId(id), context))?.state;
    return current?.status === "terminal" ? current : undefined;
  }, `task ${id} to be terminal`, clock);
}

type Fixture = { opened: OpenedHarness; clock: Clock; household: Household };

async function withAppointmentReminders(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-appointment-reminders-"));
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
      config: { ...emptyConfig(), members: [owner, partner] },
      context,
      timezone: "Europe/Paris",
      now: () => new Date(clock.now()),
    });
    await run({ opened, clock, household: await readHousehold(opened.harness, context) });
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

async function create(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  const outcome = await createAppointment(fixture.opened.harness, context, {
    actor: alex,
    actionId: "http:a-1",
    fields: { ...FIELDS, ...overrides },
    now: new Date(fixture.clock.now()),
    id: "appointment-1",
  });
  assert.equal(outcome.kind, "created");
  return outcome.appointment;
}

// --- the arming -------------------------------------------------------------

test("creating an appointment arms one background task per future offset on the system conversation", async () => {
  await withAppointmentReminders(async (fixture) => {
    const created = await create(fixture);
    assert.deepEqual(
      created.reminders.map((ref) => [ref.offsetMin, ref.dueAt]),
      [
        [60, START_AT - 60 * 60_000],
        [0, START_AT],
      ],
      "the 300-minute offset was already past: skipped, not fired late",
    );
    assert.equal(new Set(created.reminders.map((ref) => ref.taskId)).size, 2, "one task per offset");

    for (const ref of created.reminders) {
      const record = await fixture.opened.harness.getTask(taskId(ref.taskId), context);
      assert.ok(record, "the persisted ref names a real task");
      assert.equal(record.kind, APPOINTMENT_REMINDER_TASK);
      assert.equal(record.conversationId, fixture.household.systemConversationId, "owned by the hidden system thread");
      assert.equal(record.background, true, "background: never holds the human thread busy");
      assert.equal(record.owner, undefined, "a conversation-owned task, not a tool's child");
      assert.equal(record.state.status, "pending", "armed for its due instant, not run yet");
    }
    const first = await fixture.opened.harness.getTask(taskId(created.reminders[0]!.taskId), context);
    assert.deepEqual(first?.input, {
      appointmentId: "appointment-1",
      rev: 0,
      offsetMin: 60,
      dueAt: START_AT - 60 * 60_000,
    });

    // §9.1: the hidden conversation can never spend budget.
    const system = await fixture.opened.harness.conversation(
      fixture.household.systemConversationId as never,
      context,
    );
    assert.ok(system);
    assert.equal((await system.agent(context)).model, undefined);
  });
});

test("a due reminder commits its decision and one intent per caregiver", async () => {
  await withAppointmentReminders(async (fixture) => {
    const created = await create(fixture);
    const reminder = created.reminders.find((ref) => ref.offsetMin === 60);
    assert.ok(reminder);

    fixture.opened.harness.resume();
    fixture.clock.advanceTo(reminder.dueAt);
    const state = await stateOf(fixture.opened.harness, reminder.taskId, fixture.clock);
    assert.deepEqual(state.outcome, {
      status: "completed",
      result: {
        kind: "due",
        appointmentId: "appointment-1",
        title: "Vet visit",
        localDate: "2026-10-29",
        timeLocal: "10:00",
        startsAt: START_AT,
        offsetMin: 60,
        dueAt: reminder.dueAt,
      },
    });
    const intents = (await fixture.opened.harness.snapshot(NotificationsDoc, context))?.items ?? [];
    assert.deepEqual(
      intents.map((item) => [item.category, item.userId, item.title, item.delivery.state]),
      [
        ["appointment", "owner", "Appointment reminder", "pending"],
        ["appointment", "partner", "Appointment reminder", "pending"],
      ],
      "both caregivers, category title only",
    );
    assert.deepEqual(intents.map((item) => item.dedupeKey), [
      `appointment|appointment-1|60|${START_AT}|owner`,
      `appointment|appointment-1|60|${START_AT}|partner`,
    ]);
    assert.match(intents[0]?.body ?? "", /"Vet visit" at 10:00 \(60 minutes before, Europe\/Paris\)\./);
  });
});

test("a replay of the create reuses the recorded refs and arms nothing new", async () => {
  await withAppointmentReminders(async (fixture) => {
    const created = await create(fixture);
    const replay = await createAppointment(fixture.opened.harness, context, {
      actor: alex,
      actionId: "http:a-1",
      fields: FIELDS,
      now: new Date(fixture.clock.now()),
      id: "appointment-1",
    });
    assert.equal(replay.kind, "replayed");
    if (replay.kind === "replayed") {
      assert.deepEqual(replay.appointment.reminders, created.reminders, "the recorded task ids, not a second arm");
    }
    assert.equal((await readCalendar(fixture.opened.harness, context)).appointments.length, 1);
  });
});

// --- rescheduling and cancelling --------------------------------------------

test("a reschedule arms new tasks, returns the old ids and retires them", async () => {
  await withAppointmentReminders(async (fixture) => {
    const created = await create(fixture);
    const oldIds = created.reminders.map((ref) => ref.taskId);

    const updated = await updateAppointment(fixture.opened.harness, context, {
      actor: alex,
      actionId: "http:a-2",
      id: created.id,
      rev: created.rev,
      fields: { ...FIELDS, timeLocal: "11:00" },
      now: new Date(fixture.clock.now()),
    });
    assert.equal(updated.kind, "changed");
    assert.ok(updated.kind === "changed");
    assert.equal(updated.appointment.rev, 1);
    assert.deepEqual(updated.retiredTaskIds, oldIds, "the caller is told exactly what to abort");
    assert.deepEqual(
      updated.appointment.reminders.map((ref) => ref.offsetMin),
      [60, 0],
      "the new revision's tasks",
    );
    assert.notDeepEqual(updated.appointment.reminders.map((ref) => ref.taskId), oldIds);

    // Aborting needs scheduling enabled (the server resumes on start): the
    // abort invocation runs the task's abort handler to a terminal outcome.
    fixture.opened.harness.resume();
    const failed = await retireAppointmentReminders(fixture.opened.harness, updated.retiredTaskIds, context);
    assert.deepEqual(failed, []);
    for (const id of oldIds) {
      const state = await stateOf(fixture.opened.harness, id, fixture.clock);
      assert.deepEqual(state.outcome, { status: "aborted" });
    }

    // A replay of the edit carries the recorded ids: aborting them again is a
    // no-op, never an error (the task is already terminal).
    const replay = await updateAppointment(fixture.opened.harness, context, {
      actor: alex,
      actionId: "http:a-2",
      id: created.id,
      rev: created.rev,
      fields: { ...FIELDS, timeLocal: "11:00" },
      now: new Date(fixture.clock.now()),
    });
    assert.equal(replay.kind, "replayed");
    if (replay.kind === "replayed") {
      assert.deepEqual(replay.retiredTaskIds, oldIds);
      assert.deepEqual(await retireAppointmentReminders(fixture.opened.harness, replay.retiredTaskIds, context), []);
    }

    // The new arm still wakes at its own instant.
    fixture.opened.harness.resume();
    const fresh = updated.appointment.reminders.find((ref) => ref.offsetMin === 60);
    assert.ok(fresh);
    fixture.clock.advanceTo(fresh.dueAt);
    const state = await stateOf(fixture.opened.harness, fresh.taskId, fixture.clock);
    assert.equal((state.outcome as { result: { kind: string } }).result.kind, "due");
  });
});

test("a task that survives the abort (a crash) no-ops instead of reminding", async () => {
  await withAppointmentReminders(async (fixture) => {
    const created = await create(fixture);
    const orphan = created.reminders.find((ref) => ref.offsetMin === 60);
    assert.ok(orphan);

    // Simulate the crash between the cancel's commit and the abort: the task is
    // still armed while the record says cancelled.
    await cancelAppointment(fixture.opened.harness, context, {
      actor: alex,
      actionId: "http:a-2",
      id: created.id,
      rev: created.rev,
      now: new Date(fixture.clock.now()),
    });

    fixture.opened.harness.resume();
    fixture.clock.advanceTo(orphan.dueAt);
    const state = await stateOf(fixture.opened.harness, orphan.taskId, fixture.clock);
    assert.deepEqual(state.outcome, {
      status: "completed",
      result: { kind: "cancelled", appointmentId: "appointment-1" },
    });
    // A cancelled record has no pending reminders.
    assert.deepEqual((await readCalendar(fixture.opened.harness, context)).appointments[0]?.reminders, []);
  });
});

test("a superseded update task that survives its abort no-ops as rescheduled", async () => {
  await withAppointmentReminders(async (fixture) => {
    const created = await create(fixture);
    const oldReminder = created.reminders.find((ref) => ref.offsetMin === 60);
    assert.ok(oldReminder);

    const updated = await updateAppointment(fixture.opened.harness, context, {
      actor: alex,
      actionId: "http:a-2",
      id: created.id,
      rev: created.rev,
      fields: { ...FIELDS, timeLocal: "11:00" },
      now: new Date(fixture.clock.now()),
    });
    assert.equal(updated.kind, "changed");
    // Deliberately skip `retireAppointmentReminders`: this is the crash window.
    fixture.opened.harness.resume();
    fixture.clock.advanceTo(oldReminder.dueAt);
    const state = await stateOf(fixture.opened.harness, oldReminder.taskId, fixture.clock);
    assert.deepEqual(state.outcome, {
      status: "completed",
      result: { kind: "rescheduled", appointmentId: "appointment-1" },
    });
  });
});

test("cancelling returns the armed ids and the retired tasks are terminal", async () => {
  await withAppointmentReminders(async (fixture) => {
    const created = await create(fixture);
    const ids = created.reminders.map((ref) => ref.taskId);

    const cancelled = await cancelAppointment(fixture.opened.harness, context, {
      actor: alex,
      actionId: "http:a-2",
      id: created.id,
      rev: created.rev,
      now: new Date(fixture.clock.now()),
    });
    assert.equal(cancelled.kind, "changed");
    assert.ok(cancelled.kind === "changed");
    assert.deepEqual(cancelled.retiredTaskIds, ids);
    fixture.opened.harness.resume();
    assert.deepEqual(await retireAppointmentReminders(fixture.opened.harness, ids, context), []);
    for (const id of ids) {
      const state = await stateOf(fixture.opened.harness, id, fixture.clock);
      assert.deepEqual(state.outcome, { status: "aborted" }, "the pending task is gone, not merely marked");
    }
  });
});
