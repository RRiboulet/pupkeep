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

/**
 * Version 2 adds `rev` and `timezoneConfirmedAt` (P1-14); a version-1 document
 * migrates on read, so a phone that ran P1-08 keeps its household.
 */
export const HOUSEHOLD_SCHEMA_VERSION = 2 as const;
/** Version 2 adds `rev` (P1-11); a version-1 document migrates on read. */
export const PUPPY_SCHEMA_VERSION = 2 as const;
export const ACTIVITY_SCHEMA_VERSION = 1 as const;
export const COMMANDS_SCHEMA_VERSION = 1 as const;
/**
 * Version 2 adds the feed events (P2-01); a version-1 document (P1-14, slots
 * only) migrates on read, so a phone that set up its meal times keeps them.
 */
export const FEEDING_SCHEMA_VERSION = 2 as const;

export type MemberProfile = { id: string; name: string };

export type HouseholdSettings = {
  feedReminderDelayMin: number;
  appointmentReminderOffsetsMin: number[];
  showerIntervalDays: number;
  agentBudgetUsd: number;
};

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
