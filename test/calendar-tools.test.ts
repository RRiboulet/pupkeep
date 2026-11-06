// P4-02: the calendar's agent surface (PLAN §10.1, §10.3, §16 P4-02).
//
// What is covered:
//   * `list_appointments`: the ranged answer, the derived end time, JSON-quoted
//     free text, the reminder copy, the next line, the empty answer and a
//     refused range;
//   * `get_context`: the next-appointment line with a household-local countdown,
//     and no "not tracked" line left;
//   * the security shape: the extension ships **reads only**. Appointment writes
//     are schedule changes, so their tools wait for P4-07's approval path; a
//     direct write tool here would be exactly the confirmation bypass the plan
//     forbids.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createCalendarTools } from "../src/server/agent/calendar-tools.ts";
import { calendarReportText, nextAppointmentText } from "../src/server/agent/calendar-text.ts";
import { createProfileTools } from "../src/server/agent/tools.ts";
import { cancelAppointment, createAppointment, type CalendarView } from "../src/server/domain/calendar.ts";
import { CalendarDoc } from "../src/server/domain/docs.ts";
import { CALENDAR_WINDOW_RULE } from "../src/shared/calendar.ts";
import type { Appointment } from "../src/shared/domain.ts";
import {
  conversationIdOf,
  resultText,
  startTestApp,
  toolApi,
  type TestApp,
} from "./support/app.ts";

const context = BACKGROUND_CONTEXT;
/** 23:30Z is 30 October in Paris: the default range and "today" start there. */
const LATE = new Date("2026-10-29T23:30:00.000Z");

const FIELDS = {
  title: "Vet visit",
  localDate: "2026-12-20",
  timeLocal: "09:00",
  durationMin: 30,
  location: "Rue de Lyon",
  vetName: "Dr Moreau",
  notes: "bring the vaccination card",
};

function startToolsApp(): Promise<TestApp> {
  return startTestApp({ prefix: "pupkeep-calendar-tools-", now: LATE.getTime(), timezone: "Europe/Paris" });
}

function tools() {
  return new Map(
    [...(createCalendarTools().tools ?? []), ...(createProfileTools().tools ?? [])].map((tool) => [tool.name, tool]),
  );
}

async function seed(
  fixture: TestApp,
  actionId = "http:seed",
  overrides: Record<string, unknown> = {},
): Promise<Appointment> {
  const outcome = await createAppointment(fixture.app.app, context, {
    actor: async () => ({ id: "owner", label: "Alex" }),
    actionId,
    fields: { ...FIELDS, ...overrides },
    now: LATE,
  });
  assert.equal(outcome.kind, "created");
  return outcome.appointment;
}

test("list_appointments answers an empty range and the household's own dates", async () => {
  const fixture = await startToolsApp();
  try {
    const list = tools().get("list_appointments");
    assert.ok(list);
    const result = await list.execute({}, toolApi(fixture, await conversationIdOf(fixture)), context);
    assert.equal(
      resultText(result),
      "Appointments 2026-10-30 to 2027-01-28 (Europe/Paris), today 2026-10-30: none.\n\nNext: none scheduled.",
    );
  } finally {
    await fixture.stop();
  }
});

test("list_appointments renders the derived end, quoted text and the reminder copy", async () => {
  const fixture = await startToolsApp();
  try {
    await seed(fixture);
    const list = tools().get("list_appointments");
    assert.ok(list);
    const result = await list.execute({}, toolApi(fixture, await conversationIdOf(fixture)), context);
    assert.deepEqual(result.output, [
      {
        type: "text",
        text:
          'Appointments 2026-10-30 to 2027-01-28 (Europe/Paris), today 2026-10-30: 1 scheduled.\n' +
          "\n" +
          '2026-12-20 09:00-09:30 "Vet visit"; scheduled; at "Rue de Lyon"; vet "Dr Moreau"; note "bring the vaccination card"; reminders 1 day before, 1 hour before\n' +
          "\n" +
          'Next: 2026-12-20 09:00 "Vet visit".',
      },
    ]);
  } finally {
    await fixture.stop();
  }
});

test("list_appointments honours a range, shows cancelled history and refuses a bad window", async () => {
  const fixture = await startToolsApp();
  try {
    await seed(fixture, "http:nov", { title: "November visit", localDate: "2026-11-20" });
    const decemberVisit = await seed(fixture, "http:dec", { title: "December visit", localDate: "2026-12-20" });
    const cancelled = await cancelAppointment(fixture.app.app, context, {
      actor: async () => ({ id: "owner", label: "Alex" }),
      actionId: "http:cancel",
      id: decemberVisit.id,
      rev: decemberVisit.rev,
      now: LATE,
    });
    assert.equal(cancelled.kind, "changed");

    const list = tools().get("list_appointments");
    assert.ok(list);
    const conversationId = await conversationIdOf(fixture);
    const api = () => toolApi(fixture, conversationId);

    const december = await list.execute({ from: "2026-12-01", to: "2026-12-31" }, api(), context);
    const text = resultText(december);
    assert.match(text, /^Appointments 2026-12-01 to 2026-12-31 \(Europe\/Paris\)/);
    assert.match(text, /"December visit"; cancelled/);
    assert.doesNotMatch(text, /\n2026-11-20 /, "the range's list excludes November");
    assert.match(text, /Next: 2026-11-20 09:00 "November visit"\./, "but the next appointment is still reported");

    const refused = await list.execute({ from: "2026-12-31", to: "2026-12-01" }, api(), context);
    assert.equal(resultText(refused), `${CALENDAR_WINDOW_RULE}. Nothing was read.`);
    assert.equal(refused.isError, true);
  } finally {
    await fixture.stop();
  }
});

test("a completed record is counted as completed, not as a cancellation", async () => {
  const fixture = await startToolsApp();
  try {
    await seed(fixture, "http:one", { title: "Scheduled visit", localDate: "2026-11-20" });
    const done = await seed(fixture, "http:two", { title: "Done visit", localDate: "2026-11-21" });
    await fixture.app.app.commit(async (tx) => {
      const draft = await tx.doc(CalendarDoc);
      draft.appointments = draft.appointments.map((appointment) =>
        appointment.id === done.id ? { ...appointment, status: "completed" as const } : appointment,
      );
    }, context);
    const list = tools().get("list_appointments");
    assert.ok(list);
    const text = resultText(
      await list.execute({ from: "2026-11-01", to: "2026-11-30" }, toolApi(fixture, await conversationIdOf(fixture)), context),
    );
    assert.match(text, /: 1 scheduled, 1 completed\.$/m, "a completed visit is not a cancellation");
  } finally {
    await fixture.stop();
  }
});

test("the next line names the appointment's zone and never counts negative days", () => {
  // A household that moved east of the booked zone: the stored date is
  // "yesterday" while the instant is still upcoming.
  const view = {
    timezone: "Europe/Paris",
    today: "2026-12-21",
    from: "2026-12-01",
    to: "2026-12-31",
    appointments: [],
    defaultReminderOffsetsMin: [],
    next: {
      id: "late",
      title: "Late visit",
      localDate: "2026-12-20",
      timeLocal: "23:30",
      timezone: "America/Los_Angeles",
      durationMin: 30,
      status: "scheduled",
      reminderOffsetsMin: [],
      reminderTaskIds: [],
      createdBy: null,
      createdByLabel: "Household",
      updatedAt: "2026-12-01T00:00:00.000Z",
      rev: 0,
      actionId: "http:seed",
      startsAt: "2026-12-21T07:30:00.000Z",
      endsAt: "2026-12-21T08:00:00.000Z",
    },
  } as unknown as CalendarView;
  assert.equal(
    nextAppointmentText(view),
    'Next appointment: 2026-12-20 23:30 "Late visit" (upcoming, America/Los_Angeles).',
  );
  assert.match(
    calendarReportText(view),
    /Next: 2026-12-20 23:30 "Late visit" \(America\/Los_Angeles\)\./,
    "the next line names the zone the time belongs to",
  );
});

test("get_context carries the next appointment and no untracked line", async () => {
  const fixture = await startToolsApp();
  try {
    await seed(fixture);
    const getContext = tools().get("get_context");
    assert.ok(getContext);
    const text = resultText(await getContext.execute({}, toolApi(fixture, await conversationIdOf(fixture)), context));
    assert.match(text, /^Next appointment: 2026-12-20 09:00 "Vet visit" \(in 51 days, Europe\/Paris\)\.$/m);
    assert.doesNotMatch(text, /Not tracked by this build yet/);
  } finally {
    await fixture.stop();
  }
});

test("the calendar extension ships reads only: writes wait for the approval path", () => {
  const names = (createCalendarTools().tools ?? []).map((tool) => tool.name);
  assert.deepEqual(names, ["list_appointments"]);
  for (const forbidden of ["create_appointment", "update_appointment", "cancel_appointment", "request_cancel_appointment"]) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must not commit without P4-07`);
  }
});
