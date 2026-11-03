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
export const FEEDING_SCHEMA_VERSION = 1 as const;

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
 * `app.feeding` as P1-14 creates it: the meal slots the wizard collects. P2-01
 * adds the feed events and the write service, which moves the document to
 * version 2 with a `migrate` that keeps the slots.
 */
export type Feeding = {
  schemaVersion: typeof FEEDING_SCHEMA_VERSION;
  /** Optimistic-concurrency revision, as on `app.puppy` and `app.household`. */
  rev: number;
  slots: MealSlot[];
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

export const DEFAULT_HOUSEHOLD_SETTINGS: HouseholdSettings = {
  feedReminderDelayMin: 15,
  appointmentReminderOffsetsMin: [1440, 60],
  showerIntervalDays: 21,
  agentBudgetUsd: 10,
};

export const DEFAULT_HOUSEHOLD_NAME = "Our household";
