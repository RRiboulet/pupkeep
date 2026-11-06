// The calendar service (PLAN §8.1, §8.3, §8.4, §7.3, §7.4, §9.2, §16 P4-01).
//
// One writer, one document: create, update and cancel an appointment, each in
// one commit that also writes one activity line and the `app.commands`
// idempotency record. P4-07 split each writer into a transaction-level core
// (`createAppointmentIn`, `changeAppointmentIn`) and an idempotent wrapper, so a
// caregiver's confirmation executes the *same* code the button does inside its
// own commit (§9.3) instead of a second write path. The decisions live in `shared/calendar.ts` (the shape,
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
// P4-02 added the HTTP surface, the agent reads and the Calendar UI; P4-03 the
// reminder tasks and their refs; P4-07 the approval path (the agent proposes,
// and `confirmApproval` runs `createAppointmentIn`/`changeAppointmentIn` in the
// deciding commit). Cancellation here is already a state change, never a delete:
// history stays readable.

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { JsonObject, Tx } from "@earendil-works/pi-durable";
import type { Appointment, Calendar, Household } from "../../shared/domain.ts";
import {
  APPOINTMENT_RULE,
  parseAppointment,
  parseAppointmentFields,
  parseAppointmentList,
  parseCalendarWindow,
  type AppointmentFields,
  type CalendarWindow,
} from "../../shared/calendar.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorRef, ActorResolver } from "./actor.ts";
import { requestHashOf, runIdempotent, type CommandOutcome } from "./commands.ts";
import { ActivityDoc, CalendarDoc, HouseholdDoc, parseCalendar, type DocStore } from "./docs.ts";
import { DomainConflictError, UnavailableError } from "./errors.ts";
import { armAppointmentReminders } from "../reminders/appointment-schedule.ts";
import { instantAtLocalWallClock, localDateAt } from "./time.ts";

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
    reminders: [],
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

// --- the calendar surface ---------------------------------------------------

/**
 * One appointment as every surface renders it (P4-02): the stored wall clock
 * plus the **derived** UTC instants. An instant is never stored, so this is the
 * one place a record becomes a timeline entry. `endsAt` is `startsAt` plus the
 * stored duration; the end time is not a second source of truth.
 */
export type AppointmentView = Appointment & { startsAt: string; endsAt: string };

/**
 * What `GET /api/appointments` and `list_appointments` answer (P4-02): the
 * household's clock and zone, the range the caller got, the appointments in it
 * (cancelled history included, sorted by the derived instant), the next
 * scheduled appointment regardless of range, and the household's default
 * reminder offsets so a create form starts from the setting rather than a
 * hard-coded guess.
 */
export type CalendarView = {
  timezone: string;
  today: string;
  from: string;
  to: string;
  appointments: AppointmentView[];
  next: AppointmentView | null;
  defaultReminderOffsetsMin: number[];
};

/** The stored record plus its derived instants; the timeline's one builder. */
export function appointmentView(appointment: Appointment): AppointmentView {
  const starts = appointmentInstant(appointment);
  return {
    ...appointment,
    startsAt: starts.toISOString(),
    endsAt: new Date(starts.getTime() + appointment.durationMin * 60_000).toISOString(),
  };
}

/**
 * The view for one range. Filtering is by the stored **local date**, not by the
 * derived instant: a month grid asks for calendar days, and a cancelled
 * appointment inside the month is history the grid shows. Sorting is by the
 * derived instant (ties by id, so two reads agree), which is the only order a
 * timeline can mean across zone snapshots.
 */
export function calendarView(
  household: Household,
  calendar: Calendar,
  now: Date,
  window?: CalendarWindow,
): CalendarView {
  const today = localDateAt(now, household.timezone);
  const range = window ?? parseCalendarWindow(undefined, undefined, today);
  if (!range) throw new Error("the default appointment range is not a valid calendar window");
  const appointments = calendar.appointments
    .filter((appointment) => appointment.localDate >= range.from && appointment.localDate <= range.to)
    .map(appointmentView)
    .sort((a, b) => {
      const byInstant = Date.parse(a.startsAt) - Date.parse(b.startsAt);
      return byInstant !== 0 ? byInstant : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const next = upcomingAppointments(calendar, now, 1)[0];
  return {
    timezone: household.timezone,
    today,
    from: range.from,
    to: range.to,
    appointments,
    next: next === undefined ? null : appointmentView(next),
    defaultReminderOffsetsMin: [...household.settings.appointmentReminderOffsetsMin],
  };
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
 * The commit half of a create, shared by the HTTP route and an approved agent
 * proposal (§9.3, §10.3: one domain function, no second write path). It runs
 * entirely inside the caller's transaction: the record, the armed reminders and
 * the activity line land together or not at all.
 */
export type AppointmentCreateCommit = {
  /** Already resolved from the household this transaction reads (§9.2). */
  readonly actor: ActorRef;
  readonly actionId: string;
  /** Normalised fields; `reminderOffsetsMin` absent means the household default. */
  readonly fields: AppointmentFields;
  readonly now: Date;
  /** Test seam; a fresh uuid otherwise. */
  readonly id?: string;
};

/**
 * Create one appointment inside the caller's commit. The household is read for
 * two things: the zone snapshot and the default reminder offsets
 * (`settings.appointmentReminderOffsetsMin` — the plan's one source; `[]` means
 * the household turned reminders off).
 */
export async function createAppointmentIn(tx: Tx, input: AppointmentCreateCommit): Promise<Appointment> {
  const household = await tx.doc(HouseholdDoc);
  const id = input.id ?? randomUUID();

  const appointment = appointmentFrom(
    input.fields,
    { id, rev: 0, createdBy: input.actor.id, createdByLabel: input.actor.label, actionId: input.actionId },
    household.timezone,
    input.fields.reminderOffsetsMin ?? [...household.settings.appointmentReminderOffsetsMin],
    input.now,
  );
  // Backstop, as `logFeed` does: a record the parser refuses would fail the
  // next boot, so the completed list is validated before it is stored.
  // P4-03: the same commit arms the reminders on the hidden system
  // conversation. The refs are stored on the record before the backstop
  // parse, so a task whose id could not be stored rolls the create back.
  appointment.reminders = await armAppointmentReminders(tx, household, appointment, input.now);
  const parsed = parseAppointment(appointment);
  if (!parsed) throw new DomainConflictError(APPOINTMENT_RULE);

  const draft = await tx.doc(CalendarDoc);
  if (draft.createdAt === "") draft.createdAt = input.now.toISOString();
  const appointments = [...draft.appointments, parsed];
  if (!parseAppointmentList(appointments)) throw new DomainConflictError(APPOINTMENT_RULE);
  draft.appointments = appointments;

  appendActivity(
    await tx.doc(ActivityDoc),
    activityEntry({
      kind: "appointment.created",
      // The title is caregiver free text; it is quoted so a title that reads
      // like a sentence cannot pass itself off as one in the feed.
      summary: `${input.actor.label} added the appointment ${JSON.stringify(parsed.title)}`,
      actorId: input.actor.id,
      actorLabel: input.actor.label,
      now: input.now,
    }),
  );

  return parsed;
}

/**
 * Create one appointment from a route or a tool: parse the caller's fields, then
 * one idempotent commit around `createAppointmentIn`.
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
      return {
        appointment: await createAppointmentIn(tx, {
          actor,
          actionId: input.actionId,
          fields,
          now,
          ...(input.id !== undefined ? { id: input.id } : {}),
        }),
      };
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
  | {
      kind: "changed" | "replayed";
      appointment: Appointment;
      /**
       * Reminder tasks the write replaced or cancelled; the caller retires them
       * after the commit (best-effort — the task's revision check also no-ops).
       */
      retiredTaskIds: number[];
    }
  /**
   * A newer revision exists: the committed record travels with the answer, so
   * the caller can show the other caregiver's values without a second read and
   * without guessing that the record still exists.
   */
  | { kind: "stale"; appointment: Appointment }
  | { kind: "key-conflict" };

/**
 * The commit half of an update or a cancellation, shared by the HTTP route and
 * an approved agent proposal (§9.3, §10.3). Everything §7.4 asks for happens
 * inside the caller's transaction: the revision check, the lifecycle check, the
 * replacement record (and, for an update, the re-armed reminders), the document
 * backstop and the activity line.
 */
export type AppointmentChangeCommit = {
  /** Already resolved from the household this transaction reads (§9.2). */
  readonly actor: ActorRef;
  readonly actionId: string;
  readonly id: string;
  /** The revision the caller read; the action was proposed against it. */
  readonly rev: number;
  readonly now: Date;
} & (
  | { readonly kind: "update"; /** The normalised fields the edit carries. */ readonly fields: AppointmentFields }
  | { readonly kind: "cancel" }
);

export type AppointmentChangeCommitted = {
  appointment: Appointment;
  retiredTaskIds: number[];
};

/**
 * The revision a change was read at is no longer current. A private
 * control-flow signal inside the domain — the callers turn it into a 409 that
 * carries the committed record — so it is not a caregiver-facing refusal. The
 * record is detached from the transaction's draft overlay, because the commit is
 * about to roll back and a draft reference cannot be read afterwards.
 */
export class AppointmentStaleError extends Error {
  readonly current: Appointment;

  constructor(current: Appointment) {
    super("the appointment changed since it was read");
    this.name = "AppointmentStaleError";
    this.current = current;
  }
}

/**
 * Update or cancel one appointment inside the caller's commit. The one writer
 * behind both surfaces, so an approved proposal cannot drift from the button in
 * the app.
 */
export async function changeAppointmentIn(tx: Tx, input: AppointmentChangeCommit): Promise<AppointmentChangeCommitted> {
  const household = await tx.doc(HouseholdDoc);
  const draft = await tx.doc(CalendarDoc);
  const index = draft.appointments.findIndex((entry) => entry.id === input.id);
  const found = index === -1 ? undefined : draft.appointments[index];
  // A missing record is not a stale one: the caller gets 404, not 409.
  if (!found) throw new AppointmentUnknownError();
  if (found.rev !== input.rev) {
    const current = parseAppointment(found);
    if (current === undefined) throw new DomainConflictError(APPOINTMENT_RULE);
    throw new AppointmentStaleError(current);
  }
  // A cancellation is final and a completed visit is history: neither is
  // editable, and neither is silently reopened by a retried key.
  if (found.status !== "scheduled") {
    throw new DomainConflictError(
      found.status === "cancelled" ? "that appointment is cancelled" : "that appointment is completed",
    );
  }

  // Every edit or cancellation replaces the armed tasks; their ids travel back
  // so the caller can abort them once this commit lands.
  const retiredTaskIds = found.reminders.map((ref) => ref.taskId);

  let next: Appointment;
  if (input.kind === "cancel") {
    next = {
      ...found,
      status: "cancelled",
      updatedAt: input.now.toISOString(),
      rev: found.rev + 1,
      actionId: input.actionId,
      // A cancelled visit has no pending reminders; the caller retires the
      // tasks the record used to carry.
      reminders: [],
    };
  } else {
    const fields = input.fields;
    const updated = appointmentFrom(
      fields,
      {
        id: found.id,
        rev: found.rev + 1,
        createdBy: found.createdBy,
        createdByLabel: found.createdByLabel,
        actionId: input.actionId,
      },
      // The editor writes wall-clock times on the household's current clock.
      household.timezone,
      fields.reminderOffsetsMin ?? found.reminderOffsetsMin,
      input.now,
    );
    // A new revision is a new arm: the old tasks carry the previous revision and
    // no-op, and the caller aborts them after this commit. Offsets already past
    // are skipped by the plan.
    updated.reminders = await armAppointmentReminders(tx, household, updated, input.now);
    next = updated;
  }

  const parsed = parseAppointment(next);
  if (!parsed) throw new DomainConflictError(APPOINTMENT_RULE);
  const appointments = draft.appointments.map((entry, position) => (position === index ? parsed : entry));
  if (!parseAppointmentList(appointments)) throw new DomainConflictError(APPOINTMENT_RULE);
  draft.appointments = appointments;

  appendActivity(
    await tx.doc(ActivityDoc),
    activityEntry({
      kind: input.kind === "cancel" ? "appointment.cancelled" : "appointment.updated",
      // The title is caregiver free text; it is quoted so a title that reads like
      // a sentence cannot pass itself off as one in the feed.
      summary:
        input.kind === "cancel"
          ? `${input.actor.label} cancelled the appointment ${JSON.stringify(parsed.title)}`
          : `${input.actor.label} changed the appointment ${JSON.stringify(parsed.title)}`,
      actorId: input.actor.id,
      actorLabel: input.actor.label,
      now: input.now,
    }),
  );

  return { appointment: parsed, retiredTaskIds };
}

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
} & (
  | { readonly kind: "update"; readonly fields: AppointmentFields }
  | { readonly kind: "cancel" }
);

/**
 * The one place update and cancel share their §7.4 ceremony: idempotency lookup,
 * the actor resolved inside the commit, then `changeAppointmentIn`. A stale
 * revision rolls the whole commit back, key included: the caller re-reads and
 * retries as a new action, it does not replay this one.
 */
async function runAppointmentChange(run: AppointmentChangeRun): Promise<AppointmentChangeOutcome> {
  let outcome: CommandOutcome<AppointmentChangeCommitted>;
  try {
    outcome = await runIdempotent(
      { store: run.store, context: run.context },
      { key: run.actionId, requestHash: requestHashOf(run.request), now: run.now },
      async (tx: Tx) => {
        const household = await tx.doc(HouseholdDoc);
        const actor = await run.actor(tx, household);
        const common = {
          actor,
          actionId: run.actionId,
          id: run.id,
          rev: run.rev,
          now: run.now,
        };
        return changeAppointmentIn(
          tx,
          run.kind === "update" ? { ...common, kind: "update", fields: run.fields } : { ...common, kind: "cancel" },
        );
      },
    );
  } catch (error) {
    if (error instanceof AppointmentStaleError) return { kind: "stale", appointment: error.current };
    throw error;
  }

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as AppointmentChangeCommitted;
  return {
    kind: outcome.kind === "replayed" ? "replayed" : "changed",
    appointment: recorded.appointment,
    // A replay's task ids were retired by the original commit; aborting a
    // terminal task again is a no-op, so carrying them is harmless.
    retiredTaskIds: recorded.retiredTaskIds ?? [],
  };
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
    kind: "update",
    fields,
  });
}

/**
 * Cancel an appointment: a **state change**, not a delete (P4-01's guardrail).
 * The record keeps its history and its armed task ids; P4-03's cancel path
 * cancels the tasks, and P4-07 makes the agent's cancellation a proposal a
 * caregiver confirms (the confirm commit calls `changeAppointmentIn`, the same
 * code this wrapper does). Cancelling an already-cancelled record with a *new*
 * key is refused rather than silently bumping the revision a second time.
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
    kind: "cancel",
  });
}
