// P4-07: the proposing tools (PLAN §9.3, §10.2, §10.3, §16 P4-07).
//
// What is covered:
//   * every tool in the approvals extension **only proposes**: the calendar and
//     the meal schedule are untouched, and the answer says a confirmation is
//     waiting;
//   * `create_appointment`: the stored action's fixed offsets, the household's
//     default, the summary text and a refused shape;
//   * `update_appointment`: a partial patch merged onto the committed record, the
//     revision captured at propose time, and an unknown id refused;
//   * `request_cancel_appointment` and `request_feeding_schedule_change`;
//   * idempotency on the task id, and the extension's shape: no tool commits a
//     care change, and there is no "execute" tool for the model to reach.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { createApprovalTools } from "../src/server/agent/approval-tools.ts";
import { createCalendarTools } from "../src/server/agent/calendar-tools.ts";
import { createProfileTools } from "../src/server/agent/tools.ts";
import { readApprovals } from "../src/server/domain/approvals.ts";
import { CalendarDoc, parseCalendar, parseApprovals } from "../src/server/domain/docs.ts";
import { ApprovalsDoc } from "../src/server/domain/docs.ts";
import { createAppointment } from "../src/server/domain/calendar.ts";
import { readFeeding, updateMealSlots } from "../src/server/domain/feeding.ts";
import { APPOINTMENT_RULE } from "../src/shared/calendar.ts";
import type { MealSlot } from "../src/shared/domain.ts";
import {
  conversationIdOf,
  resultText,
  startTestApp,
  toolApi,
  until,
  type TestApp,
} from "./support/app.ts";

const context = BACKGROUND_CONTEXT;
const LATE = new Date("2026-10-29T23:30:00.000Z");

const FIELDS = {
  title: "Vet visit",
  localDate: "2026-12-20",
  timeLocal: "09:00",
  durationMin: 30,
  location: "Rue de Lyon",
};

const SLOTS: MealSlot[] = [
  { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true },
  { id: "slot-d", label: "Dinner", timeLocal: "18:00", active: true },
];

function startToolsApp(): Promise<TestApp> {
  return startTestApp({ prefix: "pupkeep-approval-tools-", now: LATE.getTime(), partner: true, timezone: "Europe/Paris" });
}

function tools() {
  return new Map((createApprovalTools().tools ?? []).map((tool) => [tool.name, tool]));
}

function overviewTools() {
  return new Map((createProfileTools().tools ?? []).map((tool) => [tool.name, tool]));
}

async function appointments(fixture: TestApp) {
  const snapshot = await fixture.app.app.snapshot(CalendarDoc, context);
  const calendar = parseCalendar(snapshot);
  assert.ok(calendar, "app.calendar is readable");
  return calendar;
}

test("the approvals extension proposes only: its tools never write a care change", async () => {
  const fixture = await startToolsApp();
  try {
    // The extension's whole surface, by name: every one of them is a proposal.
    assert.deepEqual([...tools().keys()].sort(), [
      "create_appointment",
      "request_cancel_appointment",
      "request_feeding_schedule_change",
      "update_appointment",
    ]);
    for (const tool of tools().values()) {
      assert.equal(tool.replay, "safe", `${tool.name} is idempotent on its task id`);
      // A proposing tool's description must say so, so the model reports the
      // waiting confirmation instead of claiming the change happened.
      assert.match(tool.description ?? "", /confirm/);
    }
    // The calendar extension still holds reads only: a direct write tool beside
    // `list_appointments` would be the confirmation bypass the plan forbids.
    assert.deepEqual(
      (createCalendarTools().tools ?? []).map((tool) => tool.name),
      ["list_appointments"],
    );
  } finally {
    await fixture.stop();
  }
});

test("create_appointment proposes the household's defaults and changes nothing", async () => {
  const fixture = await startToolsApp();
  try {
    const conversation = await conversationIdOf(fixture);
    const create = tools().get("create_appointment");
    assert.ok(create);
    const result = await create.execute({ ...FIELDS }, toolApi(fixture, conversation), context);
    const text = resultText(result);
    assert.match(text, /^A confirmation is waiting in the app: add the appointment "Vet visit" on 2026-12-20 at 09:00/);
    assert.match(text, /Nothing has changed yet/);
    assert.equal(result.isError, undefined);

    // Gate G4: nothing changed.
    assert.deepEqual((await appointments(fixture)).appointments, []);
    assert.equal((await readFeeding(fixture.app.app, context)).rev, 0);

    const approvals = await readApprovals(fixture.app.app, context);
    assert.equal(approvals.length, 1);
    const approval = approvals[0]!;
    assert.equal(approval.status, "pending");
    // No chat entry in this transcript, so the speaker is the household fallback
    // (§9.2) — never an id the model supplied. The real-thread test below pins
    // the opposite case.
    assert.equal(approval.requestedBy, null);
    assert.equal(approval.requestedByLabel, "Household");
    assert.deepEqual(
      approval.action,
      {
        kind: "appointment.create",
        fields: { ...FIELDS, reminderOffsetsMin: [1440, 60] },
      },
      "the stored action fixes the household's default reminder offsets",
    );
    assert.equal(approval.expiresAt, new Date(LATE.getTime() + 24 * 60 * 60 * 1000).toISOString());
    assert.match(text, new RegExp(approval.id));
  } finally {
    await fixture.stop();
  }
});

test("create_appointment refuses a shape the document would not store, and writes nothing", async () => {
  const fixture = await startToolsApp();
  try {
    const conversation = await conversationIdOf(fixture);
    const create = tools().get("create_appointment");
    assert.ok(create);
    const result = await create.execute(
      { ...FIELDS, title: "" } as never,
      toolApi(fixture, conversation),
      context,
    );
    assert.equal(result.isError, true);
    assert.equal(resultText(result), APPOINTMENT_RULE);
    const snapshot = await fixture.app.app.snapshot(ApprovalsDoc, context);
    assert.deepEqual(parseApprovals(snapshot!)!.approvals, [], "a refused proposal writes nothing");
  } finally {
    await fixture.stop();
  }
});

test("a repeated tool call reuses its task id, so one call is one proposal", async () => {
  const fixture = await startToolsApp();
  try {
    const conversation = await conversationIdOf(fixture);
    const create = tools().get("create_appointment");
    assert.ok(create);
    const api = toolApi(fixture, conversation, "task-7");
    const first = await create.execute({ ...FIELDS }, api, context);
    const second = await create.execute({ ...FIELDS }, api, context);
    assert.match(resultText(first), /^A confirmation is waiting/);
    assert.match(resultText(second), /^Already proposed/);
    assert.equal((await readApprovals(fixture.app.app, context)).length, 1);
  } finally {
    await fixture.stop();
  }
});

test("update_appointment proposes a partial patch and captures the revision it read", async () => {
  const fixture = await startToolsApp();
  try {
    const seeded = await createAppointment(fixture.app.app, context, {
      actor: async () => ({ id: "owner", label: "Alex" }),
      actionId: "http:seed",
      fields: FIELDS,
      now: LATE,
    });
    assert.equal(seeded.kind, "created");
    const appointment = seeded.kind === "created" ? seeded.appointment : undefined;
    assert.ok(appointment);
    const conversation = await conversationIdOf(fixture);

    const update = tools().get("update_appointment");
    assert.ok(update);
    const result = await update.execute(
      { id: appointment.id, timeLocal: "10:30", location: null },
      toolApi(fixture, conversation),
      context,
    );
    assert.match(
      resultText(result),
      /change the appointment "Vet visit" from 2026-12-20 at 09:00 to "Vet visit" on 2026-12-20 at 10:30/,
    );
    const approval = (await readApprovals(fixture.app.app, context))[0]!;
    assert.deepEqual(approval.action, {
      kind: "appointment.update",
      appointmentId: appointment.id,
      rev: 0,
      // The patch is merged onto the committed record: the cleared location is
      // gone and the reminder offsets are the ones the proposal was shown, so
      // the confirm cannot pick up a setting that changed in between.
      fields: {
        title: "Vet visit",
        localDate: "2026-12-20",
        timeLocal: "10:30",
        durationMin: 30,
        reminderOffsetsMin: [1440, 60],
      },
    });
    // The appointment itself has not moved.
    assert.equal((await appointments(fixture)).appointments[0]!.timeLocal, "09:00");

    const unknown = await update.execute(
      { id: "not-an-appointment", timeLocal: "10:30" },
      toolApi(fixture, conversation, "task-8"),
      context,
    );
    assert.equal(unknown.isError, true);
    assert.match(resultText(unknown), /not in the calendar/);
  } finally {
    await fixture.stop();
  }
});

test("request_cancel_appointment proposes the cancellation without running it", async () => {
  const fixture = await startToolsApp();
  try {
    const seeded = await createAppointment(fixture.app.app, context, {
      actor: async () => ({ id: "owner", label: "Alex" }),
      actionId: "http:seed",
      fields: FIELDS,
      now: LATE,
    });
    const appointment = seeded.kind === "created" ? seeded.appointment : undefined;
    assert.ok(appointment);
    const conversation = await conversationIdOf(fixture);
    const cancel = tools().get("request_cancel_appointment");
    assert.ok(cancel);
    const result = await cancel.execute({ id: appointment.id }, toolApi(fixture, conversation), context);
    assert.match(resultText(result), /^A confirmation is waiting in the app: cancel the appointment "Vet visit"/);
    assert.equal((await appointments(fixture)).appointments[0]!.status, "scheduled", "nothing was cancelled");
    const approval = (await readApprovals(fixture.app.app, context))[0]!;
    assert.deepEqual(approval.action, { kind: "appointment.cancel", appointmentId: appointment.id, rev: 0 });
  } finally {
    await fixture.stop();
  }
});

test("request_feeding_schedule_change proposes the list and captures the schedule revision", async () => {
  const fixture = await startToolsApp();
  try {
    assert.equal(
      await updateMealSlots(fixture.app.app, context, {
        actor: async () => ({ id: "owner", label: "Alex" }),
        actionId: "http:seed-slots",
        rev: 0,
        slots: [SLOTS[0]!],
        now: LATE,
      }),
      "updated",
    );
    const conversation = await conversationIdOf(fixture);
    const change = tools().get("request_feeding_schedule_change");
    assert.ok(change);
    const result = await change.execute({ slots: SLOTS }, toolApi(fixture, conversation), context);
    assert.match(
      resultText(result),
      /^A confirmation is waiting in the app: change the meal schedule to 2 meals: "Breakfast" at 07:00, "Dinner" at 18:00/,
    );
    const schedule = await readFeeding(fixture.app.app, context);
    assert.equal(schedule.rev, 1, "the schedule did not move");
    assert.equal(schedule.slots.length, 1);
    const approval = (await readApprovals(fixture.app.app, context))[0]!;
    assert.deepEqual(approval.action, { kind: "feeding.schedule", rev: 1, slots: SLOTS });

    // Two slots at the same time is a schedule the document refuses.
    const refused = await change.execute(
      {
        slots: [
          { id: "slot-x", label: "Brunch", timeLocal: "07:00", active: true },
          { id: "slot-y", label: "Second breakfast", timeLocal: "07:00", active: true },
        ],
      } as never,
      toolApi(fixture, conversation, "task-9"),
      context,
    );
    assert.equal(refused.isError, true);
    assert.match(resultText(refused), /no two at the same time/);
  } finally {
    await fixture.stop();
  }
});

// --- §9.2 and the guardrail, through the real thread -------------------------

test("a model tool call proposes but books nothing, attributed to the caregiver who spoke", async () => {
  const fixture = await startTestApp({
    prefix: "pupkeep-approval-thread-",
    now: LATE.getTime(),
    partner: true,
    timezone: "Europe/Paris",
    responses: [
      fauxAssistantMessage([fauxToolCall("create_appointment", FIELDS)], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("I proposed the visit; confirm it in the app."),
    ],
  });
  try {
    const posted = await fetch(`${fixture.url}/api/agent/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        Cookie: `${SESSION_COOKIE}=${fixture.cookies.owner}`,
        Origin: fixture.url,
      },
      body: JSON.stringify({ text: "Book the vet for 20 December at 9", clientMessageId: "m-propose" }),
    });
    assert.equal(posted.status, 202);

    const approval = await until(async () => (await readApprovals(fixture.app.app, context))[0], 8000);
    assert.equal(approval.status, "pending");
    // The actor came from the assistant entry's scan, not from the model's
    // arguments: the tool call names no caregiver at all.
    assert.equal(approval.requestedBy, "owner");
    assert.equal(approval.requestedByLabel, "Alex");
    assert.match(approval.actionId, /^tool:/, "the real task id, not a client key");
    // Gate G4: the agent proposed, and nothing was booked.
    assert.deepEqual((await appointments(fixture)).appointments, []);

    // A caregiver confirms in their own session; only then does the visit exist.
    const confirmed = await fetch(`${fixture.url}/api/approvals/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        "Idempotency-Key": "confirm-thread",
        Cookie: `${SESSION_COOKIE}=${fixture.cookies.partner}`,
        Origin: fixture.url,
      },
      body: JSON.stringify({ id: approval.id, rev: approval.rev }),
    });
    assert.equal(confirmed.status, 200);
    const booked = await appointments(fixture);
    assert.equal(booked.appointments.length, 1);
    assert.equal(booked.appointments[0]!.createdBy, "partner");
  } finally {
    await fixture.stop();
  }
});

test("get_context reports what is already waiting, so the agent does not propose it twice", async () => {
  const fixture = await startToolsApp();
  try {
    const conversation = await conversationIdOf(fixture);
    const getContext = overviewTools().get("get_context");
    assert.ok(getContext);
    const empty = resultText(await getContext.execute({}, toolApi(fixture, conversation, "task-ctx-1"), context));
    assert.match(empty, /^Pending confirmations: none\.$/m);

    const create = tools().get("create_appointment");
    assert.ok(create);
    await create.execute({ ...FIELDS }, toolApi(fixture, conversation, "task-ctx-2"), context);
    const waiting = resultText(await getContext.execute({}, toolApi(fixture, conversation, "task-ctx-3"), context));
    assert.match(waiting, /^Pending confirmations: 1\. "add the appointment .*"/m);
    assert.match(waiting, /Do not propose the same change again/);
  } finally {
    await fixture.stop();
  }
});
