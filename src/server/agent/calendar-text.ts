// The calendar's agent-facing text (PLAN §10.1, §16 P4-02).
//
// The model receives state, not advice: a range's appointments with their
// derived instants and the next upcoming one. Every caregiver-provided string
// (title, place, vet, notes) is JSON-quoted, so a title that reads like an
// instruction stays visibly data in the model's context (§9.5) — the same rule
// the feeding, training and shower tools follow.
//
// The times are rendered from the record's derived instants in its own zone: on
// an ordinary day that is the stored wall clock (a 09:00 visit stays 09:00), and
// on a DST transition the shifted instant is when the visit actually happens.
// The stored wall clock is the form's editable value, not the timeline's. A zone
// snapshot that differs from the household's current zone is named, because that
// is the one case where the time is not on the household clock the reader
// expects.

import { daysBetween } from "../../shared/dates.ts";
import type { AppointmentView, CalendarView } from "../domain/calendar.ts";
import { localTimeAt } from "../domain/time.ts";

function q(value: string): string {
  return JSON.stringify(value);
}

/** "at the start", "1 hour before", "2 days before" — the offset list's copy. */
export function offsetText(minutes: number): string {
  if (minutes === 0) return "at the start";
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"} before`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"} before`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"} before`;
}

/** The offset list in the caller's order; empty is explicitly "no reminders". */
export function remindersText(offsets: readonly number[]): string {
  if (offsets.length === 0) return "no reminders";
  return `reminders ${offsets.map(offsetText).join(", ")}`;
}

/**
 * One appointment on one line: when, what, where and its reminder state. The
 * end time is the stored duration applied to the derived start, rendered in the
 * appointment's own zone, so both halves are the same clock.
 */
export function appointmentText(appointment: AppointmentView, householdTimezone: string): string {
  const startsIn = localTimeAt(new Date(appointment.startsAt), appointment.timezone);
  // The committed end instant, not a second duration sum.
  const endsIn = localTimeAt(new Date(appointment.endsAt), appointment.timezone);
  const parts = [`${appointment.localDate} ${startsIn}-${endsIn} ${q(appointment.title)}`];
  if (appointment.timezone !== householdTimezone) parts.push(`in ${appointment.timezone}`);
  parts.push(appointment.status === "scheduled" ? "scheduled" : appointment.status);
  if (appointment.location !== undefined) parts.push(`at ${q(appointment.location)}`);
  if (appointment.vetName !== undefined) parts.push(`vet ${q(appointment.vetName)}`);
  if (appointment.notes !== undefined) parts.push(`note ${q(appointment.notes)}`);
  parts.push(remindersText(appointment.reminderOffsetsMin));
  return parts.join("; ");
}

/** The whole ranged answer `list_appointments` returns. */
export function calendarReportText(view: CalendarView): string {
  // Count by status, not "total minus scheduled": a completed visit is not a
  // cancellation (the parser accepts the status for a future writer).
  const counts = { scheduled: 0, cancelled: 0, completed: 0 };
  for (const appointment of view.appointments) counts[appointment.status] += 1;
  const summary =
    view.appointments.length === 0
      ? "none"
      : [
          `${counts.scheduled} scheduled`,
          ...(counts.cancelled === 0 ? [] : [`${counts.cancelled} cancelled`]),
          ...(counts.completed === 0 ? [] : [`${counts.completed} completed`]),
        ].join(", ");
  const header = `Appointments ${view.from} to ${view.to} (${view.timezone}), today ${view.today}: ${summary}.`;
  const lines = view.appointments.map((appointment) => appointmentText(appointment, view.timezone));
  // The next line's time belongs to the appointment's own zone; name it when the
  // household has moved since it was booked.
  const next =
    view.next === null
      ? "Next: none scheduled."
      : `Next: ${view.next.localDate} ${view.next.timeLocal} ${q(view.next.title)}${
          view.next.timezone === view.timezone ? "" : ` (${view.next.timezone})`
        }.`;
  return [header, ...(lines.length === 0 ? [] : ["", ...lines]), "", next].join("\n");
}

/**
 * The `get_context` line: the next scheduled appointment with a household-local
 * countdown. "in N days" is a date question (`daysBetween`), which has no DST;
 * the clock time is the stored wall clock.
 */
export function nextAppointmentText(view: CalendarView): string {
  if (view.next === null) return "Next appointment: none scheduled.";
  // The countdown is a date question, but a household that moved east of the
  // booked zone can have a stored local date before today while the instant is
  // still upcoming: say "upcoming", never a negative number of days. The time is
  // the appointment's wall clock, so its own zone is the one named.
  const days = daysBetween(view.today, view.next.localDate);
  const when = days < 0 ? "upcoming" : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return `Next appointment: ${view.next.localDate} ${view.next.timeLocal} ${q(view.next.title)} (${when}, ${view.next.timezone}).`;
}
