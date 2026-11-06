// The Calendar screen's pure half (PLAN §13.1, §13.2, §16 P4-02).
//
// This module holds what a Node test can pin without a browser: the month grid's
// geometry, the request bodies, the reminder-offset labels, the appointment's
// one-line time, and the countdown copy for Today. The view in
// `views/calendar.js` turns these into elements.
//
// Two rules from the plan shape it:
//   * **dates are household-local strings.** An appointment carries `localDate`
//     and `timeLocal`, computed and validated by the server; the grid does
//     arithmetic on those strings (via UTC midnights, which have no DST), and
//     never derives a date from a stored instant or the device's zone (§8.4);
//   * **the derived instants are for ordering and for the API**, not for
//     display: a 09:00 visit reads 09:00 even after a DST change.
//
// It imports no Preact and touches no DOM, like `meals.js`, `walk.js` and
// `growth-chart.js`. `clock.js` supplies the shell's one date formatter.

import { dateText } from "./clock.js";

/** The reminder offsets the form offers even when nothing uses them yet. */
export const PRESET_OFFSETS = [1440, 60, 0];
/** The document's duration bounds, mirrored here for the input. */
export const DURATION_MIN = 5;
export const DURATION_MAX = 720;
/** A day's chips: the grid shows the first few, the agenda shows the rest. */
export const DAY_CHIP_LIMIT = 3;

const DAY_MS = 86_400_000;

function utcOf(localDate) {
  const raw = String(localDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const at = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== raw ? null : at;
}

/** `date` plus `days`, as a local date string. Calendar arithmetic, no zone. */
export function addDays(date, days) {
  const at = utcOf(date);
  if (at === null) return String(date ?? "");
  return new Date(at.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from one local date to another; negative when `to` is earlier. */
export function daysBetween(from, to) {
  const a = utcOf(from);
  const b = utcOf(to);
  if (a === null || b === null) return 0;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** The `{ year, month }` a local date belongs to; month is 1–12. */
export function monthOf(localDate) {
  const at = utcOf(localDate) ?? new Date();
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1 };
}

/** `2026-11` for this month, and back; the cursor the screen moves by one. */
export function monthKey({ year, month }) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function parseMonthKey(key) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(key ?? ""));
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year, month } : null;
}

export function shiftMonth({ year, month }, delta) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12 + 12) % 12 + 1 };
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** "November 2026" — a calendar label, not an instant. */
export function monthLabel({ year, month }) {
  return MONTH_FORMAT.format(new Date(Date.UTC(year, month - 1, 1)));
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The month's grid, Monday first: weeks of `{ date, inMonth, isToday }` days,
 * including the leading/trailing days the rows need so the month starts on the
 * right weekday. The arithmetic is on UTC midnights of local date strings, so a
 * DST change cannot add or lose a day.
 */
export function monthGrid(today, { year, month }) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = (first.getUTCDay() + 6) % 7;
  const start = addDays(first.toISOString().slice(0, 10), -firstWeekday);
  const days = [];
  // Six weeks always, so the grid's height does not jump between months.
  for (let index = 0; index < 42; index += 1) {
    const date = addDays(start, index);
    const parsed = utcOf(date);
    days.push({
      date,
      inMonth: parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month,
      isToday: date === today,
    });
  }
  const weeks = [];
  for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7));
  return { year, month, label: monthLabel({ year, month }), weekdays: WEEKDAYS, weeks };
}

/** The inclusive range the grid covers: its first and last visible days. */
export function monthWindow({ year, month }) {
  const first = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  const start = addDays(first, -((new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7));
  return { from: start, to: addDays(start, 41) };
}

/** The appointments grouped by their stored local date, in the server's order. */
export function appointmentsByDate(appointments) {
  const byDate = new Map();
  for (const appointment of appointments ?? []) {
    const list = byDate.get(appointment.localDate) ?? [];
    list.push(appointment);
    byDate.set(appointment.localDate, list);
  }
  return byDate;
}

export function statusLabel(status) {
  if (status === "cancelled") return "Cancelled";
  if (status === "completed") return "Completed";
  return "Scheduled";
}

/** "30 min", "1 h", "1 h 30 min" — a duration, never an instant. */
export function durationText(minutes) {
  const whole = Math.round(Number(minutes));
  if (!Number.isFinite(whole) || whole <= 0) return "";
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "09:00–09:30": the stored wall clock plus the stored duration. */
export function timeRangeText(appointment) {
  const start = String(appointment?.timeLocal ?? "");
  if (!/^\d{2}:\d{2}$/.test(start)) return "";
  const [hour, minute] = start.split(":").map(Number);
  const end = hour * 60 + minute + Math.round(Number(appointment?.durationMin));
  const endHour = String(Math.floor(end / 60) % 24).padStart(2, "0");
  const endMinute = String(end % 60).padStart(2, "0");
  return `${start}–${endHour}:${endMinute}`;
}

/** The reminder offset's copy; the same shape the agent's text uses. */
export function offsetText(minutes) {
  const value = Math.round(Number(minutes));
  if (value === 0) return "At the start";
  if (value % 1440 === 0) {
    const days = value / 1440;
    return `${days} day${days === 1 ? "" : "s"} before`;
  }
  if (value % 60 === 0) {
    const hours = value / 60;
    return `${hours} hour${hours === 1 ? "" : "s"} before`;
  }
  return `${value} minute${value === 1 ? "" : "s"} before`;
}

/**
 * The checkboxes the form offers: the presets plus any offset the record (or
 * the household default) already carries, so an edit never silently drops a
 * value the UI did not know about. Newest-widest first.
 */
export function offsetOptions(selected = [], defaults = []) {
  const values = [...new Set([...(selected ?? []), ...(defaults ?? []), ...PRESET_OFFSETS])]
    .map((value) => Math.round(Number(value)))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => b - a);
  return values.map((minutes) => ({
    minutes,
    label: offsetText(minutes),
    checked: (selected ?? []).includes(minutes),
  }));
}

/** A blank create draft for one day, starting from the household's defaults. */
export function blankDraft(localDate, defaults = []) {
  return {
    mode: "create",
    id: null,
    rev: null,
    title: "",
    localDate: String(localDate ?? ""),
    timeLocal: "09:00",
    durationMin: 30,
    location: "",
    vetName: "",
    notes: "",
    offsets: [...(defaults ?? [])],
  };
}

/** The edit draft for a committed appointment (a copy; the view keeps it). */
export function draftFrom(appointment) {
  return {
    mode: "edit",
    id: appointment.id,
    rev: appointment.rev,
    title: appointment.title,
    localDate: appointment.localDate,
    timeLocal: appointment.timeLocal,
    durationMin: appointment.durationMin,
    location: appointment.location ?? "",
    vetName: appointment.vetName ?? "",
    notes: appointment.notes ?? "",
    offsets: [...appointment.reminderOffsetsMin],
  };
}

/**
 * The request body. Text is trimmed once so a retried save with padded text
 * replays under the same key; empty optional text is absent, and the offset list
 * is always explicit (`[]` means no reminders, never "unset").
 */
export function appointmentBody(draft) {
  const body = {
    title: String(draft?.title ?? "").trim(),
    localDate: draft?.localDate,
    timeLocal: draft?.timeLocal,
    durationMin: Math.round(Number(draft?.durationMin)),
    reminderOffsetsMin: [...new Set((draft?.offsets ?? []).map((value) => Math.round(Number(value))))].sort(
      (a, b) => b - a,
    ),
  };
  for (const field of ["location", "vetName", "notes"]) {
    const text = String(draft?.[field] ?? "").trim();
    if (text !== "") body[field] = text;
  }
  return body;
}

/** The one-line chip under a day: time and title, status marked when not live. */
export function chipText(appointment) {
  const suffix = appointment.status === "scheduled" ? "" : ` (${statusLabel(appointment.status).toLowerCase()})`;
  return `${appointment.timeLocal} ${appointment.title}${suffix}`;
}

/**
 * Today's countdown line. The dates come from the server's `today` and the
 * appointment's stored local date, so this is a date question with no DST and no
 * device clock. `next` may be null.
 */
export function nextAppointmentText(view) {
  const next = view?.next;
  if (!next) return { headline: "No appointment scheduled.", detail: "" };
  const days = daysBetween(view.today, next.localDate);
  const when =
    days === 0 ? "Today" : days === 1 ? "Tomorrow" : days > 1 ? `In ${days} days` : dateText(next.localDate);
  const time = `${next.timeLocal}`;
  const detail = [time, next.location].filter((part) => part !== undefined && part !== "").join(" · ");
  return { headline: `${when} · ${next.title}`, detail };
}

/** The zone note under the grid; only the household zone is shown. */
export function zoneNote(timezone) {
  return `Times are in ${timezone}.`;
}
