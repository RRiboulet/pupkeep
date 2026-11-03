// `app.walks` and its invariants (PLAN §8.3, §7.3, §8.5, §9.2, §9.5).
//
// The document holds the open walk and the history. What this module fixes:
//
//   * **one open walk per household** — at most one record without `endedAt`,
//     checked as a document invariant so a stored second open walk fails boot
//     rather than being repaired silently (the service refuses the second start
//     long before that);
//   * **server timestamps** — `startedAt`/`endedAt` are UTC instants from the
//     server clock; a device's skew never enters the record (§8.4);
//   * **`endedAt` after `startedAt`** — a duration can be zero but never
//     negative, whatever a clock jump does to the rest of the app;
//   * **the §9.2 pairing** — a `null` actor id always travels with the household
//     label (the parser refuses the impossible pair, exactly as the feed
//     document's does; the writers never produce the reverse);
//   * **stale, never auto-closed** — §8.5 makes a walk stale after eight hours;
//     this module exposes the predicate, and the record keeps the real
//     timestamps so the UI clamps the *displayed* duration instead.
//
// `actionId` uniqueness is deliberately **not** a document rule, exactly as for
// feed events: the key is 24 h-scoped in `app.commands` (§7.3), so a reused key
// must not make `app.walks` unreadable — the service answers it.
//
// The caregiver-facing sentences for the refusals live here too, so the HTTP
// route and the agent tool (P2-07) render one copy instead of retyping it.

import type { Walk, Walks } from "./domain.ts";
import { OPAQUE_ID_PATTERN, isIsoInstant } from "./domain.ts";
import { HOUSEHOLD_FALLBACK_LABEL } from "./chat.ts";
import { hasControlCharacter } from "./profile.ts";

/** §8.5: an open walk older than this is stale and needs a resolution. */
export const WALK_STALE_AFTER_MS = 8 * 60 * 60 * 1000;

/** Same bounds and charset as a feed event: an opaque id. */
export const WALK_ID_LIMIT = 64;
/** Matches `COMMAND_KEY_LIMIT`: `http:<key>` or `tool:<taskId>`. */
export const WALK_ACTION_ID_LIMIT = 120;
/** A walk's observations are one line each; a diary is not a walk record. */
export const WALK_DOGS_MET_LIMIT = 120;
export const WALK_MOOD_LIMIT = 40;
export const WALK_NOTES_LIMIT = 280;
/** Counts are small; a typo of 1000 is refused without a schema question. */
export const WALK_COUNT_LIMIT = 20;

/**
 * The one sentence a refused observation answers with. Shared rather than
 * retyped in the route and the tool, like `MEAL_SCHEDULE_RULE`.
 */
export const WALK_OBSERVATION_RULE =
  "a walk's observations are optional: pee and poop are counts from 0 to 20, dogs met up to 120 characters, mood up to 40, notes up to 280, and everything is one line";

/** There is no open walk to end (and no ended walk to explain it). */
export const WALK_NONE_OPEN_MESSAGE = "there is no open walk to end";

const WALK_KEYS = [
  "id",
  "startedAt",
  "endedAt",
  "startedActionId",
  "endActionId",
  "startedBy",
  "startedByLabel",
  "endedBy",
  "endedByLabel",
  "pee",
  "poop",
  "dogsMet",
  "mood",
  "notes",
] as const;

const END_KEYS = ["endActionId", "endedAt", "endedBy", "endedByLabel", "pee", "poop", "dogsMet", "mood", "notes"] as const;
const OBSERVATION_KEYS = ["pee", "poop", "dogsMet", "mood", "notes"] as const;

/** What a caregiver fills in when ending a walk; absent fields are "not noted". */
export type WalkObservations = {
  pee?: number;
  poop?: number;
  dogsMet?: string;
  mood?: string;
  notes?: string;
};

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

function count(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > WALK_COUNT_LIMIT) {
    return undefined;
  }
  return value;
}

/**
 * The observations of one end, normalised once: trimmed text, empty as absent,
 * counts as counts. The service hashes this result, so a retry of the *same*
 * observations (padded, empty-string, or absent) is the same request — the
 * `logFeed` rule (§7.3) applied to a walk.
 *
 * An unknown key is refused rather than dropped: a client typo must be visible,
 * not silently lost. A newline is a control character, so observations are one
 * line by design.
 */
export function parseWalkObservations(raw: unknown): WalkObservations | undefined {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(OBSERVATION_KEYS as readonly string[]).includes(key))) return undefined;

  const observations: WalkObservations = {};
  const pee = count(record.pee);
  if (pee === undefined) return undefined;
  if (pee !== null) observations.pee = pee;
  const poop = count(record.poop);
  if (poop === undefined) return undefined;
  if (poop !== null) observations.poop = poop;
  const dogsMet = cleanText(record.dogsMet, WALK_DOGS_MET_LIMIT);
  if (dogsMet === undefined) return undefined;
  if (dogsMet !== null) observations.dogsMet = dogsMet;
  const mood = cleanText(record.mood, WALK_MOOD_LIMIT);
  if (mood === undefined) return undefined;
  if (mood !== null) observations.mood = mood;
  const notes = cleanText(record.notes, WALK_NOTES_LIMIT);
  if (notes === undefined) return undefined;
  if (notes !== null) observations.notes = notes;
  return observations;
}

/** One walk, or `undefined` for a shape this build does not accept. */
export function parseWalk(raw: unknown): Walk | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(WALK_KEYS as readonly string[]).includes(key))) return undefined;

  const { id, startedAt, startedActionId, startedBy } = record;
  if (typeof id !== "string" || id.length === 0 || id.length > WALK_ID_LIMIT || !OPAQUE_ID_PATTERN.test(id)) {
    return undefined;
  }
  if (!isIsoInstant(startedAt)) return undefined;
  if (
    typeof startedActionId !== "string" ||
    startedActionId.length === 0 ||
    startedActionId.length > WALK_ACTION_ID_LIMIT ||
    !OPAQUE_ID_PATTERN.test(startedActionId)
  ) {
    return undefined;
  }
  const startedLabel = displayText(record.startedByLabel);
  if (startedLabel === undefined) return undefined;
  let startedId: string | null;
  if (startedBy === null) startedId = null;
  else {
    const rawId = displayText(startedBy);
    if (rawId === undefined) return undefined;
    startedId = rawId;
  }
  // §9.2's fence: no id always travels with the household label.
  if (startedId === null && startedLabel !== HOUSEHOLD_FALLBACK_LABEL) return undefined;

  const walk: Walk = {
    id,
    startedAt,
    startedActionId,
    startedBy: startedId,
    startedByLabel: startedLabel,
  };

  const endedAt = record.endedAt;
  if (endedAt === undefined) {
    // An open walk carries none of the end fields.
    if (END_KEYS.some((key) => record[key] !== undefined)) return undefined;
    return walk;
  }
  if (!isIsoInstant(endedAt) || Date.parse(endedAt) < Date.parse(startedAt)) return undefined;

  const { endActionId, endedBy } = record;
  if (
    typeof endActionId !== "string" ||
    endActionId.length === 0 ||
    endActionId.length > WALK_ACTION_ID_LIMIT ||
    !OPAQUE_ID_PATTERN.test(endActionId)
  ) {
    return undefined;
  }
  const endedLabel = displayText(record.endedByLabel);
  if (endedLabel === undefined) return undefined;
  let endedId: string | null;
  if (endedBy === null) endedId = null;
  else {
    const rawId = displayText(endedBy);
    if (rawId === undefined) return undefined;
    endedId = rawId;
  }
  if (endedId === null && endedLabel !== HOUSEHOLD_FALLBACK_LABEL) return undefined;

  walk.endedAt = endedAt;
  walk.endActionId = endActionId;
  walk.endedBy = endedId;
  walk.endedByLabel = endedLabel;
  // Only the observation keys: `parseWalkObservations` refuses unknown keys, so
  // it is handed its own subset rather than the whole walk record.
  const observations: Record<string, unknown> = {};
  for (const key of OBSERVATION_KEYS) {
    if (record[key] !== undefined) observations[key] = record[key];
  }
  const parsedObservations = parseWalkObservations(observations);
  if (!parsedObservations) return undefined;
  Object.assign(walk, parsedObservations);
  return walk;
}

/**
 * A stored walk list. Zero walks is valid (a fresh household); a repeated id or
 * a second open walk is not — the service refuses those long before a write, so
 * seeing one here is a bug that must fail boot rather than be repaired.
 */
export function parseWalkList(raw: unknown): Walk[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const walks: Walk[] = [];
  const ids = new Set<string>();
  let open = false;
  for (const item of raw) {
    const walk = parseWalk(item);
    if (!walk) return undefined;
    if (ids.has(walk.id)) return undefined;
    if (walk.endedAt === undefined) {
      if (open) return undefined;
      open = true;
    }
    ids.add(walk.id);
    walks.push(walk);
  }
  return walks;
}

/** The open walk, if the household has one. At most one, by the parser above. */
export function openWalk(walks: readonly Walk[]): Walk | undefined {
  return walks.find((walk) => walk.endedAt === undefined);
}

/** The most recently ended walk, for explaining a lost end race (§7.3). */
export function lastEndedWalk(walks: readonly Walk[]): Walk | undefined {
  let latest: Walk | undefined;
  for (const walk of walks) {
    if (walk.endedAt === undefined) continue;
    if (latest === undefined || Date.parse(walk.endedAt) >= Date.parse(latest.endedAt!)) latest = walk;
  }
  return latest;
}

/**
 * §8.5: an unfed-in-eight-hours walk is stale. The predicate takes the clock so
 * a caller (and a test) never guesses it; an ended walk is never stale.
 */
export function walkIsStale(walk: Walk, now: Date): boolean {
  if (walk.endedAt !== undefined) return false;
  return now.getTime() - Date.parse(walk.startedAt) >= WALK_STALE_AFTER_MS;
}

/** The one 409 sentence for a start blocked by an open (or stale) walk. */
export function walkOpenMessage(walk: Walk, stale: boolean): string {
  return stale
    ? `${JSON.stringify(walk.startedByLabel)} left a walk open over ${WALK_STALE_AFTER_MS / 3_600_000} hours ago; end it before starting another`
    : `${JSON.stringify(walk.startedByLabel)} is already walking; end that walk before starting another`;
}

/** The one 409 sentence for an end that lost the race (§7.3: who/when). */
export function walkEndedMessage(walk: Walk): string {
  const when = walk.endedAt === undefined ? "already" : `at ${walk.endedAt}`;
  return `${JSON.stringify(walk.endedByLabel ?? walk.startedByLabel)} already ended this walk ${when}`;
}

export type { Walks };
