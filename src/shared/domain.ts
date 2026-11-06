// The first shared domain types (PLAN §8.3). They live in `src/shared/` so the
// server, the browser client and the tests describe the same shapes; the
// document definitions and parsers are server-side (`src/server/domain/`).
//
// Two decisions P1-08 settles here:
//   * a member profile is `{ id, name }`; roles stay in `config.json`, and the
//     household owns the display name after the profile is created;
//   * Pi Durable conversation ids are numeric, so the household stores numbers,
//     not the strings an earlier draft of §8.3 showed.

import type { JsonValue } from "@earendil-works/chord";
// Type-only on purpose: `notifications.ts` value-imports this module, so a value
// import here would make the document shapes and the catalog load-order cyclic.
import type { NotificationIntentCategory } from "./notifications.ts";

/**
 * Version 2 adds `rev` and `timezoneConfirmedAt` (P1-14); version 3 adds
 * `feedReminders`, the persisted ids of the feeding reminders the schedule
 * armed (P2-09). Older documents migrate on read, so a phone that ran P1-08 or
 * P1-14 keeps its household, members and settings.
 */
export const HOUSEHOLD_SCHEMA_VERSION = 3 as const;
/** Version 2 adds `rev` (P1-11); a version-1 document migrates on read. */
export const PUPPY_SCHEMA_VERSION = 2 as const;
export const ACTIVITY_SCHEMA_VERSION = 1 as const;
export const COMMANDS_SCHEMA_VERSION = 1 as const;
/**
 * Version 2 adds the feed events (P2-01); a version-1 document (P1-14, slots
 * only) migrates on read, so a phone that set up its meal times keeps them.
 */
export const FEEDING_SCHEMA_VERSION = 2 as const;
export const NOTIFICATIONS_SCHEMA_VERSION = 1 as const;
/** Growth measurements (P3-01): one append-only list, no revision. */
export const GROWTH_SCHEMA_VERSION = 1 as const;
/** Milestones (P3-04): the build's catalog plus the household's own. */
export const TRAINING_SCHEMA_VERSION = 1 as const;
/** Showers (P3-06): an append-only history; the next due date is derived. */
export const SHOWERS_SCHEMA_VERSION = 1 as const;
/**
 * Version 2 adds `discarded` (P2-07): a stale walk can be resolved by ending it
 * or by discarding it, and the history must keep the difference. A version-1
 * document is valid as version 2, so `migrate` only restamps it.
 */
export const WALKS_SCHEMA_VERSION = 2 as const;
/**
 * Appointments (P4-01); version 2 (P4-03) replaces the bare `reminderTaskIds`
 * with the armed reminder refs (task id, offset and due instant), so a later
 * cancel/update can target exactly the tasks it must retire.
 */
export const CALENDAR_SCHEMA_VERSION = 2 as const;

export type MemberProfile = { id: string; name: string };

export type HouseholdSettings = {
  feedReminderDelayMin: number;
  appointmentReminderOffsetsMin: number[];
  /**
   * Whole days between showers (the plan's default 21). The parser enforces the
   * bound: a due date is a calendar date, and the arithmetic must never build
   * one from a corrupt interval.
   */
  showerIntervalDays: number;
  agentBudgetUsd: number;
};

/** Ten years: past this the "interval" is a corrupt setting, not a habit. */
export const SHOWER_INTERVAL_MAX_DAYS = 3650;

export type Household = {
  schemaVersion: typeof HOUSEHOLD_SCHEMA_VERSION;
  /**
   * Optimistic-concurrency revision for the human-editable household fields
   * (the timezone today, PLAN §7.4). The roster is *reconciled*, not revised:
   * boot and an accepted invite mirror members without touching this, so a
   * partner joining cannot invalidate a caregiver's wizard draft.
   */
  rev: number;
  name: string;
  /** IANA zone; every local date/time is derived in this zone. */
  timezone: string;
  /**
   * When a caregiver confirmed the zone (P1-14); `null` means bootstrap
   * captured a default nobody has checked yet. Every future `localDate`
   * depends on the zone, so first-run setup is not complete until it is set.
   */
  timezoneConfirmedAt: string | null;
  members: MemberProfile[];
  /** One human-facing Pi Durable conversation; numeric id. */
  conversationId: number;
  /** Hidden task owner; never has a model (PLAN §9.1). */
  systemConversationId: number;
  createdAt: string;
  settings: HouseholdSettings;
  /**
   * The feeding reminders currently armed in the hidden system conversation
   * (§12.2). Persisted so a reschedule can find the task it must replace, and
   * so P4-04's planner can tell "missing" from "already there" without
   * scanning transcripts. Only today's (and a future day's) reminders are kept;
   * the schedule write prunes past days. Arming is not a human edit of the
   * household, so it never bumps `rev`.
   */
  feedReminders: FeedReminderRef[];
};

/**
 * One armed feeding reminder: the durable task, the slot and day it belongs
 * to, and the instant it is due. `dueAt` is epoch milliseconds on the harness
 * clock, exactly as the task's input holds it — a slot time is wall-clock
 * (§8.4) and only this converted instant may be scheduled.
 *
 * The pair `(slotId, localDate)` is the identity: one reminder per slot and
 * day. A rescheduled slot gets a new task and a new ref, and the old task
 * no-ops when it wakes (§12.2).
 */
export type FeedReminderRef = {
  /** Pi Durable task id; the task is owned by the system conversation. */
  taskId: number;
  slotId: string;
  /** `YYYY-MM-DD` in the household zone: the day the reminder is for. */
  localDate: string;
  /** Slot time + `settings.feedReminderDelayMin`, epoch ms. */
  dueAt: number;
};

/**
 * One meal the household serves at a wall-clock time (PLAN §8.3). The time is
 * local to the household zone and never an instant: the same "07:00" moves
 * with the household through a DST change, which is what a caregiver means.
 */
export type MealSlot = {
  /** Stable across edits; P2's feed events reference it. */
  id: string;
  label: string;
  /** `HH:MM` on the household's clock. */
  timeLocal: string;
  portion?: string;
  /** An inactive slot stays in the schedule but is not expected today. */
  active: boolean;
};

/**
 * One logged meal (PLAN §8.3). A normal feed claims a slot (`slotId` non-null)
 * and can only happen once per slot per local date; an extra feeding has
 * `slotId: null` and never marks a meal as done.
 *
 * `localDate` is the household-local date the meal happened on, derived from
 * `at` in the household zone at write time — never from client input (§8.5).
 * It is stored because a day view must not re-derive a past meal's date after
 * the household moves zones: the meal happened on the day the household lived.
 */
export type FeedEvent = {
  id: string;
  /** A meal slot, or `null` for an extra feeding. May name a removed slot. */
  slotId: string | null;
  /** `YYYY-MM-DD` in the household zone on the day it happened. */
  localDate: string;
  /** UTC instant, ISO with a trailing `Z`. */
  at: string;
  amount?: string;
  note?: string;
  /** Config member id, or `null` for the household fallback (§9.2). */
  byUserId: string | null;
  /** Display label, resolved through `app.household` at write time. */
  byLabel: string;
  source: "ui" | "agent";
  /** HTTP idempotency key or the agent tool's task id (§7.3). */
  actionId: string;
};

/**
 * `app.feeding`: the meal schedule (P1-14) and the meals logged against it
 * (P2-01). The write service is P2-02; this task fixes the shape and its
 * invariants so the service has one document to append to.
 */
export type Feeding = {
  schemaVersion: typeof FEEDING_SCHEMA_VERSION;
  /** Optimistic-concurrency revision, as on `app.puppy` and `app.household`. */
  rev: number;
  slots: MealSlot[];
  /**
   * Append order; a day view sorts by `at`. At most one normal feed per slot
   * per local date, and never a repeated event id. `actionId` uniqueness is
   * **not** a document rule: the idempotency key is 24 h-scoped in
   * `app.commands` (§7.3), so a reused key must not make the document
   * unreadable — the service answers it (see `shared/feeding.ts`).
   */
  events: FeedEvent[];
  createdAt: string;
};

/**
 * One walk (PLAN §8.3). A walk is a single record whose duration is derived
 * from two **server** timestamps: a phone's clock skew must not reorder two
 * caregivers' walks, and the timer a browser shows uses the server offset
 * (§8.4), never the device clock.
 *
 * `endedAt` absent means the walk is open. There is at most one open walk per
 * household (a document invariant), and after eight hours an open walk is
 * **stale** (§8.5): the banner offers end/discard and a new start is refused
 * until it is resolved — never auto-closed, because the record keeps the real
 * timestamps.
 *
 * The two action ids are the idempotency keys of the two commits that create the
 * record; the fields the caregiver fills in at the end are observations, not
 * corrections of the start.
 */
export type Walk = {
  id: string;
  /** UTC instant, ISO with a trailing `Z`; the server's clock. */
  startedAt: string;
  /**
   * Absent while the walk is open. When present, `endActionId`, `endedBy` and
   * `endedByLabel` are required with it: the parser refuses a half-ended record.
   */
  endedAt?: string;
  /** HTTP idempotency key or the agent tool's task id (§7.3). */
  startedActionId: string;
  endActionId?: string;
  /** Config member id, or `null` for the household fallback (§9.2). */
  startedBy: string | null;
  startedByLabel: string;
  endedBy?: string | null;
  endedByLabel?: string;
  /** Counts, not booleans: a long walk can have more than one. */
  pee?: number;
  poop?: number;
  /** Free text, JSON-quoted wherever it is displayed. */
  dogsMet?: string;
  mood?: string;
  notes?: string;
  /**
   * A stale walk the caregivers chose to throw away rather than believe: the
   * timestamps are real but the duration is not, so the record keeps the fact
   * instead of pretending it was an ordinary end. Only valid on an ended walk,
   * and never with observations.
   */
  discarded?: true;
};

/**
 * `app.walks`: the open walk and the history (P2-06). History is never pruned
 * in v1 (§8.5); the write service appends and ends records, one commit each.
 */
export type Walks = {
  schemaVersion: typeof WALKS_SCHEMA_VERSION;
  /** Append order; a reader sorts by `startedAt` where it needs chronology. */
  walks: Walk[];
  createdAt: string;
};

/**
 * One growth measurement (PLAN §8.1, §8.3, §8.4). A caregiver logs a weight
 * (and, optionally, a height and a note); the day's **latest** measurement is
 * the day's reading, while every record is kept.
 *
 * `weightKg` is kilograms with gram precision and `heightCm` centimetres with
 * a tenth: one unit each, stored as numbers. A caregiver who weighs in grams
 * sees the conversion in the UI (P3-03); the domain never guesses a unit from a
 * string, and never silently changes one.
 */
export type GrowthMeasurement = {
  id: string;
  /**
   * `YYYY-MM-DD` in the household zone, derived from `at` at write time
   * (§8.4). Stored because a household that moves zones must not have its
   * history re-dated, exactly as a feed event's is.
   */
  localDate: string;
  /** UTC instant, ISO with a trailing `Z`; the server's clock. */
  at: string;
  /** Kilograms, rounded to whole grams; above 0 and at most 200. */
  weightKg: number;
  /** Centimetres, rounded to a tenth; optional, above 0 and at most 200. */
  heightCm?: number;
  /** Free text, one line, JSON-quoted wherever it is displayed. */
  note?: string;
  /** Config member id, or `null` for the household fallback (§9.2). */
  byUserId: string | null;
  /** Display label, resolved through `app.household` at write time. */
  byLabel: string;
  source: "ui" | "agent";
  /** HTTP idempotency key or the agent tool's task id (§7.3). */
  actionId: string;
};

/**
 * `app.growth`: the measurement history (P3-01). Append-only; never pruned in
 * v1 (§8.5), and derived views (`growthSeries`) are computed from it, never
 * stored. The **target** weight is not here: it is a human-edited field of
 * `app.puppy` (P1-11) and copying it would create a second source of truth.
 */
export type Growth = {
  schemaVersion: typeof GROWTH_SCHEMA_VERSION;
  /** Append order; a reader sorts by `at`/`localDate` where it needs chronology. */
  measurements: GrowthMeasurement[];
  createdAt: string;
};

/** §8.1's three states; `mastered` is "done" and carries its own instant. */
export const MILESTONE_STATUSES = ["not_started", "practicing", "mastered"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/**
 * One milestone in the build's starter checklist (P3-04). The id is **stable**:
 * the household's progress is keyed by it, so renaming a title or reordering the
 * list never orphans progress, and removing an entry leaves its state in the
 * document in case a later build brings the id back. The checklist is a
 * checklist — no curriculum, no schedule, no advice.
 */
export type MilestoneCatalogEntry = { id: string; title: string };

/**
 * The household's state for one milestone id (P3-04). Only milestones that were
 * actually touched have a record; an untouched one reads as `not_started`.
 *
 * `masteredAt` exists **iff** the status is `mastered` (a parser invariant): a
 * milestone cannot stay "done at" while it is practicing, and undoing is a real
 * commit — the activity feed keeps who un-did it and when, so nothing is
 * silently deleted.
 */
export type MilestoneState = {
  /** A catalog id or a custom id; see `shared/training.ts` for the prefixes. */
  id: string;
  status: MilestoneStatus;
  /** One line of caregiver text; JSON-quoted wherever it is shown. */
  note?: string;
  /** UTC instant of the last change. */
  updatedAt: string;
  byUserId: string | null;
  byLabel: string;
  /** The commit that produced this state (§7.3). */
  actionId: string;
  /** `ui` from the route, `agent` from a tool (§9.2 rule 3). */
  source: "ui" | "agent";
  /** Present exactly when `status` is `mastered`. */
  masteredAt?: string;
};

/** A milestone the household added itself (P3-04). */
export type CustomMilestone = {
  /** `custom:` + an opaque id (generated as a uuid): never a catalog id. */
  id: string;
  title: string;
  createdAt: string;
  byUserId: string | null;
  byLabel: string;
  /** The commit that added it. */
  actionId: string;
  /** `ui` from the route, `agent` from a tool (§9.2 rule 3). */
  source: "ui" | "agent";
};

/**
 * `app.training`: the milestone board (P3-04). The catalog lives in the build;
 * this document holds only what the household changed — its states and its own
 * milestones.
 */
export type Training = {
  schemaVersion: typeof TRAINING_SCHEMA_VERSION;
  /** Per-milestone state in first-touched order; unique ids. */
  states: MilestoneState[];
  /** Custom milestones, creation order; unique ids and titles. */
  custom: CustomMilestone[];
  createdAt: string;
};

/**
 * One logged shower (PLAN §8.1). "Date" is the household-local date the shower
 * happened on, derived from `at` at write time (never client input): the next
 * due date is a calendar question and must not be re-derived from a stored
 * instant after the household moves zones.
 *
 * `shampoo` and `notes` are one line of caregiver text each, JSON-quoted where
 * they are shown. The record carries who and when like every other care write.
 */
export type Shower = {
  id: string;
  /** `YYYY-MM-DD` in the household zone, derived at write time. */
  localDate: string;
  /** UTC instant, ISO with a trailing `Z`; the server's clock. */
  at: string;
  shampoo?: string;
  notes?: string;
  /** Config member id, or `null` for the household fallback (§9.2). */
  byUserId: string | null;
  byLabel: string;
  source: "ui" | "agent";
  /** HTTP idempotency key or the agent tool's task id (§7.3). */
  actionId: string;
};

/**
 * `app.showers`: the history (P3-06). Append-only and never pruned in v1; the
 * **next due date is derived** from the latest shower plus
 * `app.household.settings.showerIntervalDays` (the plan's one source for the
 * interval), not stored.
 */
export type Showers = {
  schemaVersion: typeof SHOWERS_SCHEMA_VERSION;
  /** Append order; a reader sorts by `localDate`/`at` where it needs chronology. */
  showers: Shower[];
  createdAt: string;
};

/**
 * An appointment's lifecycle (PLAN §8.3). A cancellation is a **state change**:
 * the record and its history stay readable, and the schedule simply stops
 * carrying it. `completed` is accepted by the parser for a future writer
 * (P4-02/P4-03); P4-01 writes only `scheduled` and `cancelled`.
 */
export type AppointmentStatus = "scheduled" | "cancelled" | "completed";

/**
 * One appointment (PLAN §8.1, §8.3, §8.4, §16 P4-01).
 *
 * The time is stored as **household wall clock plus a zone snapshot** — never as
 * a bare UTC instant. A 09:00 vet visit must stay at 09:00 on the household's
 * clock through a DST change; an instant written at booking time with the
 * offset of that day would show 08:00 or 10:00 after the transition. The
 * instant is therefore derived on read (`appointmentInstant`), the same rule
 * that governs a meal slot (§8.4). This is the deliberate difference from the
 * sketch in §8.3, which showed only `startsAt`.
 *
 * `timezone` is the household zone **at the last write**. The UI renders times
 * in the household zone; an edit therefore re-anchors the wall clock in the
 * zone the caregiver is reading. An appointment booked in Paris keeps 09:00
 * Paris if the household later moves — history does not move with the household.
 *
 * `rev` is the optimistic-concurrency revision: an update or cancel with a
 * stale one is refused with the current record, never applied silently (§7.4).
 */
/**
 * One armed appointment reminder (P4-03). The pair `(taskId)` and the offset
 * are unique: two tasks for one offset would double the reminder, and the same
 * task twice could not be retired once. `dueAt` is epoch milliseconds: the
 * appointment's derived instant minus the offset — the one value a task may
 * sleep on (§8.4).
 */
export type AppointmentReminderRef = {
  /** Pi Durable task id; the task is owned by the system conversation. */
  taskId: number;
  /** Minutes before the appointment this task reminds at. */
  offsetMin: number;
  /** Derived start instant minus `offsetMin`, epoch milliseconds. */
  dueAt: number;
};

export type Appointment = {
  id: string;
  /** One line of caregiver text; quoted wherever it is shown. */
  title: string;
  /** `YYYY-MM-DD` on the household's calendar. */
  localDate: string;
  /** `HH:MM` on the household's clock. */
  timeLocal: string;
  /** IANA zone snapshot; the derived instant is computed in this zone. */
  timezone: string;
  /** Whole minutes; the end time is derived, never stored. */
  durationMin: number;
  location?: string;
  vetName?: string;
  notes?: string;
  status: AppointmentStatus;
  /**
   * Minutes before the appointment to remind, from
   * `app.household.settings.appointmentReminderOffsetsMin` by default. `[]`
   * means no reminders — never "unset".
   */
  reminderOffsetsMin: number[];
  /**
   * The reminders armed for this record (P4-03), each one a durable task owned
   * by the hidden system conversation (§12.2): the task id, the offset it is
   * for and the instant it is due. Persisted here so a reschedule or a cancel
   * can target — and retire — the old tasks; the tasks themselves also no-op if
   * they wake after their record changed.
   */
  reminders: AppointmentReminderRef[];
  /** Config member id, or `null` for the household fallback (§9.2). */
  createdBy: string | null;
  createdByLabel: string;
  /** Server clock of the **last** write (create, update or cancel). */
  updatedAt: string;
  /** Revision, not schema version. */
  rev: number;
  /** HTTP idempotency key or the agent tool's task id of the last write (§7.3). */
  actionId: string;
};

/**
 * `app.calendar`: the appointments (P4-01). Never pruned in v1; a cancelled
 * appointment stays in the list so its history remains readable. Readers sort
 * by the derived instant, not by append order.
 */
export type Calendar = {
  schemaVersion: typeof CALENDAR_SCHEMA_VERSION;
  /** Append order; a reader sorts by the derived instant where it needs chronology. */
  appointments: Appointment[];
  createdAt: string;
};

/**
 * One committed notification **intent** (PLAN §12.3). P2-02 writes these in the
 * same commit as the care action; P4-05 adds the outbox/delivery fields, so this
 * is deliberately the smallest shape an in-app centre needs: who it is for, why,
 * what to show, and when it was made.
 *
 * `title` is category text from `shared/notifications.ts` and is the only text a
 * push or ntfy body may carry (§14.3). `body` is in-app copy built by app code —
 * never the model, and never pushed.
 */
export type NotificationIntent = {
  id: string;
  /**
   * Server-authoritative dedupe key (§12.3): a repeated intent is dropped, not
   * duplicated. Format is per category; the feeding service owns its own.
   */
  dedupeKey: string;
  category: NotificationIntentCategory;
  /** Config member id the item is for. */
  userId: string;
  /** Category-only title; safe for push and ntfy. */
  title: string;
  /** In-app text, app-built; never sent to a push service. */
  body: string;
  createdAt: string;
  /** null until a caregiver reads it (P4-06's centre). */
  readAt: string | null;
};

/** `app.notifications`: committed intents, append-mostly (P2-02; P4-05 extends). */
export type Notifications = {
  schemaVersion: typeof NOTIFICATIONS_SCHEMA_VERSION;
  items: NotificationIntent[];
  createdAt: string;
};

export type PuppySex = "male" | "female";

export type Puppy = {
  schemaVersion: typeof PUPPY_SCHEMA_VERSION;
  /**
   * Optimistic-concurrency revision (PLAN §7.4): every profile edit echoes the
   * revision it read back, and a stale one is a 409 with the current profile
   * instead of a silent overwrite. Starts at 0.
   */
  rev: number;
  /** Empty on a fresh boot; P1-11's UI and P1-14's wizard fill it. */
  name: string;
  /** Local date `YYYY-MM-DD`, not an instant. */
  birthday: string | null;
  breed: string | null;
  sex: PuppySex | null;
  targetWeightKg: number | null;
  createdAt: string;
};

/** One human-readable care event. Built by domain functions, never the LLM. */
export type ActivityEntry = {
  id: string;
  /** UTC ISO instant. */
  at: string;
  /** Stable action kind, e.g. `feed.logged`. */
  kind: string;
  /** Already-resolved display text; never model output. */
  summary: string;
  /** null means the household fallback, as in §8.3's write records. */
  actorId: string | null;
  actorLabel: string;
};

export type Activity = {
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  createdAt: string;
  entries: ActivityEntry[];
};

/** One idempotency record; committed with the action it describes. */
export type CommandRecord = {
  key: string;
  requestHash: string;
  result: JsonValue;
  expiresAt: string;
};

export type Commands = {
  schemaVersion: typeof COMMANDS_SCHEMA_VERSION;
  createdAt: string;
  entries: CommandRecord[];
};

/**
 * The charset every opaque id in a document shares: slot ids, logged-meal ids,
 * action ids, command keys and notification intent ids. One rule, one place, so
 * a key accepted by the routes cannot be refused by a document parser later.
 */
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * A UTC instant, ISO 8601 with a trailing `Z`: the one rule for every stored
 * instant — session documents, `config.json` and the backup status. A local date
 * and a wall-clock time are different types: `isLocalDate` lives in
 * `profile.ts`, `isLocalTime` in `feeding.ts`.
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/**
 * A UTC instant that names a real moment. `Date.parse` alone is too forgiving:
 * it normalizes `2026-02-30` to March and accepts `24:00`, so the string would
 * claim one instant while every reader saw another. The components are applied
 * and read back instead — the same round-trip `isLocalDate` uses — which also
 * rejects month 13, minute 60 and a leap second the clock never emits.
 */
export function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_INSTANT.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(0);
  // `Date.UTC` treats years 0–99 as 1900+year; set them explicitly.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

export const DEFAULT_HOUSEHOLD_SETTINGS: HouseholdSettings = {
  feedReminderDelayMin: 15,
  appointmentReminderOffsetsMin: [1440, 60],
  showerIntervalDays: 21,
  agentBudgetUsd: 10,
};

export const DEFAULT_HOUSEHOLD_NAME = "Our household";
