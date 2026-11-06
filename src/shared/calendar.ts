// `app.calendar` and its invariants (PLAN §8.1, §8.3, §8.4, §16 P4-01).
//
// An appointment is a **wall-clock promise**: "09:00 on 20 November at the
// vet". The shape therefore stores the local date and `HH:MM` time plus the
// household zone at the last write, and the UTC instant is derived on read
// (`appointmentInstant` in `server/domain/calendar.ts`). Storing only an instant
// would make a DST change move the visit by an hour, which is exactly the bug
// §8.4 warns about; storing only a wall clock would make a reminder impossible.
//
// What this module fixes:
//   * one line of text for the title, location and vet, and a bounded note;
//   * the zone snapshot is a real IANA zone (the same validator the household
//     document uses), because a broken zone cannot derive an instant;
//   * durations are whole minutes in a plausible range, and reminder offsets are
//     distinct non-negative whole minutes up to 30 days (the plan's default is
//     `[1440, 60]`, so the order is the caller's, not ascending);
//   * `reminders` is the persisted list of armed tasks (P4-03): each one a task
//     id, its offset and the derived instant it sleeps on, so an update or a
//     cancel can retire exactly the tasks it replaces;
//   * the §9.2 pairing holds: no member id always travels with the household
//     label;
//   * ids are unique in the document — a repeated id would make "which
//     appointment is this?" ambiguous. `actionId` is deliberately **not** a
//     document rule: the command key is 24 h-scoped in `app.commands` (§7.3),
//     so a reused key must not make the calendar unreadable.
//
// The lifecycle is a state change, not a delete: a cancelled appointment stays
// in the list. A stale `rev` is answered by the service, not here.

import type { Appointment, AppointmentReminderRef, AppointmentStatus, Calendar } from "./domain.ts";
import { OPAQUE_ID_PATTERN, isIsoInstant } from "./domain.ts";
import { HOUSEHOLD_FALLBACK_LABEL } from "./chat.ts";
import { hasControlCharacter, isIanaZone, isLocalDate } from "./profile.ts";
import { isLocalTime } from "./feeding.ts";
import { dateMinusDays, daysBetween } from "./dates.ts";

/** The opaque-id bound; action ids mirror `COMMAND_KEY_LIMIT`. */
export const APPOINTMENT_ID_LIMIT = 64;
export const APPOINTMENT_ACTION_ID_LIMIT = 120;
/** One line of title and place; a note may be longer, still one line. */
export const APPOINTMENT_TITLE_LIMIT = 120;
export const APPOINTMENT_LOCATION_LIMIT = 120;
export const APPOINTMENT_VET_LIMIT = 80;
export const APPOINTMENT_NOTES_LIMIT = 500;
/** A vet visit shorter than five minutes is a typo; twelve hours is the ceiling. */
export const APPOINTMENT_DURATION_MIN = 5;
export const APPOINTMENT_DURATION_MAX = 720;
/** The time before an appointment a reminder may fire, up to 30 days. */
export const REMINDER_OFFSETS_MAX = 8;
export const REMINDER_OFFSET_MAX_MIN = 30 * 24 * 60;
/** The widest one request may ask for: a year and a week, enough for a month grid's neighbours. */
export const CALENDAR_WINDOW_MAX_DAYS = 372;
/** A range that names neither end: today and the next 90 days (a quarter). */
export const CALENDAR_DEFAULT_DAYS = 90;

/** The one sentence a refused appointment answers with (route, tool, service). */
export const APPOINTMENT_RULE =
  "an appointment needs a title, a date and an HH:MM time, a 5 to 720 minute duration, and up to 8 distinct reminder offsets no more than 30 days before it";

/** The one sentence a refused date range answers with (route and tool). */
export const CALENDAR_WINDOW_RULE = `an appointment range is two calendar dates (YYYY-MM-DD), the start on or before the end, at most ${CALENDAR_WINDOW_MAX_DAYS} days apart`;

export const APPOINTMENT_STATUSES = ["scheduled", "cancelled", "completed"] as const;

/**
 * The fields a create or update carries, normalised once. The zone is **not**
 * one of them: it is the household's, read inside the commit, never client
 * input.
 */
export type AppointmentFields = {
  title: string;
  localDate: string;
  timeLocal: string;
  durationMin: number;
  location?: string;
  vetName?: string;
  notes?: string;
  /**
   * Absent means "the household default" on create and "unchanged" on update —
   * a title fix must never silently switch reminders off. `[]` is an explicit
   * "no reminders".
   */
  reminderOffsetsMin?: number[];
};

/** The keys a create or update body may carry (the zone is never client input). */
export const APPOINTMENT_FIELD_KEYS = [
  "title",
  "localDate",
  "timeLocal",
  "durationMin",
  "location",
  "vetName",
  "notes",
  "reminderOffsetsMin",
] as const;

/** Display text is uncapped, as a member's name is: JSON-quoted where shown. */
function displayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

/** One line of caregiver text; empty text is absent, not stored. */
function lineText(value: unknown, limit: number): string | undefined {
  const text = displayText(value);
  return text === undefined || text.length > limit ? undefined : text;
}

/** A present-but-empty optional text field means "absent", as in a meal note. */
function optionalLine(value: unknown, limit: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  if (value.trim() === "") return null;
  return lineText(value, limit);
}

/**
 * `[1440, 60]` is the plan's default, so the order is preserved and only
 * distinct whole minutes are accepted. A duplicate would arm the same reminder
 * twice (P4-03), and a fractional minute has no meaning to a task scheduler.
 */
export function parseReminderOffsets(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length > REMINDER_OFFSETS_MAX) return undefined;
  const offsets: number[] = [];
  const seen = new Set<number>();
  for (const offset of value) {
    if (typeof offset !== "number" || !Number.isSafeInteger(offset)) return undefined;
    if (offset < 0 || offset > REMINDER_OFFSET_MAX_MIN) return undefined;
    if (seen.has(offset)) return undefined;
    seen.add(offset);
    offsets.push(offset);
  }
  return offsets;
}

/**
 * The local-date range one read asks for. Both ends are optional: `from`
 * defaults to the household's today and `to` to 90 days later, so a caller that
 * names nothing gets the useful quarter. The range is inclusive and may include
 * past days (the calendar's history is readable); only a reversed, malformed or
 * over-wide range is refused, because it would scan an unbounded document.
 */
export type CalendarWindow = { from: string; to: string };

export function parseCalendarWindow(from: unknown, to: unknown, today: string): CalendarWindow | undefined {
  if (!isLocalDate(today)) return undefined;
  if (from !== undefined && from !== null && !isLocalDate(from)) return undefined;
  if (to !== undefined && to !== null && !isLocalDate(to)) return undefined;
  const start = typeof from === "string" ? from : today;
  const end = typeof to === "string" ? to : dateMinusDays(start, -CALENDAR_DEFAULT_DAYS);
  if (!isLocalDate(end)) return undefined;
  const span = daysBetween(start, end);
  if (span < 0 || span > CALENDAR_WINDOW_MAX_DAYS) return undefined;
  return { from: start, to: end };
}

/**
 * The editable fields of a create or update. The parser is the fence for both
 * surfaces (§10.3): the HTTP route and the agent tool pass the caller's object
 * and the service re-parses before it writes.
 */
export function parseAppointmentFields(raw: unknown): AppointmentFields | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(APPOINTMENT_FIELD_KEYS as readonly string[]).includes(key))) {
    return undefined;
  }

  const title = lineText(record.title, APPOINTMENT_TITLE_LIMIT);
  if (title === undefined) return undefined;
  if (!isLocalDate(record.localDate)) return undefined;
  if (!isLocalTime(record.timeLocal)) return undefined;
  const durationMin = record.durationMin;
  if (
    typeof durationMin !== "number" ||
    !Number.isSafeInteger(durationMin) ||
    durationMin < APPOINTMENT_DURATION_MIN ||
    durationMin > APPOINTMENT_DURATION_MAX
  ) {
    return undefined;
  }

  const location = optionalLine(record.location, APPOINTMENT_LOCATION_LIMIT);
  if (location === undefined) return undefined;
  const vetName = optionalLine(record.vetName, APPOINTMENT_VET_LIMIT);
  if (vetName === undefined) return undefined;
  const notes = optionalLine(record.notes, APPOINTMENT_NOTES_LIMIT);
  if (notes === undefined) return undefined;

  const fields: AppointmentFields = {
    title,
    localDate: record.localDate,
    timeLocal: record.timeLocal,
    durationMin,
  };
  if (location !== null) fields.location = location;
  if (vetName !== null) fields.vetName = vetName;
  if (notes !== null) fields.notes = notes;

  if (record.reminderOffsetsMin !== undefined && record.reminderOffsetsMin !== null) {
    const offsets = parseReminderOffsets(record.reminderOffsetsMin);
    if (!offsets) return undefined;
    fields.reminderOffsetsMin = offsets;
  }
  return fields;
}

const APPOINTMENT_KEYS = [
  "id",
  "title",
  "localDate",
  "timeLocal",
  "timezone",
  "durationMin",
  "location",
  "vetName",
  "notes",
  "status",
  "reminderOffsetsMin",
  "reminders",
  "createdBy",
  "createdByLabel",
  "updatedAt",
  "rev",
  "actionId",
] as const;

function isStatus(value: unknown): value is AppointmentStatus {
  return (APPOINTMENT_STATUSES as readonly unknown[]).includes(value);
}

/**
 * The armed reminders P4-03 writes. A repeated task id could not be retired
 * twice, and a repeated offset would mean two reminders for one instant; both
 * are refused. `dueAt` is an epoch millisecond reading, so it must be a safe
 * non-negative integer — the same shape the task's input carries.
 */
function parseAppointmentReminderRefs(value: unknown): AppointmentReminderRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: AppointmentReminderRef[] = [];
  const taskIds = new Set<number>();
  const offsets = new Set<number>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["taskId", "offsetMin", "dueAt"].includes(key))) return undefined;
    const { taskId, offsetMin, dueAt } = record;
    if (typeof taskId !== "number" || !Number.isSafeInteger(taskId) || taskId <= 0) return undefined;
    if (
      typeof offsetMin !== "number" ||
      !Number.isSafeInteger(offsetMin) ||
      offsetMin < 0 ||
      offsetMin > REMINDER_OFFSET_MAX_MIN
    ) {
      return undefined;
    }
    if (typeof dueAt !== "number" || !Number.isSafeInteger(dueAt) || dueAt < 0) return undefined;
    if (taskIds.has(taskId) || offsets.has(offsetMin)) return undefined;
    taskIds.add(taskId);
    offsets.add(offsetMin);
    refs.push({ taskId, offsetMin, dueAt });
  }
  return refs;
}

/**
 * One stored appointment, or `undefined` for a shape this build does not
 * accept. Every field is checked: an appointment the parser refuses must fail
 * boot rather than be silently repaired.
 */
export function parseAppointment(raw: unknown): Appointment | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(APPOINTMENT_KEYS as readonly string[]).includes(key))) return undefined;

  const { id, timezone, status, createdBy, updatedAt, rev, actionId, reminderOffsetsMin } = record;
  if (typeof id !== "string" || id === "" || id.length > APPOINTMENT_ID_LIMIT || !OPAQUE_ID_PATTERN.test(id)) {
    return undefined;
  }

  // The stored fields are the same rules as a write, plus the record's own.
  const fields = parseAppointmentFields({
    title: record.title,
    localDate: record.localDate,
    timeLocal: record.timeLocal,
    durationMin: record.durationMin,
    location: record.location,
    vetName: record.vetName,
    notes: record.notes,
    reminderOffsetsMin,
  });
  if (!fields) return undefined;
  // A stored record always carries its offset list; "absent" is a write-side
  // shorthand, not a document state.
  if (fields.reminderOffsetsMin === undefined) return undefined;

  if (!isIanaZone(timezone)) return undefined;
  if (!isStatus(status)) return undefined;
  const reminders = parseAppointmentReminderRefs(record.reminders);
  if (!reminders) return undefined;

  const createdByLabel = displayText(record.createdByLabel);
  if (createdByLabel === undefined) return undefined;
  let creatorId: string | null;
  if (createdBy === null) creatorId = null;
  else {
    const parsed = displayText(createdBy);
    if (parsed === undefined) return undefined;
    creatorId = parsed;
  }
  // §9.2's fence: no id always travels with the household label.
  if (creatorId === null && createdByLabel !== HOUSEHOLD_FALLBACK_LABEL) return undefined;

  if (!isIsoInstant(updatedAt)) return undefined;
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) return undefined;
  if (
    typeof actionId !== "string" ||
    actionId === "" ||
    actionId.length > APPOINTMENT_ACTION_ID_LIMIT ||
    !OPAQUE_ID_PATTERN.test(actionId)
  ) {
    return undefined;
  }

  return {
    id,
    title: fields.title,
    localDate: fields.localDate,
    timeLocal: fields.timeLocal,
    timezone,
    durationMin: fields.durationMin,
    ...(fields.location !== undefined ? { location: fields.location } : {}),
    ...(fields.vetName !== undefined ? { vetName: fields.vetName } : {}),
    ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
    status,
    reminderOffsetsMin: fields.reminderOffsetsMin,
    reminders,
    createdBy: creatorId,
    createdByLabel,
    updatedAt,
    rev,
    actionId,
  };
}

/** A stored calendar: unique ids. Order and cancelled history are not rules. */
export function parseAppointmentList(raw: unknown): Appointment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const appointments: Appointment[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const appointment = parseAppointment(item);
    if (!appointment || ids.has(appointment.id)) return undefined;
    ids.add(appointment.id);
    appointments.push(appointment);
  }
  return appointments;
}

