// `app.walks` and its invariants (PLAN §8.3, §7.3, §8.5, §9.5).
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

import type { Walk, Walks } from "./domain.ts";
import { isIsoInstant } from "./domain.ts";
import { HOUSEHOLD_FALLBACK_LABEL } from "./chat.ts";
import { hasControlCharacter } from "./profile.ts";

/** §8.5: an open walk older than this is stale and needs a resolution. */
export const WALK_STALE_AFTER_MS = 8 * 60 * 60 * 1000;

/** Same bounds as a feed event: an opaque id from the same charset. */
export const WALK_ID_LIMIT = 64;
/** Matches `COMMAND_KEY_LIMIT`: `http:<key>` or `tool:<taskId>`. */
export const WALK_ACTION_ID_LIMIT = 120;
/** A walk's observations are one line each; a diary is not a walk record. */
export const WALK_DOGS_MET_LIMIT = 120;
export const WALK_MOOD_LIMIT = 40;
export const WALK_NOTES_LIMIT = 280;
/** Counts are small; a typo of 1000 is refused without a schema question. */
export const WALK_COUNT_LIMIT = 20;

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

/** One walk, or `undefined` for a shape this build does not accept. */
export function parseWalk(raw: unknown): Walk | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(WALK_KEYS as readonly string[]).includes(key))) return undefined;

  const { id, startedAt, startedActionId, startedBy } = record;
  if (typeof id !== "string" || id.length === 0 || id.length > WALK_ID_LIMIT) return undefined;
  if (!isIsoInstant(startedAt)) return undefined;
  if (
    typeof startedActionId !== "string" ||
    startedActionId.length === 0 ||
    startedActionId.length > WALK_ACTION_ID_LIMIT
  ) {
    return undefined;
  }
  const startedLabel = displayText(record.startedByLabel);
  if (startedLabel === undefined) return undefined;
  let startedId: string | null;
  if (startedBy === null) startedId = null;
  else {
    const id = displayText(startedBy);
    if (id === undefined) return undefined;
    startedId = id;
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
    endActionId.length > WALK_ACTION_ID_LIMIT
  ) {
    return undefined;
  }
  const endedLabel = displayText(record.endedByLabel);
  if (endedLabel === undefined) return undefined;
  let endedId: string | null;
  if (endedBy === null) endedId = null;
  else {
    const id = displayText(endedBy);
    if (id === undefined) return undefined;
    endedId = id;
  }
  if (endedId === null && endedLabel !== HOUSEHOLD_FALLBACK_LABEL) return undefined;

  walk.endedAt = endedAt;
  walk.endActionId = endActionId;
  walk.endedBy = endedId;
  walk.endedByLabel = endedLabel;

  const pee = count(record.pee);
  if (pee === undefined) return undefined;
  if (pee !== null) walk.pee = pee;
  const poop = count(record.poop);
  if (poop === undefined) return undefined;
  if (poop !== null) walk.poop = poop;
  const dogsMet = cleanText(record.dogsMet, WALK_DOGS_MET_LIMIT);
  if (dogsMet === undefined) return undefined;
  if (dogsMet !== null) walk.dogsMet = dogsMet;
  const mood = cleanText(record.mood, WALK_MOOD_LIMIT);
  if (mood === undefined) return undefined;
  if (mood !== null) walk.mood = mood;
  const notes = cleanText(record.notes, WALK_NOTES_LIMIT);
  if (notes === undefined) return undefined;
  if (notes !== null) walk.notes = notes;
  return walk;
}

/**
 * A stored walk list. Zero walks is valid (a fresh household); a repeated id or
 * a second open walk is not — the service refuses those long before a write, so
 * seeing one here is a bug that must fail boot rather than be repaired.
 */
export function parseWalks(raw: unknown): Walk[] | undefined {
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

/**
 * §8.5: an unfed-in-eight-hours walk is stale. The predicate takes the clock so
 * a caller (and a test) never guesses it; an ended walk is never stale.
 */
export function walkIsStale(walk: Walk, now: Date): boolean {
  if (walk.endedAt !== undefined) return false;
  return now.getTime() - Date.parse(walk.startedAt) >= WALK_STALE_AFTER_MS;
}
