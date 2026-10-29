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

export const HOUSEHOLD_SCHEMA_VERSION = 1 as const;
export const PUPPY_SCHEMA_VERSION = 1 as const;
export const ACTIVITY_SCHEMA_VERSION = 1 as const;
export const COMMANDS_SCHEMA_VERSION = 1 as const;

export type MemberProfile = { id: string; name: string };

export type HouseholdSettings = {
  feedReminderDelayMin: number;
  appointmentReminderOffsetsMin: number[];
  showerIntervalDays: number;
  agentBudgetUsd: number;
};

export type Household = {
  schemaVersion: typeof HOUSEHOLD_SCHEMA_VERSION;
  name: string;
  /** IANA zone; every local date/time is derived in this zone. */
  timezone: string;
  members: MemberProfile[];
  /** One human-facing Pi Durable conversation; numeric id. */
  conversationId: number;
  /** Hidden task owner; never has a model (PLAN §9.1). */
  systemConversationId: number;
  createdAt: string;
  settings: HouseholdSettings;
};

export type PuppySex = "male" | "female";

export type Puppy = {
  schemaVersion: typeof PUPPY_SCHEMA_VERSION;
  /** Empty on a fresh boot; P1-14's first-run wizard fills it. */
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
