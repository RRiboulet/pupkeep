// Arming and retiring the appointment reminders (P4-03, PLAN §8.4, §10.3,
// §12.2).
//
// The write that creates or edits an appointment is also the write that arms its
// reminders, in the same commit: a caregiver who saves a visit either has both or
// neither. Two rules make that safe:
//
//   * a reminder's due instant is the appointment's **derived** start minus its
//     offset. The instant is never stored on the appointment; it is computed
//     here, in the record's own zone, exactly as every read does (§8.4);
//   * an offset whose instant has already passed is not armed at all, so a
//     caregiver booking at noon with a one-day reminder gets the remaining
//     reminders rather than a burst of missed ones.
//
// Replacing a reminder is two steps: the commit arms the new tasks and writes
// their refs on the record; then the caller retires the old task ids with
// `retireAppointmentReminders`. That second step is best-effort by design — the
// old tasks carry the record's previous revision and no-op when they wake
// (`appointmentReminderDecision`), so a crash between the commit and the abort
// costs nothing but a task that wakes to change its mind.
//
// No task is ever created from a tool call (`api.createTask`): tools never touch
// the reminder table. The only creator is this domain function, called inside a
// commit by the HTTP writer (and, later, by an approved tool execution), which
// passes the hidden system conversation as the owner and `background: true`.

import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";
import type { Appointment, AppointmentReminderRef, Household } from "../../shared/domain.ts";
import { UnavailableError } from "../domain/errors.ts";
import {
  AppointmentReminder,
  appointmentStartMs,
  type AppointmentReminderInput,
} from "./appointment-reminder.ts";

/**
 * The reminders a write wants, pure so the arming rule and the tests agree: one
 * per offset whose instant is still ahead, and none once the visit has started.
 * The order is the stored offset order, so the refs read in the same order as
 * the reminder settings.
 */
export function planAppointmentReminders(
  appointment: Pick<Appointment, "id" | "rev" | "localDate" | "timeLocal" | "timezone" | "reminderOffsetsMin">,
  now: Date,
): AppointmentReminderInput[] {
  const startsAt = appointmentStartMs(appointment);
  const nowMs = now.getTime();
  if (startsAt <= nowMs) return [];
  const plan: AppointmentReminderInput[] = [];
  for (const offsetMin of appointment.reminderOffsetsMin) {
    const dueAt = startsAt - offsetMin * 60_000;
    // An offset already past is skipped, never fired late (§12.2/§10.4).
    if (dueAt <= nowMs) continue;
    plan.push({ appointmentId: appointment.id, rev: appointment.rev, offsetMin, dueAt });
  }
  return plan;
}

/**
 * Arm the appointment's reminders inside the write's commit, on the hidden
 * system conversation. Returns the refs to persist on the record; the caller
 * assigns them before the record's backstop parse.
 *
 * The household draft is passed in rather than read here: acquiring it with
 * `tx.doc()` would create a missing household (an empty one with no
 * conversations, which boot refuses), and the caller already holds it.
 */
export async function armAppointmentReminders(
  tx: Tx,
  household: Household,
  appointment: Appointment,
  now: Date,
): Promise<AppointmentReminderRef[]> {
  // A household without its hidden thread has not booted; creating a task now
  // would either fail or attach it to nothing. Refuse rather than half-arm.
  if (household.systemConversationId <= 0) {
    throw new UnavailableError("the household is not ready for reminders yet; retry after boot");
  }

  const refs: AppointmentReminderRef[] = [];
  for (const input of planAppointmentReminders(appointment, now)) {
    // One type for the plan item and the task's input, so the arming rule and
    // the waking rule cannot drift apart.
    const taskId = await tx.createTask(AppointmentReminder, input, {
      ownership: { kind: "conversation" },
      conversationId: household.systemConversationId as ConversationId,
      background: true,
    });
    refs.push({ taskId: Number(taskId), offsetMin: input.offsetMin, dueAt: input.dueAt });
  }
  return refs;
}

/**
 * Retire the reminders an update or a cancel replaced. `Harness.abortTask()`
 * commits the abort mark and runs the task's abort handler, so the task becomes
 * terminal instead of sleeping until a stale due instant.
 *
 * Failures are returned, not swallowed: the caller logs them. The reminder is
 * already harmless without the abort — its revision check makes it a no-op — so
 * one failed abort must not fail the care write that already committed.
 */
export async function retireAppointmentReminders(
  harness: Pick<Harness, "abortTask">,
  taskIds: readonly number[],
  context: Parameters<Harness["abortTask"]>[1],
): Promise<number[]> {
  const failed: number[] = [];
  for (const taskId of taskIds) {
    try {
      await harness.abortTask(taskId as Parameters<Harness["abortTask"]>[0], context);
    } catch {
      failed.push(taskId);
    }
  }
  return failed;
}
