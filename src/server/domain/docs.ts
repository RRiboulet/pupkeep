// The four session documents PLAN §8.1 assigns to P1-08, plus their parsers.
//
// The doc `version` and the value's `schemaVersion` both start at 1. A future
// shape change increments both and adds `migrate(value, fromVersion)`; the
// parsers below then accept both shapes explicitly. An unknown schemaVersion or
// a malformed value is a bootstrap error, never a silent reset: resetting would
// discard members, settings or pending idempotency records.
//
// `checkpointWhen` stores a full base every 100 deltas. The documents are small;
// the point is to bound replay and to keep the policy explicit rather than a
// permanent `() => false`.

import type { CheckpointInfo } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import {
  ACTIVITY_SCHEMA_VERSION,
  COMMANDS_SCHEMA_VERSION,
  DEFAULT_HOUSEHOLD_NAME,
  DEFAULT_HOUSEHOLD_SETTINGS,
  HOUSEHOLD_SCHEMA_VERSION,
  PUPPY_SCHEMA_VERSION,
  type Activity,
  type ActivityEntry,
  type CommandRecord,
  type Commands,
  type Household,
  type HouseholdSettings,
  type MemberProfile,
  type Puppy,
  type PuppySex,
} from "../../shared/domain.ts";

/** Store a base after this many deltas since the previous base. */
export function checkpointEvery(deltas: number): (_value: unknown, _ops: unknown, info: CheckpointInfo) => boolean {
  return (_value, _ops, info) => info.deltasSinceBase >= deltas;
}

const CHECKPOINT_DELTAS = 100;

export function emptyHousehold(): Household {
  return {
    schemaVersion: HOUSEHOLD_SCHEMA_VERSION,
    name: DEFAULT_HOUSEHOLD_NAME,
    timezone: "UTC",
    members: [],
    // Replaced by the bootstrap in the same commit that creates the document.
    conversationId: 0,
    systemConversationId: 0,
    createdAt: "",
    settings: { ...DEFAULT_HOUSEHOLD_SETTINGS, appointmentReminderOffsetsMin: [...DEFAULT_HOUSEHOLD_SETTINGS.appointmentReminderOffsetsMin] },
  };
}

export function emptyPuppy(): Puppy {
  return {
    schemaVersion: PUPPY_SCHEMA_VERSION,
    name: "",
    birthday: null,
    breed: null,
    sex: null,
    targetWeightKg: null,
    createdAt: "",
  };
}

export function emptyActivity(): Activity {
  return { schemaVersion: ACTIVITY_SCHEMA_VERSION, createdAt: "", entries: [] };
}

export function emptyCommands(): Commands {
  return { schemaVersion: COMMANDS_SCHEMA_VERSION, createdAt: "", entries: [] };
}

export const HouseholdDoc = defineDoc<Household>({
  kind: "app.household",
  version: 1,
  scope: "session",
  initial: emptyHousehold,
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

export const PuppyDoc = defineDoc<Puppy>({
  kind: "app.puppy",
  version: 1,
  scope: "session",
  initial: emptyPuppy,
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

export const ActivityDoc = defineDoc<Activity>({
  kind: "app.activity",
  version: 1,
  scope: "session",
  initial: emptyActivity,
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

export const CommandsDoc = defineDoc<Commands>({
  kind: "app.commands",
  version: 1,
  scope: "session",
  initial: emptyCommands,
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

// --- parsers ---------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isIanaZone(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseSettings(value: unknown): HouseholdSettings | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { feedReminderDelayMin, appointmentReminderOffsetsMin, showerIntervalDays, agentBudgetUsd } = record;
  if (!isNonNegativeNumber(feedReminderDelayMin)) return undefined;
  if (!Array.isArray(appointmentReminderOffsetsMin) || appointmentReminderOffsetsMin.length === 0) return undefined;
  if (!appointmentReminderOffsetsMin.every((offset) => isPositiveInteger(offset))) return undefined;
  if (typeof showerIntervalDays !== "number" || !Number.isFinite(showerIntervalDays) || showerIntervalDays <= 0) {
    return undefined;
  }
  if (!isNonNegativeNumber(agentBudgetUsd)) return undefined;
  return {
    feedReminderDelayMin,
    appointmentReminderOffsetsMin: [...appointmentReminderOffsetsMin],
    showerIntervalDays,
    agentBudgetUsd,
  };
}

function parseMembers(value: unknown): MemberProfile[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return undefined;
  const members: MemberProfile[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) return undefined;
    const { id, name } = record;
    if (!isNonEmptyString(id) || !isNonEmptyString(name)) return undefined;
    if (ids.has(id.trim()) || names.has(name.trim().toLowerCase())) return undefined;
    ids.add(id.trim());
    names.add(name.trim().toLowerCase());
    members.push({ id, name });
  }
  return members;
}

export function parseHousehold(value: unknown): Household | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== HOUSEHOLD_SCHEMA_VERSION) return undefined;
  if (!isNonEmptyString(record.name)) return undefined;
  if (!isIanaZone(record.timezone)) return undefined;
  const members = parseMembers(record.members);
  if (!members) return undefined;
  if (!isPositiveInteger(record.conversationId) || !isPositiveInteger(record.systemConversationId)) return undefined;
  if (record.conversationId === record.systemConversationId) return undefined;
  if (!isIsoDate(record.createdAt)) return undefined;
  const settings = parseSettings(record.settings);
  if (!settings) return undefined;
  return {
    schemaVersion: HOUSEHOLD_SCHEMA_VERSION,
    name: record.name,
    timezone: record.timezone,
    members,
    conversationId: record.conversationId,
    systemConversationId: record.systemConversationId,
    createdAt: record.createdAt,
    settings,
  };
}

export function parsePuppy(value: unknown): Puppy | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== PUPPY_SCHEMA_VERSION) return undefined;
  if (typeof record.name !== "string") return undefined;
  if (record.birthday !== null && !isLocalDate(record.birthday)) return undefined;
  if (record.breed !== null && typeof record.breed !== "string") return undefined;
  const sex = record.sex;
  if (sex !== null && sex !== "male" && sex !== "female") return undefined;
  if (record.targetWeightKg !== null) {
    if (typeof record.targetWeightKg !== "number" || !Number.isFinite(record.targetWeightKg) || record.targetWeightKg <= 0) {
      return undefined;
    }
  }
  if (!isIsoDate(record.createdAt)) return undefined;
  return {
    schemaVersion: PUPPY_SCHEMA_VERSION,
    name: record.name,
    birthday: record.birthday,
    breed: record.breed,
    sex: sex as PuppySex | null,
    targetWeightKg: record.targetWeightKg,
    createdAt: record.createdAt,
  };
}

function parseActivityEntry(value: unknown): ActivityEntry | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { id, at, kind, summary, actorId, actorLabel } = record;
  if (!isNonEmptyString(id) || !isIsoDate(at)) return undefined;
  if (!isNonEmptyString(kind) || typeof summary !== "string") return undefined;
  if (actorId !== null && !isNonEmptyString(actorId)) return undefined;
  if (!isNonEmptyString(actorLabel)) return undefined;
  return { id, at, kind, summary, actorId, actorLabel };
}

export function parseActivity(value: unknown): Activity | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== ACTIVITY_SCHEMA_VERSION) return undefined;
  if (!isIsoDate(record.createdAt)) return undefined;
  if (!Array.isArray(record.entries)) return undefined;
  const entries: ActivityEntry[] = [];
  for (const item of record.entries) {
    const entry = parseActivityEntry(item);
    if (!entry) return undefined;
    entries.push(entry);
  }
  return { schemaVersion: ACTIVITY_SCHEMA_VERSION, createdAt: record.createdAt, entries };
}

function parseCommandRecord(value: unknown): CommandRecord | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { key, requestHash, result, expiresAt } = record;
  if (!isNonEmptyString(key) || !isNonEmptyString(requestHash)) return undefined;
  if (!isIsoDate(expiresAt)) return undefined;
  if (result === undefined) return undefined;
  return { key, requestHash, result: result as CommandRecord["result"], expiresAt };
}

export function parseCommands(value: unknown): Commands | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== COMMANDS_SCHEMA_VERSION) return undefined;
  if (!isIsoDate(record.createdAt)) return undefined;
  if (!Array.isArray(record.entries)) return undefined;
  const entries: CommandRecord[] = [];
  for (const item of record.entries) {
    const entry = parseCommandRecord(item);
    if (!entry) return undefined;
    entries.push(entry);
  }
  return { schemaVersion: COMMANDS_SCHEMA_VERSION, createdAt: record.createdAt, entries };
}
