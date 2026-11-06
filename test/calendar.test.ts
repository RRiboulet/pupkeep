// P4-01: `app.calendar` and its service (PLAN §8.1, §8.3, §8.4, §7.3, §7.4,
// §9.2, §16 P4-01).
//
// What is covered:
//   * the shape: a wall-clock date and time with a zone snapshot, one line of
//     text, a bounded duration, distinct reminder offsets and task ids, the
//     §9.2 pairing, unique ids and the lifecycle statuses;
//   * the derived instant: a 09:00 visit stays 09:00 through a DST change, the
//     ambiguous and nonexistent hours resolve like a meal slot, and the
//     appointment's own zone — not the household's current one — decides;
//   * the service over a real harness: one commit (record + activity + key), the
//     household's default offsets, replay, key conflict, stale revision,
//     cancellation as a state change, an update re-anchoring the zone, the
//     household fallback actor, and a refused shape writing nothing;
//   * bootstrap and durability: a database that predates P4-01 is repaired, a
//     malformed one refused, a household-less one refused, and the calendar
//     survives a reopen.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { emptyConfig, type MemberRecord } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import {
  ActivityDoc,
  CalendarDoc,
  CommandsDoc,
  HouseholdDoc,
  emptyCalendar,
  parseCalendar,
} from "../src/server/domain/docs.ts";
import {
  AppointmentUnknownError,
  CalendarUnavailableError,
  appointmentInstant,
  cancelAppointment,
  createAppointment,
  readCalendar,
  upcomingAppointments,
  updateAppointment,
} from "../src/server/domain/calendar.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import {
  APPOINTMENT_DURATION_MAX,
  APPOINTMENT_RULE,
  APPOINTMENT_TITLE_LIMIT,
  REMINDER_OFFSETS_MAX,
  REMINDER_OFFSET_MAX_MIN,
  parseAppointment,
  parseAppointmentFields,
  parseAppointmentList,
  parseReminderOffsets,
} from "../src/shared/calendar.ts";
import { watchProfileState } from "../src/server/agent/state.ts";
import { createLogger } from "../src/server/log.ts";
import type { Appointment } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
/** 23:30Z is already the next day in Paris: a UTC date would answer 29 October. */
const LATE = new Date("2026-10-29T23:30:00.000Z");
const TODAY = "2026-10-30";

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

const alex = async () => ({ id: "owner", label: "Alex" });
const householdActor = async () => ({ id: null, label: "Household" });

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appointment-1",
    title: "Vet visit",
    localDate: TODAY,
    timeLocal: "09:00",
    timezone: "Europe/Paris",
    durationMin: 30,
    status: "scheduled",
    reminderOffsetsMin: [1440, 60],
    reminders: [],
    createdBy: "owner",
    createdByLabel: "Alex",
    updatedAt: LATE.toISOString(),
    rev: 0,
    actionId: "http:a-1",
    ...overrides,
  };
}

const fields = {
  title: "Vet visit",
  localDate: TODAY,
  timeLocal: "09:00",
  durationMin: 30,
};

async function withCalendarHarness(run: (opened: OpenedHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-calendar-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
  try {
    await bootstrapSession(opened.harness, {
      config: { ...emptyConfig(), members: [owner, partner] },
      context,
      timezone: "Europe/Paris",
      now: () => LATE,
    });
    await run(opened);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

// --- the shape --------------------------------------------------------------

test("an appointment carries its wall clock, a zone snapshot and one line of text", () => {
  assert.deepEqual(parseAppointment(appointment()), appointment());
  assert.deepEqual(
    parseAppointment(appointment({ title: "  Vet visit  ", location: "  Rue de Lyon ", notes: "x" })),
    { ...appointment(), title: "Vet visit", location: "Rue de Lyon", notes: "x" },
    "text is trimmed",
  );
  assert.equal(parseAppointment({ ...appointment(), extra: true }), undefined, "an unknown key is refused");
  assert.equal(parseAppointment({ ...appointment(), localDate: "2026-02-30" }), undefined);
  assert.equal(parseAppointment({ ...appointment(), timeLocal: "9:00" }), undefined);
  assert.equal(parseAppointment({ ...appointment(), timezone: "Mars/Olympus" }), undefined);
  assert.equal(parseAppointment({ ...appointment(), title: "" }), undefined);
  assert.equal(parseAppointment({ ...appointment(), title: "x".repeat(APPOINTMENT_TITLE_LIMIT + 1) }), undefined);
  assert.equal(parseAppointment({ ...appointment(), title: "two\nlines" }), undefined);
  assert.equal(parseAppointment({ ...appointment(), durationMin: 0 }), undefined);
  assert.equal(parseAppointment({ ...appointment(), durationMin: APPOINTMENT_DURATION_MAX + 1 }), undefined);
  assert.equal(parseAppointment({ ...appointment(), durationMin: 30.5 }), undefined);
  assert.equal(parseAppointment({ ...appointment(), status: "done" }), undefined);
  assert.equal(parseAppointment({ ...appointment(), rev: -1 }), undefined);
  assert.equal(parseAppointment({ ...appointment(), updatedAt: "2026-10-29T23:30:00" }), undefined);
  assert.equal(parseAppointment({ ...appointment(), actionId: "http:a 1" }), undefined);
  // §9.2: no id always travels with the household label.
  assert.equal(parseAppointment({ ...appointment(), createdBy: null }), undefined);
  assert.ok(parseAppointment({ ...appointment(), createdBy: null, createdByLabel: "Household" }));
});

test("a stored record always carries its offsets, and an empty list means off", () => {
  assert.deepEqual(parseAppointmentFields(fields), fields, "the create defaults are the household's");
  assert.equal(
    parseAppointmentFields({ ...fields, reminderOffsetsMin: undefined })?.reminderOffsetsMin,
    undefined,
    "absent is a write-side shorthand, not a stored value",
  );
  assert.deepEqual(parseAppointmentFields({ ...fields, reminderOffsetsMin: [] }), {
    ...fields,
    reminderOffsetsMin: [],
  });
  assert.deepEqual(parseAppointmentFields({ ...fields, reminderOffsetsMin: [1440, 60] }), {
    ...fields,
    reminderOffsetsMin: [1440, 60],
  });
  // A stored record must be explicit: absence would be ambiguous with "off".
  assert.equal(parseAppointment({ ...appointment(), reminderOffsetsMin: undefined }), undefined);
  assert.deepEqual(parseAppointment(appointment({ reminderOffsetsMin: [] }))?.reminderOffsetsMin, []);
  const refs = [
    { taskId: 3, offsetMin: 1440, dueAt: 1_900_000_000_000 },
    { taskId: 7, offsetMin: 60, dueAt: 1_900_100_000_000 },
  ];
  assert.deepEqual(parseAppointment(appointment({ reminders: refs }))?.reminders, refs);
  assert.equal(
    parseAppointment({ ...appointment(), reminders: [refs[0], { ...refs[1], taskId: 3 }] }),
    undefined,
    "a repeated task id could not be retired twice",
  );
  assert.equal(
    parseAppointment({ ...appointment(), reminders: [refs[0], { ...refs[1], offsetMin: 1440 }] }),
    undefined,
    "two tasks for one offset would double the reminder",
  );
  assert.equal(parseAppointment({ ...appointment(), reminders: [{ ...refs[0], taskId: 0 }] }), undefined);
  assert.equal(parseAppointment({ ...appointment(), reminders: [{ ...refs[0], offsetMin: -1 }] }), undefined);
  assert.equal(parseAppointment({ ...appointment(), reminders: [{ ...refs[0], dueAt: 1.5 }] }), undefined);
  assert.equal(
    parseAppointment({ ...appointment(), reminders: [{ ...refs[0], offsetMin: 120 }] }),
    undefined,
    "a ref for an offset the record does not configure is refused",
  );
});

test("reminder offsets are distinct whole minutes within 30 days, in the caller's order", () => {
  assert.deepEqual(parseReminderOffsets([1440, 60]), [1440, 60], "the plan's default is descending; order is kept");
  assert.deepEqual(parseReminderOffsets([0, REMINDER_OFFSET_MAX_MIN]), [0, REMINDER_OFFSET_MAX_MIN]);
  assert.deepEqual(parseReminderOffsets([]), []);
  assert.equal(parseReminderOffsets([0, 0]), undefined, "a duplicate would arm the same reminder twice");
  assert.equal(parseReminderOffsets([-1]), undefined);
  assert.equal(parseReminderOffsets([1.5]), undefined);
  assert.equal(parseReminderOffsets([REMINDER_OFFSET_MAX_MIN + 1]), undefined);
  assert.equal(parseReminderOffsets("1440"), undefined);
  assert.equal(parseReminderOffsets(Array.from({ length: REMINDER_OFFSETS_MAX + 1 }, (_, i) => i)), undefined);
});

test("the calendar refuses a repeated id and an unparseable record", () => {
  assert.deepEqual(parseAppointmentList([appointment()]), [appointment()]);
  assert.deepEqual(parseAppointmentList([]), []);
  assert.equal(
    parseAppointmentList([appointment(), appointment()]),
    undefined,
    "a repeated id is a bug, not a document",
  );
  assert.equal(parseCalendar({ ...emptyCalendar(), appointments: [{ id: "x" }] }), undefined);
  assert.deepEqual(parseCalendar({ ...emptyCalendar(), createdAt: LATE.toISOString() }), {
    schemaVersion: 2,
    appointments: [],
    createdAt: LATE.toISOString(),
  });
});

// --- the derived instant ----------------------------------------------------

test("a 09:00 visit stays 09:00 through a DST change (the derived instant)", () => {
  // Booked on 29 October (CEST, +2) for 20 December (CET, +1): storing the
  // booking-day offset would give 07:00Z, which reads 08:00 in Paris. Deriving
  // in the appointment's zone on its own date gives 08:00Z.
  const winter = appointment({ localDate: "2026-12-20", timeLocal: "09:00" });
  assert.equal(appointmentInstant(winter).toISOString(), "2026-12-20T08:00:00.000Z");
  assert.equal(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      appointmentInstant(winter),
    ),
    "09:00",
  );

  // The same wall clock in summer reads 09:00 CEST = 07:00Z.
  const summer = appointment({ localDate: "2026-07-20", timeLocal: "09:00" });
  assert.equal(appointmentInstant(summer).toISOString(), "2026-07-20T07:00:00.000Z");
});

test("the ambiguous and nonexistent hours resolve like a meal slot", () => {
  // Europe/Paris falls back on 25 October 2026: 02:30 happens twice. The
  // earlier occurrence (CEST, +2) is the one a wall clock shows first.
  const ambiguous = appointment({ localDate: "2026-10-25", timeLocal: "02:30" });
  assert.equal(appointmentInstant(ambiguous).toISOString(), "2026-10-25T00:30:00.000Z");
  // It springs forward on 29 March 2026: 02:30 does not exist; the rule shifts
  // it forward by the gap (03:30 CEST = 01:30Z) so the visit still happens.
  const nonexistent = appointment({ localDate: "2026-03-29", timeLocal: "02:30" });
  assert.equal(appointmentInstant(nonexistent).toISOString(), "2026-03-29T01:30:00.000Z");
});

test("the appointment's own zone decides, not the household's current one", () => {
  // A visit booked in Paris keeps 09:00 Paris even if the household moves.
  const paris = appointment({ localDate: "2026-12-20", timezone: "Europe/Paris" });
  assert.equal(appointmentInstant(paris).toISOString(), "2026-12-20T08:00:00.000Z");
  const newYork = appointment({ localDate: "2026-12-20", timezone: "America/New_York" });
  assert.equal(appointmentInstant(newYork).toISOString(), "2026-12-20T14:00:00.000Z", "09:00 EST");
});

test("upcoming appointments are scheduled, still to come, and ordered by instant", () => {
  const calendar = {
    appointments: [
      appointment({ id: "cancelled", status: "cancelled" }),
      appointment({ id: "past", localDate: "2026-10-29", timeLocal: "09:00" }),
      appointment({ id: "paris-later", localDate: "2026-12-20", timeLocal: "09:00" }),
      appointment({ id: "paris-sooner", localDate: "2026-10-31", timeLocal: "09:00" }),
      appointment({ id: "ny", localDate: "2026-10-30", timeLocal: "09:00", timezone: "America/New_York" }),
    ],
  };
  assert.deepEqual(
    upcomingAppointments(calendar, LATE).map((entry) => entry.id),
    ["ny", "paris-sooner", "paris-later"],
    "09:00 New York (13:00Z, EDT on 30 October) comes after 09:00 Paris (08:00Z)",
  );
  assert.deepEqual(upcomingAppointments(calendar, LATE, 1).map((entry) => entry.id), ["ny"]);
  assert.deepEqual(upcomingAppointments({ appointments: [] }, LATE), []);
});

// --- the service ------------------------------------------------------------

test("creating an appointment is one commit: the record, one activity line and the key", async () => {
  await withCalendarHarness(async (opened) => {
    const outcome = await createAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-1",
      fields: { ...fields, title: "  Vet visit ", location: "Rue de Lyon" },
      now: LATE,
      id: "appointment-1",
    });
    assert.equal(outcome.kind, "created");
    // One task per offset still ahead of the clock: the 60-minute one is; the
    // one-day one already passed at this clock (LATE is 23:30Z on the 29th and
    // the visit starts 08:00Z on the 30th), so it is skipped, not fired late.
    assert.deepEqual(
      outcome.appointment.reminders.map((ref) => ref.offsetMin),
      [60],
      "a past offset is not armed",
    );
    assert.ok((outcome.appointment.reminders[0]?.taskId ?? 0) > 0);
    assert.deepEqual(
      { ...outcome.appointment, reminders: [] },
      {
        id: "appointment-1",
        title: "Vet visit",
        localDate: TODAY,
        timeLocal: "09:00",
        timezone: "Europe/Paris",
        durationMin: 30,
        location: "Rue de Lyon",
        status: "scheduled",
        // The household's default offsets (PLAN §8.3: [1440, 60]).
        reminderOffsetsMin: [1440, 60],
        reminders: [],
        createdBy: "owner",
        createdByLabel: "Alex",
        updatedAt: LATE.toISOString(),
        rev: 0,
        actionId: "http:a-1",
      },
    );
    assert.deepEqual((await readCalendar(opened.harness, context)).appointments, [outcome.appointment]);
    const activity = await opened.harness.snapshot(ActivityDoc, context);
    assert.deepEqual(
      activity?.entries.filter((entry) => entry.kind === "appointment.created").map((entry) => entry.summary),
      ['Alex added the appointment "Vet visit"'],
    );
    const commands = (await opened.harness.snapshot(CommandsDoc, context))?.entries ?? [];
    assert.deepEqual(commands.map((entry) => entry.key), ["http:a-1"]);
  });
});

test("an explicit offset list wins, and an empty household default means no reminders", async () => {
  await withCalendarHarness(async (opened) => {
    await opened.harness.commit(async (tx) => {
      const household = await tx.doc(HouseholdDoc);
      household.settings.appointmentReminderOffsetsMin = [];
    }, context);
    const first = await createAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-1",
      fields,
      now: LATE,
      id: "appointment-1",
    });
    assert.equal(first.kind, "created");
    assert.deepEqual(first.appointment.reminderOffsetsMin, []);

    const second = await createAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-2",
      fields: { ...fields, title: "Groomer", reminderOffsetsMin: [120] },
      now: LATE,
      id: "appointment-2",
    });
    assert.equal(second.kind, "created");
    assert.deepEqual(second.appointment.reminderOffsetsMin, [120]);
  });
});

test("the same action replays as success, a different body is a key conflict, a bad shape writes nothing", async () => {
  await withCalendarHarness(async (opened) => {
    const input = { actor: alex, actionId: "http:a-1", fields, now: LATE, id: "appointment-1" } as const;
    const first = await createAppointment(opened.harness, context, input);
    assert.equal(first.kind, "created");

    const replay = await createAppointment(opened.harness, context, {
      ...input,
      fields: { ...fields, title: " Vet visit " },
    });
    assert.equal(replay.kind, "replayed");
    if (replay.kind === "replayed" && first.kind === "created") assert.deepEqual(replay.appointment, first.appointment);
    assert.equal((await readCalendar(opened.harness, context)).appointments.length, 1, "a replay writes nothing");

    const conflict = await createAppointment(opened.harness, context, {
      ...input,
      fields: { ...fields, title: "Groomer" },
    });
    assert.equal(conflict.kind, "key-conflict");

    await assert.rejects(
      createAppointment(opened.harness, context, {
        actor: alex,
        actionId: "http:a-bad",
        fields: { ...fields, durationMin: 0 },
        now: LATE,
      }),
      (error: unknown) => error instanceof Error && error.message === APPOINTMENT_RULE,
    );
    assert.equal((await readCalendar(opened.harness, context)).appointments.length, 1);
    const commands = (await opened.harness.snapshot(CommandsDoc, context))?.entries ?? [];
    assert.equal(commands.some((entry) => entry.key === "http:a-bad"), false, "a refused write does not burn its key");
  });
});

test("a caregiver the household does not carry writes as the household fallback", async () => {
  await withCalendarHarness(async (opened) => {
    const outcome = await createAppointment(opened.harness, context, {
      actor: householdActor,
      actionId: "tool:task-1",
      fields,
      now: LATE,
      id: "appointment-1",
    });
    assert.equal(outcome.kind, "created");
    assert.equal(outcome.appointment.createdBy, null);
    assert.equal(outcome.appointment.createdByLabel, "Household");
  });
});

test("an update bumps the revision, keeps the creator, and re-anchors the zone", async () => {
  await withCalendarHarness(async (opened) => {
    const created = await createAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-1",
      fields,
      now: LATE,
      id: "appointment-1",
    });
    assert.equal(created.kind, "created");

    // The household moves; the address is now New York.
    await opened.harness.commit(async (tx) => {
      const household = await tx.doc(HouseholdDoc);
      household.timezone = "America/New_York";
    }, context);

    const updated = await updateAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-2",
      id: "appointment-1",
      rev: 0,
      fields: { ...fields, title: "Vet visit (moved)" },
      now: new Date("2026-10-30T12:00:00.000Z"),
    });
    assert.equal(updated.kind, "changed");
    assert.equal(updated.appointment.rev, 1);
    assert.equal(updated.appointment.title, "Vet visit (moved)");
    assert.equal(updated.appointment.timezone, "America/New_York", "the editor writes on the current clock");
    assert.equal(updated.appointment.createdBy, "owner");
    assert.deepEqual(updated.appointment.reminderOffsetsMin, [1440, 60], "absent offsets keep the current list");
    assert.equal(updated.appointment.updatedAt, "2026-10-30T12:00:00.000Z");

    const replay = await updateAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-2",
      id: "appointment-1",
      rev: 0,
      fields: { ...fields, title: "Vet visit (moved)" },
      now: new Date("2026-10-30T12:00:00.000Z"),
    });
    assert.equal(replay.kind, "replayed");
    assert.equal((await readCalendar(opened.harness, context)).appointments[0]?.rev, 1, "a replay writes nothing");

    const activity = await opened.harness.snapshot(ActivityDoc, context);
    assert.deepEqual(
      activity?.entries.filter((entry) => entry.kind === "appointment.updated").map((entry) => entry.summary),
      ['Alex changed the appointment "Vet visit (moved)"'],
    );
  });
});

test("a stale revision is refused with no write, and a cancelled appointment is read-only", async () => {
  await withCalendarHarness(async (opened) => {
    await createAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-1",
      fields,
      now: LATE,
      id: "appointment-1",
    });
    const stale = await updateAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-2",
      id: "appointment-1",
      rev: 7,
      fields: { ...fields, title: "Nope" },
      now: LATE,
    });
    assert.equal(stale.kind, "stale");
    if (stale.kind === "stale") {
      assert.equal(stale.appointment.title, "Vet visit", "the stale answer carries the committed record");
      assert.equal(stale.appointment.rev, 0);
    }
    assert.equal((await readCalendar(opened.harness, context)).appointments[0]?.title, "Vet visit");

    const cancelled = await cancelAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-3",
      id: "appointment-1",
      rev: 0,
      now: LATE,
    });
    assert.equal(cancelled.kind, "changed");
    assert.equal(cancelled.appointment.status, "cancelled");

    await assert.rejects(
      updateAppointment(opened.harness, context, {
        actor: alex,
        actionId: "http:a-4",
        id: "appointment-1",
        rev: 1,
        fields: { ...fields, title: "Still here" },
        now: LATE,
      }),
      /that appointment is cancelled/,
    );
    await assert.rejects(
      cancelAppointment(opened.harness, context, {
        actor: alex,
        actionId: "http:a-5",
        id: "appointment-1",
        rev: 1,
        now: LATE,
      }),
      /that appointment is cancelled/,
    );
    // The record is still there: a cancellation is a state change, not a delete.
    const calendar = await readCalendar(opened.harness, context);
    assert.equal(calendar.appointments.length, 1);
    assert.equal(calendar.appointments[0]?.status, "cancelled");
    assert.deepEqual(calendar.appointments[0]?.reminders, [], "a cancellation clears the armed refs");
  });
});

test("a cancel replays, a wrong id is unknown and a completed record cannot be cancelled", async () => {
  await withCalendarHarness(async (opened) => {
    await createAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-1",
      fields,
      now: LATE,
      id: "appointment-1",
    });
    const first = await cancelAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-2",
      id: "appointment-1",
      rev: 0,
      now: LATE,
    });
    assert.equal(first.kind, "changed");
    const replay = await cancelAppointment(opened.harness, context, {
      actor: alex,
      actionId: "http:a-2",
      id: "appointment-1",
      rev: 0,
      now: LATE,
    });
    assert.equal(replay.kind, "replayed");
    assert.equal((await readCalendar(opened.harness, context)).appointments[0]?.rev, 1, "a replay writes nothing");

    await assert.rejects(
      cancelAppointment(opened.harness, context, {
        actor: alex,
        actionId: "http:a-3",
        id: "missing",
        rev: 0,
        now: LATE,
      }),
      (error: unknown) => error instanceof AppointmentUnknownError && error.status === 404,
      "a missing record answers 404 through the one failure mapper, not a stale 409",
    );

    // A completed record (a future writer, P4-02/P4-03) is read-only.
    await opened.harness.commit(async (tx) => {
      const draft = await tx.doc(CalendarDoc);
      const current = draft.appointments[0]!;
      draft.appointments = [{ ...current, status: "completed", rev: 2 }];
    }, context);
    await assert.rejects(
      cancelAppointment(opened.harness, context, {
        actor: alex,
        actionId: "http:a-4",
        id: "appointment-1",
        rev: 2,
        now: LATE,
      }),
      /that appointment is completed/,
    );
  });
});

test("a missing calendar document is unavailable, not an empty calendar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-calendar-empty-"));
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite") });
  try {
    await assert.rejects(readCalendar(opened.harness, context), CalendarUnavailableError);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an appointment commit publishes the care signal, and the frame carries no calendar data", async () => {
  await withCalendarHarness(async (opened) => {
    const frames: unknown[] = [];
    const watch = watchProfileState({
      harness: opened.harness,
      context,
      bus: { publishState: (profile: unknown) => frames.push(profile) },
      logger: createLogger({ scope: "test", sink: () => undefined }),
      now: () => LATE,
    });
    try {
      await createAppointment(opened.harness, context, {
        actor: alex,
        actionId: "http:a-1",
        fields,
        now: LATE,
        id: "appointment-1",
      });
      const deadline = Date.now() + 2000;
      while (frames.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(frames.length > 0, "app.calendar is one of the documents behind the care frame");
      // The frame is a signal (P2-05): P4-02's calendar re-reads its own route.
      assert.equal("appointments" in (frames.at(-1) as Record<string, unknown>), false);
    } finally {
      watch.stop();
    }
  });
});

// --- bootstrap and durability ---------------------------------------------

test("boot repairs a pre-P4-01 database and refuses a malformed or orphaned one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-calendar-boot-"));
  const path = join(dir, "pupkeep.sqlite");
  try {
    const first = await openHarness({ path });
    try {
      await bootstrapSession(first.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => LATE,
      });
      await first.harness.commit(async (tx) => {
        await tx.retireDoc(CalendarDoc);
      }, context);
    } finally {
      await first.harness.close(context);
    }

    const second = await openHarness({ path });
    try {
      const boot = await bootstrapSession(second.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => LATE,
      });
      assert.equal(boot.created, false);
      assert.ok(boot.docsCreated.includes("app.calendar"));
      assert.deepEqual((await readCalendar(second.harness, context)).appointments, []);

      await second.harness.commit(async (tx) => {
        const draft = await tx.doc(CalendarDoc);
        draft.appointments = [{ id: "x" } as never];
      }, context);
      await assert.rejects(
        bootstrapSession(second.harness, {
          config: { ...emptyConfig(), members: [owner] },
          context,
          timezone: "Europe/Paris",
          now: () => LATE,
        }),
        /app\.calendar is not a shape/,
      );
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a household-less database that already has appointments is refused, not reset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-calendar-orphan-"));
  const path = join(dir, "pupkeep.sqlite");
  try {
    const opened = await openHarness({ path });
    try {
      await opened.harness.commit(async (tx) => {
        const draft = await tx.doc(CalendarDoc);
        draft.createdAt = LATE.toISOString();
      }, context);
      await assert.rejects(
        bootstrapSession(opened.harness, {
          config: { ...emptyConfig(), members: [owner] },
          context,
          timezone: "Europe/Paris",
          now: () => LATE,
        }),
        /app\.household is missing but app\.calendar exists/,
      );
    } finally {
      await opened.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the calendar document migrates version 1 to version 2 without an armed task", () => {
  const migrate = CalendarDoc.definition.migrate;
  assert.ok(migrate, "the document declares its migration");
  const legacy = {
    schemaVersion: 1,
    createdAt: LATE.toISOString(),
    appointments: [
      {
        ...appointment(),
        reminderTaskIds: [],
      },
    ],
  };
  assert.throws(() => migrate(legacy as never, 0), /no migration/);
  const migrated = migrate(legacy as never, 1);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.appointments[0]?.id, "appointment-1", "the appointment survives the upgrade");
  assert.deepEqual(migrated.appointments[0]?.reminders, [], "P4-01 never armed a task");
  assert.equal((migrated.appointments[0] as unknown as Record<string, unknown>).reminderTaskIds, undefined);
  assert.deepEqual(emptyCalendar().schemaVersion, 2, "a fresh document starts at the current version");
});

test("the calendar survives a reopen of the database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-calendar-durable-"));
  const path = join(dir, "pupkeep.sqlite");
  try {
    const first = await openHarness({ path });
    try {
      await bootstrapSession(first.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => LATE,
      });
      await createAppointment(first.harness, context, {
        actor: alex,
        actionId: "http:a-1",
        fields: { ...fields, location: "Rue de Lyon" },
        now: LATE,
        id: "appointment-1",
      });
    } finally {
      await first.harness.close(context);
    }

    const second = await openHarness({ path });
    try {
      const restored = await readCalendar(second.harness, context);
      assert.equal(restored.appointments.length, 1);
      assert.equal(restored.appointments[0]?.location, "Rue de Lyon");
      assert.equal(restored.appointments[0]?.localDate, TODAY);
      assert.deepEqual(parseCalendar(restored), restored);
      assert.equal(appointmentInstant(restored.appointments[0]!).toISOString(), "2026-10-30T08:00:00.000Z");
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
