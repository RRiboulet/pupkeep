// The appointment reminder task (P4-03, PLAN §8.4, §9.1, §10.3, §12.1, §12.2).
//
// A reminder is a durable task, never a timer in the server process: it sleeps
// until the appointment's derived instant minus its offset, survives a restart,
// and on waking decides — deterministically, with no model — whether the
// household still needs to be told. The task never asks for its conversation's
// agent, so the hidden system conversation it is owned by can never spend
// budget (§9.1, §10.3).
//
// The wake check is the guard that makes a replaced task harmless: its input
// carries the appointment's **revision** and the computed `dueAt`. If the record
// was cancelled, completed, edited (a new revision) or the wall clock moved so
// the same offset is no longer the same instant, the old task no-ops instead of
// reminding at the wrong time. The write that replaces it also aborts it
// best-effort (`retireAppointmentReminders`); this check covers the crash
// between that commit and the abort.
//
// What this task deliberately does **not** do is deliver: P4-05 owns the
// notification outbox, Web Push and ntfy, and will bump this task's version to
// write the intents before the terminal commit. Today a due reminder commits its
// decision as the task's terminal result and writes nothing.

import { defineTask } from "@earendil-works/pi-durable";
import type { Appointment, Calendar } from "../../shared/domain.ts";
import { notificationIntent, notificationKey } from "../../shared/notifications.ts";
import { CalendarDoc, HouseholdDoc } from "../domain/docs.ts";
import { instantAtLocalWallClock } from "../domain/time.ts";
import { appendNotificationIntents } from "../notifications/intents.ts";

/** The registered task kind; P4-04's planner is `app.feed.planner`. */
export const APPOINTMENT_REMINDER_TASK = "app.reminder";
/**
 * Version 2 (P4-05) writes the reminder intent in the same terminal commit that
 * decides `due`. A live version-1 task migrates unchanged and runs the new check.
 */
export const APPOINTMENT_REMINDER_VERSION = 2;

/**
 * Longest single sleep (§8.5: reminder sleeps are capped in chunks and re-armed
 * after a clock jump). A reminder armed a week early would otherwise sleep
 * through every restart in one hop.
 */
export const APPOINTMENT_REMINDER_SLEEP_CHUNK_MS = 6 * 60 * 60 * 1000;

/**
 * How late an "at the start" reminder (offset 0) may still fire. The pre-visit
 * offsets are pointless once the visit has started, but offset 0 **is** the
 * visit starting — the calendar form offers it as "At the start" — so without a
 * grace it could never fire at all: the task wakes at the start instant, and any
 * clock reading at or after that would read as "passed". A few minutes keeps a
 * slightly late wake useful and still refuses a phone that boots mid-visit.
 */
export const APPOINTMENT_START_GRACE_MS = 5 * 60 * 1000;

/**
 * The task's input, fixed when the appointment armed it. `rev` is the
 * appointment revision that armed it; `dueAt` is the derived start instant minus
 * `offsetMin` (§12.2).
 */
export type AppointmentReminderInput = {
  appointmentId: string;
  /** The record's revision when armed; a newer one means this arm is stale. */
  rev: number;
  /** Minutes before the appointment this task reminds at. */
  offsetMin: number;
  /** Epoch milliseconds on the harness clock. */
  dueAt: number;
};

export type AppointmentReminderCheckpoint = { phase: "wait" } | { phase: "check" };

/**
 * What the task decided when it woke. `due` is the only outcome that, once
 * delivery exists, writes a notification; the others are skips. The result is
 * committed as the terminal outcome so the decision is inspectable after a
 * restart.
 */
export type AppointmentReminderResult =
  /**
   * Still upcoming and unchanged: the reminder P4 delivers. `title` is the
   * record's title at wake time, so a rename between arming and waking cannot
   * put a stale name in the in-app copy.
   */
  | {
      kind: "due";
      appointmentId: string;
      title: string;
      localDate: string;
      timeLocal: string;
      /** The derived start instant, epoch ms; the copy counts down to it. */
      startsAt: number;
      offsetMin: number;
      dueAt: number;
    }
  /** The visit has already started: a late wake must not announce it. */
  | { kind: "passed"; appointmentId: string; startsAt: number }
  /** The record was edited (revision, time or offset changed): this arm is stale. */
  | { kind: "rescheduled"; appointmentId: string }
  | { kind: "cancelled"; appointmentId: string }
  | { kind: "completed"; appointmentId: string }
  /** The calendar document or the record is absent (a partial restore). */
  | { kind: "missing"; appointmentId: string };

/**
 * The derived start instant of a stored appointment, in its own zone (§8.4).
 * The one wall-clock conversion for the reminder path: the arming rule and the
 * waking rule must compute the same instant, or every task would look stale.
 */
export function appointmentStartMs(
  appointment: Pick<Appointment, "localDate" | "timeLocal" | "timezone">,
): number {
  return instantAtLocalWallClock(appointment.localDate, appointment.timeLocal, appointment.timezone).getTime();
}

/**
 * The pure decision the waking task makes, shared with the tests and with
 * anything else that needs to know whether a reminder is still true.
 *
 * Order matters: a missing record or a changed revision is "stale" before any
 * time question, and a cancelled/completed visit is skipped however late the
 * wake is.
 */
export function appointmentReminderDecision(
  calendar: Pick<Calendar, "appointments">,
  input: AppointmentReminderInput,
  nowMs: number,
): AppointmentReminderResult {
  const appointment = calendar.appointments.find((entry) => entry.id === input.appointmentId);
  if (appointment === undefined) return { kind: "missing", appointmentId: input.appointmentId };
  if (appointment.status === "cancelled") return { kind: "cancelled", appointmentId: input.appointmentId };
  if (appointment.status === "completed") return { kind: "completed", appointmentId: input.appointmentId };
  if (appointment.rev !== input.rev) return { kind: "rescheduled", appointmentId: input.appointmentId };

  // The record must still list this arm: a hand-edited restore can keep its
  // `rev` while dropping the ref, and a task its record no longer names is not
  // the household's reminder. This is also what makes the refs load-bearing —
  // a write that replaced them without bumping `rev` (it cannot) would be caught.
  const armed = appointment.reminders.some(
    (ref) => ref.offsetMin === input.offsetMin && ref.dueAt === input.dueAt,
  );
  if (!armed) return { kind: "rescheduled", appointmentId: input.appointmentId };

  const startsAt = appointmentStartMs(appointment);
  // Backstop for a document edited outside the service (a hand-edited restore
  // keeps its `rev`); every ordinary edit bumps `rev` and is caught above.
  const dueAt = startsAt - input.offsetMin * 60_000;
  if (dueAt !== input.dueAt) return { kind: "rescheduled", appointmentId: input.appointmentId };
  // A pre-visit reminder is pointless once the visit is under way — a phone that
  // was off does not announce a visit that already started. The at-the-start
  // offset is the exception: its own instant *is* the start, so it fires within
  // a short grace rather than being born expired.
  // `dueAt === startsAt` is exactly the offset-0 arm; everything else has its
  // own earlier instant and expires the moment the visit begins.
  const passed =
    input.dueAt === startsAt ? nowMs > startsAt + APPOINTMENT_START_GRACE_MS : nowMs >= startsAt;
  if (passed) return { kind: "passed", appointmentId: input.appointmentId, startsAt };

  return {
    kind: "due",
    appointmentId: input.appointmentId,
    title: appointment.title,
    localDate: appointment.localDate,
    timeLocal: appointment.timeLocal,
    startsAt,
    offsetMin: input.offsetMin,
    dueAt: input.dueAt,
  };
}

/**
 * `wait` parks the task on the harness clock (in chunks), `check` re-reads the
 * committed calendar and decides. The split is not cosmetic: a phase that sleeps
 * must end there, because a phase reruns from its top after a crash and work
 * after a sleep would otherwise run twice.
 *
 * The check reads through `runtime.snapshot()`, never `tx.doc()`: acquiring a
 * missing document inside the commit would **create** an empty calendar, which a
 * partial restore must not gain from a stray reminder. A missing document is a
 * stale arm like any other.
 */
export const AppointmentReminder = defineTask<
  AppointmentReminderInput,
  AppointmentReminderCheckpoint,
  AppointmentReminderResult
>({
  name: APPOINTMENT_REMINDER_TASK,
  version: APPOINTMENT_REMINDER_VERSION,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      const now = runtime.now();
      if (now >= task.input.dueAt) {
        // Armed for an instant that has just arrived: no sleep, straight to the
        // decision. (The arming rule skips offsets already in the past.)
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "check" } }), context);
        return;
      }
      await runtime.sleepUntil(
        Math.min(task.input.dueAt, now + APPOINTMENT_REMINDER_SLEEP_CHUNK_MS),
        { phase: "wait" },
        context,
      );
    },
    check: async (task, runtime, context) => {
      // The snapshot only decides whether the documents exist; the terminal
      // commit re-reads the calendar so a reschedule or cancel that landed in
      // between is seen before the intent is written (the P4-03 note).
      const existing = await runtime.snapshot(CalendarDoc, context);
      if (existing === undefined) {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: { kind: "missing", appointmentId: task.input.appointmentId },
            },
          }),
          context,
        );
        return;
      }

      const now = new Date(runtime.now());
      await runtime.commit(async (tx) => {
        const household = await tx.doc(HouseholdDoc);
        const calendar = await tx.doc(CalendarDoc);
        const result = appointmentReminderDecision(calendar, task.input, now.getTime());
        if (result.kind === "due") {
          // Both caregivers are reminded; the push body is the category title,
          // the in-app body names the visit and its offset.
          const relative =
            result.offsetMin === 0
              ? "starting now"
              : `${result.offsetMin} minute${result.offsetMin === 1 ? "" : "s"} before`;
          const intents = household.members.map((member) =>
            notificationIntent({
              dedupeKey: notificationKey(
                "appointment",
                result.appointmentId,
                String(result.offsetMin),
                String(result.startsAt),
                member.id,
              ),
              category: "appointment",
              userId: member.id,
              body: `"${result.title}" at ${result.timeLocal} (${relative}, ${household.timezone}).`,
              now,
            }),
          );
          await appendNotificationIntents(tx, intents, now);
        }
        return { status: "terminal", outcome: { status: "completed", result } };
      }, context);
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  // Version 2 only widened the check; the stored input and checkpoint are the
  // same shape, so a live version-1 task is taken over as-is.
  migrate: (input, checkpoint) => ({
    input: input as AppointmentReminderInput,
    checkpoint: checkpoint as AppointmentReminderCheckpoint,
  }),
});
