// The calendar's agent-facing text (PLAN §10.1, §16 P4-02).
//
// The model receives state, not advice: a range's appointments with their
// derived instants and the next upcoming one. Every caregiver-provided string
// (title, place, vet, notes) is JSON-quoted, so a title that reads like an
// instruction stays visibly data in the model's context (§9.5) — the same rule
// the feeding, training and shower tools follow.
//
// The dates and times here are the record's stored household wall clock, never
// re-derived from an instant: a 09:00 visit stays 09:00 in the text across a DST
// change. A zone snapshot that differs from the household's current zone is
// named, because that is the one case where the wall clock is not the household
// clock the reader expects.

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
  const starts = new Date(appointment.startsAt);
  const startsIn = localTimeAt(starts, appointment.timezone);
  const endsIn = localTimeAt(new Date(starts.getTime() + appointment.durationMin * 60_000), appointment.timezone);
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
  const scheduled = view.appointments.filter((appointment) => appointment.status === "scheduled").length;
  const cancelled = view.appointments.length - scheduled;
  const counts =
    view.appointments.length === 0
      ? "none"
      : `${scheduled} scheduled${cancelled === 0 ? "" : `, ${cancelled} cancelled`}`;
  const header = `Appointments ${view.from} to ${view.to} (${view.timezone}), today ${view.today}: ${counts}.`;
  const lines = view.appointments.map((appointment) => appointmentText(appointment, view.timezone));
  const next =
    view.next === null
      ? "Next: none scheduled."
      : `Next: ${view.next.localDate} ${view.next.timeLocal} ${q(view.next.title)}.`;
  return [header, ...(lines.length === 0 ? [] : ["", ...lines]), "", next].join("\n");
}

/**
 * The `get_context` line: the next scheduled appointment with a household-local
 * countdown. "in N days" is a date question (`daysBetween`), which has no DST;
 * the clock time is the stored wall clock.
 */
export function nextAppointmentText(view: CalendarView): string {
  if (view.next === null) return "Next appointment: none scheduled.";
  const days = daysBetween(view.today, view.next.localDate);
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return `Next appointment: ${view.next.localDate} ${view.next.timeLocal} ${q(view.next.title)} (${when}, ${view.timezone}).`;
}
