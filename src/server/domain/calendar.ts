// The calendar service (PLAN §8.1, §8.3, §8.4, §7.3, §7.4, §9.2, §16 P4-01).
//
// One writer, one document: create, update and cancel an appointment, each in
// one commit that also writes one activity line and the `app.commands`
// idempotency record. The decisions live in `shared/calendar.ts` (the shape,
// the text bounds, the offset list); this module adds what needs the server:
// the household zone snapshot, the derived instant, the revision check and the
// actor resolved inside the commit.
//
// Time (§8.4): the record stores `localDate` + `timeLocal` + the household zone
// at the last write. The instant is never stored — a DST change must not move a
// 09:00 visit — and is derived by `appointmentInstant`. A write re-snapshots the
// household zone, because the editor writes wall-clock times on the household's
// current clock; an appointment booked before a move keeps the zone it was
// booked in until someone edits it.
//
// Revisions (§7.4): an update or cancel carries the `rev` the caller read. A
// stale one is a "stale" outcome (P4-02 answers 409 with the current record),
// never a silent overwrite. The check runs **inside** the commit, after the
// idempotency lookup, so a retried save with the same key replays as success
// even though its own commit bumped the revision.
//
// Carried out of P4-01: the HTTP surface, the agent tools and the Calendar UI
// (P4-02); arming the reminder tasks and writing `reminderTaskIds` (P4-03); the
// approval around a cancellation (P4-07). Cancellation here is already a state
// change, never a delete: history stays readable.

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { JsonObject, Tx } from "@earendil-works/pi-durable";
import type { Appointment, Calendar, Household } from "../../shared/domain.ts";
import {
  APPOINTMENT_RULE,
  parseAppointment,
  parseAppointmentFields,
  parseAppointmentList,
  type AppointmentFields,
} from "../../shared/calendar.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorResolver } from "./actor.ts";
import { requestHashOf, runIdempotent, type CommandOutcome } from "./commands.ts";
import { ActivityDoc, CalendarDoc, HouseholdDoc, parseCalendar, type DocStore } from "./docs.ts";
import { DomainConflictError, StaleRevisionError, UnavailableError } from "./errors.ts";
import { instantAtLocalWallClock } from "./time.ts";

/** `app.calendar` is missing or unreadable; retry once the server has booted. */
export class CalendarUnavailableError extends UnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "CalendarUnavailableError";
  }
}

/**
 * No appointment with that id (§7.4: a missing record is not a stale one).
 * A `DomainConflictError` so the one failure mapper keeps the status it carries
 * — 404, not the generic 409 a stale revision gets.
 */
export class AppointmentUnknownError extends DomainConflictError {
  constructor(message = "that appointment is not in the calendar") {
    super(message, 404);
    this.name = "AppointmentUnknownError";
  }
}

/** The appointments. Boot keeps the document present. */
export async function readCalendar(store: DocStore, context: Context): Promise<Calendar> {
  const snapshot = await store.snapshot(CalendarDoc, context);
  const calendar = snapshot === undefined ? undefined : parseCalendar(snapshot);
  if (!calendar) throw new CalendarUnavailableError("the calendar is not available; retry after boot");
  return calendar;
}

/**
 * The instant an appointment starts at, in **its own zone snapshot** (§8.4).
 * This is the one place the wall clock becomes a UTC instant; a DST change
 * between booking and the visit therefore cannot move it, because the same
 * wall clock is converted in the zone as it will be on that day.
 *
 * A parsed record always carries a valid date, time and zone; a hand-built one
 * without them is a caller bug, and `instantAtLocalWallClock` says so loudly.
 */
export function appointmentInstant(appointment: Appointment): Date {
  return instantAtLocalWallClock(appointment.localDate, appointment.timeLocal, appointment.timezone);
}

/**
 * The scheduled appointments still to come, earliest first, limited for the
 * "next appointment" line P4-02's `get_context` shows. `now` is the server
 * clock: an appointment on today's date that has already started is not
 * "upcoming".
 */
export function upcomingAppointments(
  calendar: Pick<Calendar, "appointments">,
  now: Date,
  limit = 3,
): Appointment[] {
  const at = now.getTime();
  return calendar.appointments
    .filter((appointment) => appointment.status === "scheduled")
    .map((appointment) => ({ appointment, instant: appointmentInstant(appointment).getTime() }))
    .filter((entry) => entry.instant >= at)
    .sort((a, b) => a.instant - b.instant)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.appointment);
}

/** The fields a request carries, normalised before the idempotency hash. */
function requestFields(fields: AppointmentFields): JsonObject {
  return {
    title: fields.title,
    localDate: fields.localDate,
    timeLocal: fields.timeLocal,
    durationMin: fields.durationMin,
    location: fields.location ?? null,
    vetName: fields.vetName ?? null,
    notes: fields.notes ?? null,
    reminderOffsetsMin: fields.reminderOffsetsMin ?? null,
  } as JsonObject;
}

/** Fill a draft record from normalized fields; the caller owns id/rev/actor. */
function appointmentFrom(
  fields: AppointmentFields,
  base: Pick<Appointment, "id" | "rev" | "createdBy" | "createdByLabel" | "actionId">,
  timezone: string,
  reminderOffsetsMin: number[],
  now: Date,
): Appointment {
  const appointment: Appointment = {
    id: base.id,
    title: fields.title,
    localDate: fields.localDate,
    timeLocal: fields.timeLocal,
    timezone,
    durationMin: fields.durationMin,
    status: "scheduled",
    reminderOffsetsMin,
    reminderTaskIds: [],
    createdBy: base.createdBy,
    createdByLabel: base.createdByLabel,
    updatedAt: now.toISOString(),
    rev: base.rev,
    actionId: base.actionId,
  };
  if (fields.location !== undefined) appointment.location = fields.location;
  if (fields.vetName !== undefined) appointment.vetName = fields.vetName;
  if (fields.notes !== undefined) appointment.notes = fields.notes;
  return appointment;
}

// --- creating ---------------------------------------------------------------

export type AppointmentWrite = {
  /** Resolved inside the commit, through the household the write reads. */
  readonly actor: ActorResolver;
  /** The HTTP idempotency key or the agent tool's task id, namespaced (§7.3). */
  readonly actionId: string;
  /** The caller's fields; parsed here, and again inside the commit. */
  readonly fields: unknown;
  /** Server clock; injected by tests. */
  readonly now?: Date;
  /** Test seam for the appointment id. */
  readonly id?: string;
};

export type AppointmentCreateOutcome =
  | { kind: "created" | "replayed"; appointment: Appointment }
  /** One idempotency key was reused for a different request. */
  | { kind: "key-conflict" };

/**
 * Create one appointment. The household is read for two things: the zone
 * snapshot and the default reminder offsets (`settings.appointmentReminderOffsetsMin`
 * — the plan's one source; `[]` means the household turned reminders off).
 */
export async function createAppointment(
  store: DocStore,
  context: Context,
  input: AppointmentWrite,
): Promise<AppointmentCreateOutcome> {
  const now = input.now ?? new Date();
  // Parsed before the idempotency hash so `"  vet "` and `"vet"` are one
  // request. The parser returns a fresh object (and fresh arrays), so the
  // commit uses that copy — a caller mutating its own input afterwards cannot
  // reach the stored record.
  const fields = parseAppointmentFields(input.fields);
  if (!fields) throw new DomainConflictError(APPOINTMENT_RULE);
  const request = requestFields(fields);

  const outcome: CommandOutcome<{ appointment: Appointment }> = await runIdempotent(
    { store, context },
    { key: input.actionId, requestHash: requestHashOf(request), now },
    async (tx) => {
      const household = await tx.doc(HouseholdDoc);
      const actor = await input.actor(tx, household);
      const id = input.id ?? randomUUID();

      const appointment = appointmentFrom(
        fields,
        { id, rev: 0, createdBy: actor.id, createdByLabel: actor.label, actionId: input.actionId },
        household.timezone,
        fields.reminderOffsetsMin ?? [...household.settings.appointmentReminderOffsetsMin],
        now,
      );
      // Backstop, as `logFeed` does: a record the parser refuses would fail the
      // next boot, so the completed list is validated before it is stored.
      const parsed = parseAppointment(appointment);
      if (!parsed) throw new DomainConflictError(APPOINTMENT_RULE);

      const draft = await tx.doc(CalendarDoc);
      if (draft.createdAt === "") draft.createdAt = now.toISOString();
      const appointments = [...draft.appointments, parsed];
      if (!parseAppointmentList(appointments)) throw new DomainConflictError(APPOINTMENT_RULE);
      draft.appointments = appointments;

      appendActivity(
        await tx.doc(ActivityDoc),
        activityEntry({
          kind: "appointment.created",
          // The title is caregiver free text; it is quoted so a title that reads
          // like a sentence cannot pass itself off as one in the feed.
          summary: `${actor.label} added the appointment ${JSON.stringify(parsed.title)}`,
          actorId: actor.id,
          actorLabel: actor.label,
          now,
        }),
      );

      return { appointment: parsed };
    },
  );

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as { appointment: Appointment };
  return { kind: outcome.kind === "replayed" ? "replayed" : "created", appointment: recorded.appointment };
}

// --- updating and cancelling ------------------------------------------------

export type AppointmentChange = {
  readonly actor: ActorResolver;
  readonly actionId: string;
  readonly id: string;
  /** The `rev` the caller read (§7.4). */
  readonly rev: number;
  /** The caller's fields; parsed here, and once for the idempotency hash. */
  readonly fields: unknown;
  readonly now?: Date;
};

export type AppointmentCancel = {
  readonly actor: ActorResolver;
  readonly actionId: string;
  readonly id: string;
  /** The `rev` the caller read (§7.4). */
  readonly rev: number;
  readonly now?: Date;
};

export type AppointmentChangeOutcome =
  | { kind: "changed" | "replayed"; appointment: Appointment }
  /** A newer revision exists; the caller re-reads, it does not auto-retry. */
  | { kind: "stale" }
  | { kind: "key-conflict" };

type AppointmentChangeRun = {
  readonly store: DocStore;
  readonly context: Context;
  readonly actor: ActorResolver;
  readonly actionId: string;
  readonly id: string;
  readonly rev: number;
  readonly now: Date;
  /** Hashed into the idempotency record: identical bodies replay, others conflict. */
  readonly request: JsonObject;
  /** Build the next record from the committed one; the runner parses it. */
  readonly next: (current: Appointment, household: Household) => Appointment;
  readonly activityKind: string;
  readonly activitySummary: (actorLabel: string, title: string) => string;
};

/**
 * The one place update and cancel share their §7.4 ceremony: idempotency lookup,
 * the actor resolved inside the commit, the revision check, the lifecycle check,
 * the document backstop and the activity line. Only the new record and the
 * activity sentence differ, which is what `next` and `activitySummary` supply.
 */
async function runAppointmentChange(run: AppointmentChangeRun): Promise<AppointmentChangeOutcome> {
  let outcome: CommandOutcome<{ appointment: Appointment }>;
  try {
    outcome = await runIdempotent(
      { store: run.store, context: run.context },
      { key: run.actionId, requestHash: requestHashOf(run.request), now: run.now },
      async (tx: Tx) => {
        const household = await tx.doc(HouseholdDoc);
        const actor = await run.actor(tx, household);
        const draft = await tx.doc(CalendarDoc);
        const index = draft.appointments.findIndex((entry) => entry.id === run.id);
        const current = index === -1 ? undefined : draft.appointments[index];
        // A missing record is not a stale one: the caller gets 404, not 409.
        if (!current) throw new AppointmentUnknownError();
        if (current.rev !== run.rev) throw new StaleRevisionError("the appointment changed since it was read");
        // A cancellation is final and a completed visit is history: neither is
        // editable, and neither is silently reopened by a retried key.
        if (current.status !== "scheduled") {
          throw new DomainConflictError(
            current.status === "cancelled" ? "that appointment is cancelled" : "that appointment is completed",
          );
        }

        const parsed = parseAppointment(run.next(current, household));
        if (!parsed) throw new DomainConflictError(APPOINTMENT_RULE);
        const appointments = draft.appointments.map((entry, position) => (position === index ? parsed : entry));
        if (!parseAppointmentList(appointments)) throw new DomainConflictError(APPOINTMENT_RULE);
        draft.appointments = appointments;

        appendActivity(
          await tx.doc(ActivityDoc),
          activityEntry({
            kind: run.activityKind,
            summary: run.activitySummary(actor.label, parsed.title),
            actorId: actor.id,
            actorLabel: actor.label,
            now: run.now,
          }),
        );
        return { appointment: parsed };
      },
    );
  } catch (error) {
    // A stale revision rolls the whole commit back, key included: the caller
    // re-reads and retries as a new action, it does not replay this one.
    if (error instanceof StaleRevisionError) return { kind: "stale" };
    throw error;
  }

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as { appointment: Appointment };
  return { kind: outcome.kind === "replayed" ? "replayed" : "changed", appointment: recorded.appointment };
}

/**
 * Replace an appointment's editable fields. The whole record is written, not a
 * patch: the edit form shows every field, and one commit is what a save means
 * (§7.2). Reminder offsets are the exception — absent keeps the current list,
 * because a title fix must not silently switch reminders off.
 */
export async function updateAppointment(
  store: DocStore,
  context: Context,
  input: AppointmentChange,
): Promise<AppointmentChangeOutcome> {
  const now = input.now ?? new Date();
  const fields = parseAppointmentFields(input.fields);
  if (!fields) throw new DomainConflictError(APPOINTMENT_RULE);

  return runAppointmentChange({
    store,
    context,
    actor: input.actor,
    actionId: input.actionId,
    id: input.id,
    rev: input.rev,
    now,
    request: { id: input.id, rev: input.rev, ...requestFields(fields) } as JsonObject,
    next: (current, household) => {
      const updated = appointmentFrom(
        fields,
        {
          id: current.id,
          rev: current.rev + 1,
          createdBy: current.createdBy,
          createdByLabel: current.createdByLabel,
          actionId: input.actionId,
        },
        // The editor writes wall-clock times on the household's current clock.
        household.timezone,
        fields.reminderOffsetsMin ?? current.reminderOffsetsMin,
        now,
      );
      // P4-03 owns the armed tasks; until then, and after a reschedule, the
      // recorded ids are carried through so a later cancel can target them.
      updated.reminderTaskIds = [...current.reminderTaskIds];
      return updated;
    },
    activityKind: "appointment.updated",
    // The title is caregiver free text; it is quoted so a title that reads like
    // a sentence cannot pass itself off as one in the feed.
    activitySummary: (label, title) => `${label} changed the appointment ${JSON.stringify(title)}`,
  });
}

/**
 * Cancel an appointment: a **state change**, not a delete (P4-01's guardrail).
 * The record keeps its history and its armed task ids; P4-03's cancel path
 * cancels the tasks, and P4-07 wraps the user-facing action in an approval.
 * Cancelling an already-cancelled record with a *new* key is refused rather
 * than silently bumping the revision a second time.
 */
export async function cancelAppointment(
  store: DocStore,
  context: Context,
  input: AppointmentCancel,
): Promise<AppointmentChangeOutcome> {
  const now = input.now ?? new Date();

  return runAppointmentChange({
    store,
    context,
    actor: input.actor,
    actionId: input.actionId,
    id: input.id,
    rev: input.rev,
    now,
    request: { id: input.id, rev: input.rev } as JsonObject,
    next: (current) => ({
      ...current,
      status: "cancelled",
      updatedAt: now.toISOString(),
      rev: current.rev + 1,
      actionId: input.actionId,
    }),
    activityKind: "appointment.cancelled",
    activitySummary: (label, title) => `${label} cancelled the appointment ${JSON.stringify(title)}`,
  });
}
