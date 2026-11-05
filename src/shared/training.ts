// `app.training`: the milestone catalog and the board's invariants (PLAN §8.1,
// §8.3, §9.2, §7.3, §16 P3-04).
//
// The shape is small and the rules are about identity, not content:
//
//   * **the catalog ships with the build** and its ids are stable. The document
//     stores the household's *state* per id, never a copy of a title, so a
//     catalog edit cannot rewrite what a caregiver recorded, and a removed entry
//     leaves its state in place for a later build. The checklist is a
//     checklist: no schedule, no "should be able to by now", no advice.
//   * **a custom milestone can never collide with a catalog one**: catalog ids
//     are `catalog:<slug>`, custom ids are `custom:` + an opaque id (generated
//     as a uuid), and the parser refuses any other prefix.
//   * **"done" is a fact with an instant and an actor.** `masteredAt` exists iff
//     the status is `mastered`, so undoing is a real commit (the activity feed
//     keeps who un-did it) rather than a silent delete.
//   * **an untouched milestone has no record.** The board reads it as
//     `not_started`; the document only grows when someone changes something.
//   * **`actionId` uniqueness is not a document rule**, as everywhere else: the
//     key is 24 h-scoped in `app.commands` (§7.3), so a reused key must not make
//     the document unreadable — the service answers it.
//
// The view (`milestoneView`) is the one board the HTTP route, the agent tool and
// the tests read, so the catalog cannot render differently in two places.

import type { CustomMilestone, MilestoneCatalogEntry, MilestoneState, MilestoneStatus, Training } from "./domain.ts";
import { MILESTONE_STATUSES, OPAQUE_ID_PATTERN, isIsoInstant } from "./domain.ts";
import { HOUSEHOLD_FALLBACK_LABEL } from "./chat.ts";
import { hasControlCharacter } from "./profile.ts";

/** Id prefixes: the catalog's are stable, the household's are generated. */
export const CATALOG_ID_PREFIX = "catalog:";
export const CUSTOM_ID_PREFIX = "custom:";
/** Same charset and bounds as every other opaque id. */
export const MILESTONE_ID_LIMIT = 64;
export const MILESTONE_ACTION_ID_LIMIT = 120;
export const MILESTONE_TITLE_LIMIT = 60;
export const MILESTONE_NOTE_LIMIT = 280;

/**
 * The starter checklist: neutral skill names a puppy household trains, in a
 * sensible reading order. Deliberately no descriptions, no age targets and no
 * sequencing advice — this is a board of things a caregiver may work on, not a
 * curriculum (§1.2, §16 P3-04's guardrail).
 */
export const MILESTONE_CATALOG: readonly MilestoneCatalogEntry[] = [
  { id: "catalog:name", title: "Answer to their name" },
  { id: "catalog:sit", title: "Sit" },
  { id: "catalog:down", title: "Lie down" },
  { id: "catalog:stay", title: "Stay" },
  { id: "catalog:come", title: "Come when called" },
  { id: "catalog:loose-leash", title: "Walk on a loose leash" },
  { id: "catalog:settle", title: "Settle quietly" },
  { id: "catalog:outside", title: "Ask to go outside" },
];

/** The one sentence a refused milestone write answers with (route and tool). */
export const MILESTONE_RULE =
  "a milestone is a date-free checklist entry: a status of not_started, practicing or mastered, and an optional one-line note up to 280 characters";

/** A call that would change nothing: no status and no note change. */
export const MILESTONE_NOOP_RULE = "nothing to change: set a status or change the note";

/** The one sentence for a custom milestone's title. */
export const MILESTONE_TITLE_RULE = `a custom milestone needs a title of 1 to ${MILESTONE_TITLE_LIMIT} characters, and no other milestone may already have it`;

export function isMilestoneStatus(value: unknown): value is MilestoneStatus {
  return typeof value === "string" && (MILESTONE_STATUSES as readonly string[]).includes(value);
}

/** The catalog entry for an id, if this build still ships it. */
export function catalogEntry(id: string): MilestoneCatalogEntry | undefined {
  return MILESTONE_CATALOG.find((entry) => entry.id === id);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isOpaqueId(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && OPAQUE_ID_PATTERN.test(value);
}

function cleanText(value: unknown, limit: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > limit || hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

/** Display text is uncapped, as a member's name is: JSON-quoted where shown. */
function displayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

/** The §9.2 pairing: no id always travels with the household label. */
function parseActor(record: Record<string, unknown>): { id: string | null; label: string } | undefined {
  const label = displayText(record.byLabel);
  if (label === undefined) return undefined;
  if (record.byUserId === null) {
    return label === HOUSEHOLD_FALLBACK_LABEL ? { id: null, label } : undefined;
  }
  const id = displayText(record.byUserId);
  if (id === undefined) return undefined;
  return { id, label };
}

const STATE_KEYS = ["id", "status", "note", "updatedAt", "byUserId", "byLabel", "actionId", "source", "masteredAt"] as const;
const CUSTOM_KEYS = ["id", "title", "createdAt", "byUserId", "byLabel", "actionId", "source"] as const;

/** One milestone state, or `undefined` for a shape this build does not accept. */
export function parseMilestoneState(raw: unknown): MilestoneState | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  if (Object.keys(record).some((key) => !(STATE_KEYS as readonly string[]).includes(key))) return undefined;

  const { id, status, updatedAt, actionId, source } = record;
  if (!isOpaqueId(id, MILESTONE_ID_LIMIT)) return undefined;
  if (!isMilestoneStatus(status)) return undefined;
  if (!isIsoInstant(updatedAt)) return undefined;
  if (!isOpaqueId(actionId, MILESTONE_ACTION_ID_LIMIT)) return undefined;
  if (source !== "ui" && source !== "agent") return undefined;
  const actor = parseActor(record);
  if (!actor) return undefined;
  const note = cleanText(record.note, MILESTONE_NOTE_LIMIT);
  if (note === undefined) return undefined;

  const state: MilestoneState = {
    id,
    status,
    updatedAt,
    byUserId: actor.id,
    byLabel: actor.label,
    actionId,
    source,
  };
  if (note !== null) state.note = note;

  if (status === "mastered") {
    if (!isIsoInstant(record.masteredAt)) return undefined;
    state.masteredAt = record.masteredAt;
  } else if (record.masteredAt !== undefined) {
    // `masteredAt` exists iff mastered: a practising milestone with a "done at"
    // would let the board claim two things at once.
    return undefined;
  }
  return state;
}

/** One custom milestone, or `undefined` for a shape this build does not accept. */
export function parseCustomMilestone(raw: unknown): CustomMilestone | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  if (Object.keys(record).some((key) => !(CUSTOM_KEYS as readonly string[]).includes(key))) return undefined;

  const { id, title, createdAt, actionId, source } = record;
  if (!isOpaqueId(id, MILESTONE_ID_LIMIT) || !id.startsWith(CUSTOM_ID_PREFIX)) return undefined;
  if (typeof title !== "string") return undefined;
  const trimmedTitle = title.trim();
  if (trimmedTitle === "" || trimmedTitle.length > MILESTONE_TITLE_LIMIT || hasControlCharacter(trimmedTitle)) {
    return undefined;
  }
  if (!isIsoInstant(createdAt)) return undefined;
  if (!isOpaqueId(actionId, MILESTONE_ACTION_ID_LIMIT)) return undefined;
  if (source !== "ui" && source !== "agent") return undefined;
  const actor = parseActor(record);
  if (!actor) return undefined;

  return {
    id,
    title: trimmedTitle,
    createdAt,
    byUserId: actor.id,
    byLabel: actor.label,
    actionId,
    source,
  };
}

/**
 * A stored `app.training`: unique state ids, unique custom ids and titles, and
 * every custom state backed by a custom milestone (there is no delete path, so
 * one without its entry is a bug). A state may name a **catalog** id this build
 * no longer ships: that is the point of stable ids, and it is kept untouched.
 */
export function parseTrainingList(raw: {
  states: unknown;
  custom: unknown;
}): { states: MilestoneState[]; custom: CustomMilestone[] } | undefined {
  if (!Array.isArray(raw.custom) || !Array.isArray(raw.states)) return undefined;
  const custom: CustomMilestone[] = [];
  const customIds = new Set<string>();
  const customTitles = new Set<string>();
  for (const item of raw.custom) {
    const entry = parseCustomMilestone(item);
    if (!entry) return undefined;
    const titleKey = entry.title.trim().toLowerCase();
    // Two custom rows with one title would be indistinguishable on the board.
    // The *catalog's* titles are enforced at write time only: a future build
    // that ships an entry whose title a household already used must not turn a
    // legal document into a boot failure (the board would simply show both).
    if (customIds.has(entry.id) || customTitles.has(titleKey)) return undefined;
    customIds.add(entry.id);
    customTitles.add(titleKey);
    custom.push(entry);
  }

  const states: MilestoneState[] = [];
  const stateIds = new Set<string>();
  for (const item of raw.states) {
    const state = parseMilestoneState(item);
    if (!state || stateIds.has(state.id)) return undefined;
    if (state.id.startsWith(CUSTOM_ID_PREFIX)) {
      // There is no delete path, so a custom state without its entry is a bug.
      if (!customIds.has(state.id)) return undefined;
    } else if (!state.id.startsWith(CATALOG_ID_PREFIX)) {
      return undefined;
    }
    // A `catalog:` id this build no longer ships is kept: stable ids are why a
    // catalog edit cannot orphan a household's progress.
    stateIds.add(state.id);
    states.push(state);
  }
  return { states, custom };
}

export type MilestoneView = {
  id: string;
  title: string;
  /** Where the row comes from: the build's catalog or the household's own. */
  origin: "catalog" | "custom";
  status: MilestoneStatus;
  note?: string;
  /** Absent for a milestone nobody has touched yet. */
  updatedAt?: string;
  byLabel?: string;
  masteredAt?: string;
};

/**
 * The board: catalog entries in the build's order, then custom milestones in
 * creation order. A state whose id this build no longer knows (a removed catalog
 * entry) is kept in the document but not on the board — there is no title to
 * show, and inventing one would be worse than silence.
 */
export function milestoneView(training: Pick<Training, "states" | "custom">): MilestoneView[] {
  const states = new Map(training.states.map((state) => [state.id, state]));
  const rows: MilestoneView[] = MILESTONE_CATALOG.map((entry) => {
    const state = states.get(entry.id);
    if (state === undefined) return { id: entry.id, title: entry.title, origin: "catalog", status: "not_started" };
    return {
      id: entry.id,
      title: entry.title,
      origin: "catalog",
      status: state.status,
      ...(state.note !== undefined ? { note: state.note } : {}),
      updatedAt: state.updatedAt,
      byLabel: state.byLabel,
      ...(state.masteredAt !== undefined ? { masteredAt: state.masteredAt } : {}),
    };
  });
  for (const entry of training.custom) {
    const state = states.get(entry.id);
    if (state === undefined) {
      rows.push({ id: entry.id, title: entry.title, origin: "custom", status: "not_started" });
      continue;
    }
    rows.push({
      id: entry.id,
      title: entry.title,
      origin: "custom",
      status: state.status,
      ...(state.note !== undefined ? { note: state.note } : {}),
      updatedAt: state.updatedAt,
      byLabel: state.byLabel,
      ...(state.masteredAt !== undefined ? { masteredAt: state.masteredAt } : {}),
    });
  }
  return rows;
}
