// The session documents PLAN §8.1 assigns to P1-08 (household, puppy, activity,
// commands), plus the care documents later phases added (`app.feeding` with the
// meal slots and feed events, `app.notifications`, `app.walks`, `app.growth`,
// `app.training`, `app.showers`, `app.calendar`, `app.approvals`), and their
// parsers.
//
// The doc `version` and the value's `schemaVersion` start at 1. A shape change
// increments both and adds `migrate(value, fromVersion)`; the parsers below then
// accept the current shape only, because a migrated value is what the Session
// hands them. Five migrations exist so far:
//   * `app.puppy` moved to version 2 when P1-11 added `rev`, and `migrate`
//     fills `rev: 0` for a version-1 document;
//   * `app.household` moved to version 2 when P1-14 added `rev` and
//     `timezoneConfirmedAt`, and `migrate` fills `rev: 0` and leaves the zone
//     unconfirmed so first-run setup asks for it;
//   * `app.feeding` moved to version 2 when P2-01 added the feed events, and
//     `migrate` adds `events: []` while keeping the slots and the revision;
//   * `app.walks` moved to version 2 when P2-07 added the discard marker, and
//     `migrate` only restamps a version-1 document;
//   * `app.household` moved to version 3 when P2-09 added `feedReminders`, the
//     ids of the feeding reminders the meal schedule armed; `migrate` adds the
//     empty list on top of the version-2 fields.
//   * `app.calendar` moved to version 2 when P4-03 replaced `reminderTaskIds`
//     with the armed reminder refs; `migrate` adds the empty list, because P4-01
//     never armed a task.
//   * `app.household` moved to version 4 when P4-04 added `feedPlannerTaskId`;
//     `migrate` starts it null and the next boot reconciliation arms the planner.
//   * `app.notifications` moved to version 2 when P4-05 added the outbox
//     delivery state; a version-1 item migrates as pending.
// A phone that ran an older build therefore keeps its household and profile
// instead of failing boot.
//
// An unknown schemaVersion or a malformed value is a bootstrap error, never a
// silent reset: resetting would discard members, settings or pending
// idempotency records.
//
// `checkpointWhen` stores a full base every 100 deltas. The documents are small;
// the point is to bound replay and to keep the policy explicit rather than a
// permanent `() => false`.

import type { Context } from "@earendil-works/chord";
import type { CheckpointInfo, DocumentReader, Tx } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import {
  ACTIVITY_SCHEMA_VERSION,
  APPROVALS_SCHEMA_VERSION,
  CALENDAR_SCHEMA_VERSION,
  COMMANDS_SCHEMA_VERSION,
  DEFAULT_HOUSEHOLD_NAME,
  DEFAULT_HOUSEHOLD_SETTINGS,
  FEEDING_SCHEMA_VERSION,
  GROWTH_SCHEMA_VERSION,
  HOUSEHOLD_SCHEMA_VERSION,
  TRAINING_SCHEMA_VERSION,
  NOTIFICATIONS_SCHEMA_VERSION,
  OPAQUE_ID_PATTERN,
  PUPPY_SCHEMA_VERSION,
  SHOWER_INTERVAL_MAX_DAYS,
  SHOWERS_SCHEMA_VERSION,
  WALKS_SCHEMA_VERSION,
  type Activity,
  type ActivityEntry,
  type Approvals,
  type Calendar,
  type CommandRecord,
  type Commands,
  type FeedReminderRef,
  type Feeding,
  type Growth,
  type Showers,
  type Training,
  type Household,
  type HouseholdSettings,
  isIsoInstant,
  type MemberProfile,
  type Notifications,
  type Puppy,
  type PuppySex,
  type Walks,
} from "../../shared/domain.ts";
import { parseAppointmentList, parseReminderOffsets } from "../../shared/calendar.ts";
import { parseApprovalList } from "../../shared/approvals.ts";
import { SLOT_ID_LIMIT, parseFeedEvents, parseStoredMealSlots } from "../../shared/feeding.ts";
import { parseGrowthMeasurements } from "../../shared/growth.ts";
import { parseTrainingList } from "../../shared/training.ts";
import { parseShowerList } from "../../shared/showers.ts";
import { parseNotificationIntents, pendingDelivery } from "../../shared/notifications.ts";
import { parseWalkList } from "../../shared/walks.ts";
import { hasControlCharacter, isIanaZone, isLocalDate } from "../../shared/profile.ts";

/**
 * What a domain function needs from its caller: committed reads plus one
 * commit. A `Harness` satisfies it, and so does a tool's `ToolExecutionApi`,
 * which is what lets HTTP and the agent share one domain function.
 */
export type DocStore = Pick<DocumentReader, "snapshot"> & {
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
};

/** Store a base after this many deltas since the previous base. */
export function checkpointEvery(deltas: number): (_value: unknown, _ops: unknown, info: CheckpointInfo) => boolean {
  return (_value, _ops, info) => info.deltasSinceBase >= deltas;
}

const CHECKPOINT_DELTAS = 100;

export function emptyHousehold(): Household {
  return {
    schemaVersion: HOUSEHOLD_SCHEMA_VERSION,
    rev: 0,
    name: DEFAULT_HOUSEHOLD_NAME,
    timezone: "UTC",
    // Nobody has confirmed the zone yet; first-run setup (P1-14) does.
    timezoneConfirmedAt: null,
    members: [],
    // Replaced by the bootstrap in the same commit that creates the document.
    conversationId: 0,
    systemConversationId: 0,
    createdAt: "",
    settings: { ...DEFAULT_HOUSEHOLD_SETTINGS, appointmentReminderOffsetsMin: [...DEFAULT_HOUSEHOLD_SETTINGS.appointmentReminderOffsetsMin] },
    feedReminders: [],
    feedPlannerTaskId: null,
  };
}

export function emptyPuppy(): Puppy {
  return {
    schemaVersion: PUPPY_SCHEMA_VERSION,
    rev: 0,
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

/** A fresh schedule: no slots until first-run setup writes them, no meals yet. */
export function emptyFeeding(): Feeding {
  return { schemaVersion: FEEDING_SCHEMA_VERSION, rev: 0, slots: [], events: [], createdAt: "" };
}

/** No measurements yet; the target weight lives on `app.puppy` (P1-11). */
export function emptyGrowth(): Growth {
  return { schemaVersion: GROWTH_SCHEMA_VERSION, measurements: [], createdAt: "" };
}

/** The milestone board: the catalog is the build's, this document the household's. */
export function emptyTraining(): Training {
  return { schemaVersion: TRAINING_SCHEMA_VERSION, states: [], custom: [], createdAt: "" };
}

/** The shower history: append-only, with the next due date derived elsewhere. */
export function emptyShowers(): Showers {
  return { schemaVersion: SHOWERS_SCHEMA_VERSION, showers: [], createdAt: "" };
}

/** No appointments yet; the calendar is never reset, only appended to. */
export function emptyCalendar(): Calendar {
  return { schemaVersion: CALENDAR_SCHEMA_VERSION, appointments: [], createdAt: "" };
}

/** No committed notification intents yet. */
export function emptyNotifications(): Notifications {
  return { schemaVersion: NOTIFICATIONS_SCHEMA_VERSION, items: [], createdAt: "" };
}

/** No proposals yet; a fresh household has nothing waiting for a decision. */
export function emptyApprovals(): Approvals {
  return { schemaVersion: APPROVALS_SCHEMA_VERSION, approvals: [], createdAt: "" };
}

export function emptyWalks(): Walks {
  return { schemaVersion: WALKS_SCHEMA_VERSION, walks: [], createdAt: "" };
}

export const HouseholdDoc = defineDoc<Household>({
  kind: "app.household",
  version: 4,
  scope: "session",
  initial: emptyHousehold,
  // A version-1 document (P1-08) predates `rev` and the timezone confirmation:
  // the captured zone is kept but stays unconfirmed, because nobody has checked
  // it. A version-2 document (P1-14) only lacks the reminder ids. In both cases
  // boot must not invent a confirmation, and the roster is not revised.
  migrate(value, fromVersion) {
    if (fromVersion !== 1 && fromVersion !== 2 && fromVersion !== 3) {
      throw new Error(`app.household has no migration from version ${fromVersion}`);
    }
    const migrated = {
      ...(value as unknown as Record<string, unknown>),
      schemaVersion: HOUSEHOLD_SCHEMA_VERSION,
      ...(fromVersion === 1 ? { rev: 0, timezoneConfirmedAt: null } : {}),
      // Versions 1 and 2 predate the slot-reminder refs; version 3 predates the
      // planner. Neither older build ever armed a planner, so the id starts null
      // and the next boot reconciliation creates one.
      ...(fromVersion <= 2 ? { feedReminders: [] } : {}),
      feedPlannerTaskId: null,
    };
    const parsed = parseHousehold(migrated);
    if (!parsed) {
      throw new Error(`app.household version ${fromVersion} does not migrate to a valid version 4`);
    }
    return parsed;
  },
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

export const PuppyDoc = defineDoc<Puppy>({
  kind: "app.puppy",
  version: 2,
  scope: "session",
  initial: emptyPuppy,
  // A version-1 document (P1-08) predates `rev`. Fill it here rather than
  // treating the document as corrupt: a phone that already has a puppy keeps it.
  migrate(value, fromVersion) {
    if (fromVersion !== 1) {
      throw new Error(`app.puppy has no migration from version ${fromVersion}`);
    }
    const migrated = {
      ...(value as unknown as Record<string, unknown>),
      schemaVersion: PUPPY_SCHEMA_VERSION,
      rev: 0,
    };
    const parsed = parsePuppy(migrated);
    if (!parsed) throw new Error("app.puppy version 1 does not migrate to a valid version 2");
    return parsed;
  },
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

/** The meal schedule (P1-14) and the meals logged against it (P2-01). */
export const FeedingDoc = defineDoc<Feeding>({
  kind: "app.feeding",
  version: 2,
  scope: "session",
  initial: emptyFeeding,
  // Version 1 (P1-14) had the slots and no events. Add the empty list rather
  // than refusing the document: a phone that set its meal times keeps them, and
  // a version-1 `rev` is still a valid revision.
  migrate(value, fromVersion) {
    if (fromVersion !== 1) {
      throw new Error(`app.feeding has no migration from version ${fromVersion}`);
    }
    const migrated = {
      ...(value as unknown as Record<string, unknown>),
      schemaVersion: FEEDING_SCHEMA_VERSION,
      events: [],
    };
    const parsed = parseFeeding(migrated);
    if (!parsed) throw new Error("app.feeding version 1 does not migrate to a valid version 2");
    return parsed;
  },
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

/** The measurement history (P3-01). */
export const GrowthDoc = defineDoc<Growth>({
  kind: "app.growth",
  version: 1,
  scope: "session",
  initial: emptyGrowth,
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

/** The milestone board (P3-04). */
export const TrainingDoc = defineDoc<Training>({
  kind: "app.training",
  version: 1,
  scope: "session",
  initial: emptyTraining,
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

/** The shower history (P3-06). */
export const ShowersDoc = defineDoc<Showers>({
  kind: "app.showers",
  version: 1,
  scope: "session",
  initial: emptyShowers,
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

/**
 * The appointments (P4-01). Version 2 (P4-03) replaces the bare
 * `reminderTaskIds` with the armed reminder refs; a version-1 document had no
 * armed task (P4-01 never created one), so `migrate` adds the empty list. A
 * cancelled record stays in the list.
 */
export const CalendarDoc = defineDoc<Calendar>({
  kind: "app.calendar",
  version: 2,
  scope: "session",
  initial: emptyCalendar,
  migrate(value, fromVersion) {
    if (fromVersion !== 1) {
      throw new Error(`app.calendar has no migration from version ${fromVersion}`);
    }
    const record = value as unknown as Record<string, unknown>;
    const appointments = Array.isArray(record.appointments) ? record.appointments : [];
    const migrated = {
      ...record,
      schemaVersion: CALENDAR_SCHEMA_VERSION,
      appointments: appointments.map((appointment) => {
        const { reminderTaskIds: _taskIds, ...rest } = (appointment ?? {}) as Record<string, unknown>;
        return { ...rest, reminders: [] };
      }),
    };
    const parsed = parseCalendar(migrated);
    if (!parsed) throw new Error("app.calendar version 1 does not migrate to a valid version 2");
    return parsed;
  },
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

/**
 * Committed notification intents (P2-02 writes them). Version 2 (P4-05) adds the
 * per-intent outbox state; a version-1 item migrates as **pending**, because it
 * was written before anything could send it.
 */
export const NotificationsDoc = defineDoc<Notifications>({
  kind: "app.notifications",
  version: 2,
  scope: "session",
  initial: emptyNotifications,
  migrate(value, fromVersion) {
    if (fromVersion !== 1) {
      throw new Error(`app.notifications has no migration from version ${fromVersion}`);
    }
    const record = value as unknown as Record<string, unknown>;
    const items = Array.isArray(record.items) ? record.items : [];
    const migrated = {
      ...record,
      schemaVersion: NOTIFICATIONS_SCHEMA_VERSION,
      items: items.map((item) => {
        const { delivery: _delivery, ...rest } = (item ?? {}) as Record<string, unknown>;
        return { ...rest, delivery: pendingDelivery() };
      }),
    };
    const parsed = parseNotifications(migrated);
    if (!parsed) throw new Error("app.notifications version 1 does not migrate to a valid version 2");
    return parsed;
  },
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

/**
 * The high-impact proposals (P4-07). Version 1 is the first shape, so there is
 * no `migrate`: an approval document from an older build does not exist.
 */
export const ApprovalsDoc = defineDoc<Approvals>({
  kind: "app.approvals",
  version: 1,
  scope: "session",
  initial: emptyApprovals,
  checkpointWhen: checkpointEvery(CHECKPOINT_DELTAS),
});

/** The open walk and the walk history (P2-06; version 2 adds discard, P2-07). */
export const WalksDoc = defineDoc<Walks>({
  kind: "app.walks",
  version: 2,
  scope: "session",
  initial: emptyWalks,
  // A version-1 document has no discarded walks; every stored record is still a
  // valid version-2 record (the field is optional), so this only restamps it.
  migrate(value, fromVersion) {
    if (fromVersion !== 1) {
      throw new Error(`app.walks has no migration from version ${fromVersion}`);
    }
    const migrated = {
      ...(value as unknown as Record<string, unknown>),
      schemaVersion: WALKS_SCHEMA_VERSION,
    };
    const parsed = parseWalks(migrated);
    if (!parsed) throw new Error("app.walks version 1 does not migrate to a valid version 2");
    return parsed;
  },
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseSettings(value: unknown): HouseholdSettings | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { feedReminderDelayMin, appointmentReminderOffsetsMin, showerIntervalDays, agentBudgetUsd } = record;
  if (!isNonNegativeNumber(feedReminderDelayMin)) return undefined;
  // An empty offset list means "no appointment reminders"; offset 0 means "at
  // the appointment". Both are allowed by the one offset rule, which P4-01's
  // appointment records use too: a household default can never be a list the
  // appointment parser refuses (which would answer every create with a
  // misleading rule message). A hand-edited list outside the rule fails boot,
  // as any other malformed document does.
  const offsets = parseReminderOffsets(appointmentReminderOffsetsMin);
  if (!offsets) return undefined;
  // A whole number of days: the due date is a calendar date, so the one place
  // that decides the interval's domain is the document parser (no second
  // rounding rule downstream).
  if (
    typeof showerIntervalDays !== "number" ||
    !Number.isSafeInteger(showerIntervalDays) ||
    showerIntervalDays < 1 ||
    showerIntervalDays > SHOWER_INTERVAL_MAX_DAYS
  ) {
    return undefined;
  }
  if (!isNonNegativeNumber(agentBudgetUsd)) return undefined;
  return {
    feedReminderDelayMin,
    appointmentReminderOffsetsMin: offsets,
    showerIntervalDays,
    agentBudgetUsd,
  };
}

export function parseMemberProfiles(value: unknown): MemberProfile[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return undefined;
  const members: MemberProfile[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) return undefined;
    const { id, name } = record;
    if (!isNonEmptyString(id) || !isNonEmptyString(name)) return undefined;
    // A display name lands in the activity feed and the agent's context; a
    // control character there would forge a line. Fail closed, as boot does.
    if (hasControlCharacter(name.trim()) || hasControlCharacter(id.trim())) return undefined;
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
  if (!isNonNegativeInteger(record.rev)) return undefined;
  if (!isNonEmptyString(record.name)) return undefined;
  if (!isIanaZone(record.timezone)) return undefined;
  if (record.timezoneConfirmedAt !== null && !isIsoInstant(record.timezoneConfirmedAt)) return undefined;
  const members = parseMemberProfiles(record.members);
  if (!members) return undefined;
  if (!isPositiveInteger(record.conversationId) || !isPositiveInteger(record.systemConversationId)) return undefined;
  if (record.conversationId === record.systemConversationId) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
  const settings = parseSettings(record.settings);
  if (!settings) return undefined;
  const feedReminders = parseFeedReminderRefs(record.feedReminders);
  if (!feedReminders) return undefined;
  const feedPlannerTaskId = record.feedPlannerTaskId;
  if (feedPlannerTaskId !== null && !isPositiveInteger(feedPlannerTaskId)) return undefined;
  return {
    schemaVersion: HOUSEHOLD_SCHEMA_VERSION,
    rev: record.rev,
    name: record.name,
    timezone: record.timezone,
    timezoneConfirmedAt: record.timezoneConfirmedAt,
    members,
    conversationId: record.conversationId,
    systemConversationId: record.systemConversationId,
    createdAt: record.createdAt,
    settings,
    feedReminders,
    feedPlannerTaskId,
  };
}

/**
 * The armed-reminder list (§12.2). Two refs for one `(slotId, localDate)` would
 * make "which task is this slot's reminder?" ambiguous, and a repeated task id
 * could not be cancelled twice; both are refused. The list is deliberately not
 * capped: it only ever holds what the schedule armed (one per active slot, and
 * past days are pruned by the next write), so a cap could turn a legitimate
 * household into a document boot refuses.
 */
export function parseFeedReminderRefs(value: unknown): FeedReminderRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: FeedReminderRef[] = [];
  const taskIds = new Set<number>();
  const keys = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) return undefined;
    // Unknown keys are refused rather than ignored, as for a meal slot: a typo
    // is visible and a future field cannot slip into the document unvalidated.
    if (Object.keys(record).some((key) => !["taskId", "slotId", "localDate", "dueAt"].includes(key))) {
      return undefined;
    }
    const { taskId, slotId, localDate, dueAt } = record;
    if (!isPositiveInteger(taskId)) return undefined;
    if (typeof slotId !== "string" || slotId === "" || slotId.length > SLOT_ID_LIMIT) return undefined;
    if (!OPAQUE_ID_PATTERN.test(slotId)) return undefined;
    if (!isLocalDate(localDate)) return undefined;
    if (!isNonNegativeInteger(dueAt)) return undefined;
    const key = `${slotId}|${localDate}`;
    if (taskIds.has(taskId) || keys.has(key)) return undefined;
    taskIds.add(taskId);
    keys.add(key);
    refs.push({ taskId, slotId, localDate, dueAt });
  }
  return refs;
}

export function parsePuppy(value: unknown): Puppy | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== PUPPY_SCHEMA_VERSION) return undefined;
  if (typeof record.rev !== "number" || !Number.isSafeInteger(record.rev) || record.rev < 0) return undefined;
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
  if (!isIsoInstant(record.createdAt)) return undefined;
  return {
    schemaVersion: PUPPY_SCHEMA_VERSION,
    rev: record.rev,
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
  if (!isNonEmptyString(id) || !isIsoInstant(at)) return undefined;
  if (!isNonEmptyString(kind) || typeof summary !== "string") return undefined;
  if (actorId !== null && !isNonEmptyString(actorId)) return undefined;
  if (!isNonEmptyString(actorLabel)) return undefined;
  return { id, at, kind, summary, actorId, actorLabel };
}

export function parseActivity(value: unknown): Activity | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== ACTIVITY_SCHEMA_VERSION) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
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
  if (!isIsoInstant(expiresAt)) return undefined;
  if (result === undefined) return undefined;
  return { key, requestHash, result: result as CommandRecord["result"], expiresAt };
}

export function parseCommands(value: unknown): Commands | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== COMMANDS_SCHEMA_VERSION) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
  if (!Array.isArray(record.entries)) return undefined;
  const entries: CommandRecord[] = [];
  const keys = new Set<string>();
  for (const item of record.entries) {
    const entry = parseCommandRecord(item);
    if (!entry) return undefined;
    // A duplicate key would make idempotent replay ambiguous; the document's
    // whole purpose is one result per key.
    if (keys.has(entry.key)) return undefined;
    keys.add(entry.key);
    entries.push(entry);
  }
  return { schemaVersion: COMMANDS_SCHEMA_VERSION, createdAt: record.createdAt, entries };
}

/**
 * `app.walks`: the open walk and the history. The list invariants live in
 * `shared/walks.ts` (unique ids, one open walk, the §9.2 pairing), so the
 * service validates a draft with the same rules the document uses.
 */
export function parseWalks(value: unknown): Walks | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== WALKS_SCHEMA_VERSION) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
  const walks = parseWalkList(record.walks);
  if (!walks) return undefined;
  return { schemaVersion: WALKS_SCHEMA_VERSION, walks, createdAt: record.createdAt };
}

/** `app.feeding`: the schedule plus the meals logged against it. */
export function parseFeeding(value: unknown): Feeding | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== FEEDING_SCHEMA_VERSION) return undefined;
  if (!isNonNegativeInteger(record.rev)) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
  // The document may hold an empty schedule (a fresh one); a write cannot.
  const slots = parseStoredMealSlots(record.slots);
  if (!slots) return undefined;
  // Events are never pruned in v1 (§8.5), so the list is unbounded by design;
  // the invariants (unique ids, one feed per slot+date — actionId and order are
  // deliberately not document rules) come from `shared/feeding.ts`, which the
  // service also uses before it appends.
  const events = parseFeedEvents(record.events);
  if (!events) return undefined;
  return { schemaVersion: FEEDING_SCHEMA_VERSION, rev: record.rev, slots, events, createdAt: record.createdAt };
}

/**
 * `app.growth`: the measurement history. The list invariants (unique ids, gram
 * precision, the §9.2 pairing) live in `shared/growth.ts`, so the service
 * validates a draft with the same rules the document uses.
 */
export function parseGrowth(value: unknown): Growth | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== GROWTH_SCHEMA_VERSION) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
  const measurements = parseGrowthMeasurements(record.measurements);
  if (!measurements) return undefined;
  return { schemaVersion: GROWTH_SCHEMA_VERSION, measurements, createdAt: record.createdAt };
}

/**
 * `app.training`: the household's milestone states and custom entries. The list
 * invariants (stable-id prefixes, unique ids/titles, `masteredAt` iff mastered,
 * the §9.2 pairing) live in `shared/training.ts`, so the service validates a
 * draft with the same rules the document uses.
 */
export function parseTraining(value: unknown): Training | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== TRAINING_SCHEMA_VERSION) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
  const parsed = parseTrainingList({ states: record.states, custom: record.custom });
  if (!parsed) return undefined;
  return { schemaVersion: TRAINING_SCHEMA_VERSION, states: parsed.states, custom: parsed.custom, createdAt: record.createdAt };
}

/**
 * `app.showers`: the shower history. The list invariants (unique ids, the §9.2
 * pairing, the text bounds) live in `shared/showers.ts`, so the service
 * validates a draft with the same rules the document uses. Order and repeated
 * days are deliberately not rules.
 */
export function parseShowers(value: unknown): Showers | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== SHOWERS_SCHEMA_VERSION) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
  const showers = parseShowerList(record.showers);
  if (!showers) return undefined;
  return { schemaVersion: SHOWERS_SCHEMA_VERSION, showers, createdAt: record.createdAt };
}

/**
 * `app.calendar`: the appointments. The record invariants (the wall-clock shape
 * with its zone snapshot, the lifecycle status, the offset and task-id lists,
 * the §9.2 pairing) live in `shared/calendar.ts`, so the service validates a
 * draft with the same rules the document uses.
 */
export function parseCalendar(value: unknown): Calendar | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== CALENDAR_SCHEMA_VERSION) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
  const appointments = parseAppointmentList(record.appointments);
  if (!appointments) return undefined;
  return { schemaVersion: CALENDAR_SCHEMA_VERSION, appointments, createdAt: record.createdAt };
}

/**
 * `app.notifications`: committed intents. The list invariants live in
 * `shared/notifications.ts` (unique keys and ids, title ⇔ category) so a caller
 * that builds a batch validates it with the same rules the document uses —
 * exactly how `parseFeeding` delegates to `parseFeedEvents`.
 */
export function parseNotifications(value: unknown): Notifications | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== NOTIFICATIONS_SCHEMA_VERSION) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
  const items = parseNotificationIntents(record.items);
  if (!items) return undefined;
  return { schemaVersion: NOTIFICATIONS_SCHEMA_VERSION, items, createdAt: record.createdAt };
}

/**
 * `app.approvals`: the high-impact proposals. Every invariant (the complete
 * stored action, the §9.2 pairing, the decision fields riding on a decided
 * record, a result only on a confirmed one) lives in `shared/approvals.ts`, so
 * the service validates a proposal with the same rules the document uses.
 */
export function parseApprovals(value: unknown): Approvals | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== APPROVALS_SCHEMA_VERSION) return undefined;
  if (!isIsoInstant(record.createdAt)) return undefined;
  const approvals = parseApprovalList(record.approvals);
  if (!approvals) return undefined;
  return { schemaVersion: APPROVALS_SCHEMA_VERSION, approvals, createdAt: record.createdAt };
}
