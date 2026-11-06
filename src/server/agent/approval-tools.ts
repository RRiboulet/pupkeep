// The approvals extension: the agent's only way to change an appointment or the
// meal schedule (PLAN §9.3, §10.2, §10.3, §16 P4-07).
//
// Every tool here **proposes**. None of them writes a care document: each one
// commits an `app.approvals` record and answers "a confirmation is waiting in
// the app", and the caregiver's tap on `POST /api/approvals/confirm` runs the
// stored action in one commit (§9.3). That is the guardrail P4-02 carried here:
// the model can propose, never execute, and the confirmation is a human session.
//
// Three rules the tools inherit from §10.3:
//   * thin wrappers over the domain proposes (`proposeApproval` +
//     `appointmentCreateAction`/…), which build the stored action from the
//     proposing commit's own reads — the model never passes a revision, so a
//     confirmation can never be checked against a value it invented;
//   * `replay: "safe"` on every tool: the propose is idempotent on `api.taskId`,
//     so a rerun after a restart returns the recorded proposal instead of
//     proposing twice;
//   * the actor is the caregiver who spoke (§9.2), resolved inside the commit
//     with the task memo as the crash-rerun short cut — never the model's
//     arguments.
//
// Free text the caregiver wrote (a title, a place, a note) is JSON-quoted inside
// the app-built summary, so a crafted title stays visibly data.

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  APPOINTMENT_DURATION_MAX,
  APPOINTMENT_DURATION_MIN,
  APPOINTMENT_LOCATION_LIMIT,
  APPOINTMENT_NOTES_LIMIT,
  APPOINTMENT_RULE,
  APPOINTMENT_TITLE_LIMIT,
  APPOINTMENT_VET_LIMIT,
  REMINDER_OFFSET_MAX_MIN,
  REMINDER_OFFSETS_MAX,
  parseAppointmentFields,
} from "../../shared/calendar.ts";
import { MEAL_SCHEDULE_RULE, parseMealSlots } from "../../shared/feeding.ts";
import type { DocStore } from "../domain/docs.ts";
import { DomainConflictError, UnavailableError } from "../domain/errors.ts";
import {
  appointmentCancelAction,
  appointmentCreateAction,
  appointmentUpdateAction,
  feedingScheduleAction,
  proposeApproval,
  type ProposedAction,
  type ProposeOutcome,
} from "../domain/approvals.ts";
import type { JsonObject, Tx } from "@earendil-works/pi-durable";
import type { Household } from "../../shared/domain.ts";
import { refused, speakerSeam, text } from "./tool-kit.ts";

/** The one sentence every proposing tool answers with when nothing was written. */
function waitingText(outcome: ProposeOutcome): string {
  if (outcome.kind === "key-conflict") {
    return "This call reused an idempotency key for a different proposal; nothing was proposed.";
  }
  const lead = outcome.kind === "replayed" ? "Already proposed" : "A confirmation is waiting in the app";
  return (
    `${lead}: ${outcome.approval.summary}. ` +
    `Nothing has changed yet — a caregiver has to confirm it (proposal id ${outcome.approval.id}), ` +
    `and it expires ${outcome.approval.expiresAt}.`
  );
}

/** A `YYYY-MM-DD` on the household's calendar, as the tools ask for it. */
const LOCAL_DATE = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
/** An `HH:MM` wall-clock time on the household's clock (`00:00`–`23:59`). */
const LOCAL_TIME = Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" });

/** The reminder offsets a caller may name; the parser applies P4-01's rule. */
const OFFSETS = Type.Array(Type.Integer({ minimum: 0, maximum: REMINDER_OFFSET_MAX_MIN }), {
  maxItems: REMINDER_OFFSETS_MAX,
  description: "Minutes before the appointment to remind, e.g. [1440, 60]. [] means no reminders.",
});

/** The optional appointment fields a create carries. */
const APPOINTMENT_PROPS = {
  title: Type.String({ minLength: 1, maxLength: APPOINTMENT_TITLE_LIMIT }),
  localDate: LOCAL_DATE,
  timeLocal: LOCAL_TIME,
  durationMin: Type.Integer({ minimum: APPOINTMENT_DURATION_MIN, maximum: APPOINTMENT_DURATION_MAX }),
  location: Type.Optional(Type.String({ maxLength: APPOINTMENT_LOCATION_LIMIT })),
  vetName: Type.Optional(Type.String({ maxLength: APPOINTMENT_VET_LIMIT })),
  notes: Type.Optional(Type.String({ maxLength: APPOINTMENT_NOTES_LIMIT })),
  reminderOffsetsMin: Type.Optional(OFFSETS),
} as const;

/** Clearable text: `null` removes the value, as the profile tool spells it. */
function clearable(limit: number) {
  return Type.Optional(
    Type.Union([Type.String({ maxLength: limit }), Type.Null()], {
      description: "The new text, or null to clear it.",
    }),
  );
}

async function propose(
  api: ToolExecutionApi,
  context: Context,
  input: {
    readonly request: JsonObject;
    readonly intent: (tx: Tx, household: Household) => Promise<ProposedAction>;
  },
): Promise<ReturnType<typeof text> | ReturnType<typeof refused>> {
  const speaker = await speakerSeam(api, context);
  const store: DocStore = api;
  const outcome = await proposeApproval(store, context, {
    actor: speaker.actor,
    // The task id is the durable identity of this call: one call, one proposal.
    // Namespaced so an HTTP client cannot plant an approval under a task id.
    actionId: `tool:${api.taskId}`,
    request: input.request,
    intent: input.intent,
    now: new Date(api.now()),
  });
  // After the domain commit, never inside it (§9.2).
  await speaker.remember();
  if (outcome.kind === "key-conflict") return refused(waitingText(outcome));
  return text(waitingText(outcome));
}

/** The proposals, as one extension so a conversation selects them together. */
export function createApprovalTools(): Extension<ToolRegistration> {
  const createAppointment = defineTool({
    name: "create_appointment",
    description:
      "Propose a new appointment. This only creates a confirmation request: nothing is booked until a caregiver " +
      "confirms it in the app. Give the household-local date, the HH:MM time and a duration; reminder offsets " +
      "default to the household setting. Report to the caregiver that a confirmation is waiting.",
    parameters: Type.Object(APPOINTMENT_PROPS),
    replay: "safe",
    execute: async (args, api, context) => {
      const fields = parseAppointmentFields(args);
      if (!fields) return refused(APPOINTMENT_RULE);
      try {
        return await propose(api, context, {
          request: { kind: "appointment.create", ...args } as JsonObject,
          intent: async (_tx, household) => appointmentCreateAction(household, fields),
        });
      } catch (error) {
        if (error instanceof DomainConflictError) return refused(error.message);
        // The domain's own sentence names the document that is not ready; a
        // calendar-specific guess would blame the wrong one when it is the
        // approval list that has not been repaired yet.
        if (error instanceof UnavailableError) return refused(error.message);
        throw error;
      }
    },
  });

  const updateAppointment = defineTool({
    name: "update_appointment",
    description:
      "Propose a change to an existing appointment. Read the calendar with list_appointments first and pass the " +
      "appointment's id; send only the fields that change (null clears a text field). This only creates a " +
      "confirmation request: nothing changes until a caregiver confirms it in the app.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: APPOINTMENT_TITLE_LIMIT })),
      localDate: Type.Optional(LOCAL_DATE),
      timeLocal: Type.Optional(LOCAL_TIME),
      durationMin: Type.Optional(
        Type.Integer({ minimum: APPOINTMENT_DURATION_MIN, maximum: APPOINTMENT_DURATION_MAX }),
      ),
      location: clearable(APPOINTMENT_LOCATION_LIMIT),
      vetName: clearable(APPOINTMENT_VET_LIMIT),
      notes: clearable(APPOINTMENT_NOTES_LIMIT),
      reminderOffsetsMin: Type.Optional(OFFSETS),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const { id, ...patch } = args;
      try {
        return await propose(api, context, {
          request: { kind: "appointment.update", ...args } as JsonObject,
          intent: async (tx) => appointmentUpdateAction(tx, id, patch),
        });
      } catch (error) {
        if (error instanceof DomainConflictError) return refused(error.message);
        if (error instanceof UnavailableError) return refused(error.message);
        throw error;
      }
    },
  });

  const requestCancelAppointment = defineTool({
    name: "request_cancel_appointment",
    description:
      "Propose cancelling an appointment. This cancels nothing: a caregiver has to confirm the cancellation in the " +
      "app. Read the calendar with list_appointments first and pass the appointment's id.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    replay: "safe",
    execute: async (args, api, context) => {
      try {
        return await propose(api, context, {
          request: { kind: "appointment.cancel", id: args.id },
          intent: async (tx) => appointmentCancelAction(tx, args.id),
        });
      } catch (error) {
        if (error instanceof DomainConflictError) return refused(error.message);
        if (error instanceof UnavailableError) return refused(error.message);
        throw error;
      }
    },
  });

  const requestFeedingScheduleChange = defineTool({
    name: "request_feeding_schedule_change",
    description:
      "Propose replacing the meal schedule. Send the complete list of slots it should become (id, label, HH:MM " +
      "time, optional portion, active); reuse an existing slot's id to keep its meals attached. This changes " +
      "nothing: a caregiver has to confirm the new schedule in the app.",
    parameters: Type.Object({
      slots: Type.Array(
        Type.Object({
          id: Type.String({ minLength: 1, maxLength: 64 }),
          label: Type.String({ minLength: 1, maxLength: 40 }),
          timeLocal: LOCAL_TIME,
          portion: Type.Optional(Type.String({ maxLength: 80 })),
          active: Type.Boolean(),
        }),
        { minItems: 1, maxItems: 12 },
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const slots = parseMealSlots(args.slots);
      if (!slots) return refused(MEAL_SCHEDULE_RULE);
      try {
        return await propose(api, context, {
          // The slot objects carry optional properties the `JsonObject` index
          // signature does not model; the request hash only needs a stable
          // canonical form, and the action parser is the real fence.
          request: { kind: "feeding.schedule", slots: args.slots } as unknown as JsonObject,
          intent: async (tx) => feedingScheduleAction(tx, slots),
        });
      } catch (error) {
        if (error instanceof DomainConflictError) return refused(error.message);
        if (error instanceof UnavailableError) return refused(error.message);
        throw error;
      }
    },
  });

  return defineExtension({
    name: "approvals",
    tools: [createAppointment, updateAppointment, requestCancelAppointment, requestFeedingScheduleChange],
  });
}
