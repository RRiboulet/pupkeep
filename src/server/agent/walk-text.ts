// The walk domain's model-facing copy (PLAN §9.5, §10.1, §10.3).
//
// Kept beside `feed-text.ts` for the same reason: the overview tool renders the
// open walk without importing another extension's registration module, and the
// walk tools render the committed record. Free text — a caregiver's label, the
// dogs met, the mood, a note — is JSON-quoted, so a crafted value stays data.
//
// Durations are computed from the two stored instants and the server clock; the
// model never converts a timestamp itself.

import type { Walk } from "../../shared/domain.ts";
import { WALK_STALE_AFTER_MS, walkIsStale } from "../../shared/walks.ts";
import { localTimeAt } from "../domain/time.ts";

function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
}

/** "35 minutes", "2 hours 5 minutes", "under a minute". */
export function durationText(minutes: number): string {
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourText = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return rest === 0 ? hourText : `${hourText} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

/** The observations as one quoted clause, or "" when nothing was noted. */
function observationsText(walk: Walk): string {
  const parts: string[] = [];
  if (walk.pee !== undefined) parts.push(`${walk.pee} pee`);
  if (walk.poop !== undefined) parts.push(`${walk.poop} poop`);
  if (walk.dogsMet !== undefined) parts.push(`dogs met ${JSON.stringify(walk.dogsMet)}`);
  if (walk.mood !== undefined) parts.push(`mood ${JSON.stringify(walk.mood)}`);
  if (walk.notes !== undefined) parts.push(`notes ${JSON.stringify(walk.notes)}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/** The open walk as `get_context` reports it: who, since when, and its state. */
export function openWalkText(walk: Walk | undefined, now: Date, timezone: string): string {
  if (!walk) return "Walk: none open";
  const since = localTimeAt(new Date(walk.startedAt), timezone);
  const stale = walkIsStale(walk, now) ? ` — stale (open over ${WALK_STALE_AFTER_MS / 3_600_000} hours)` : "";
  return `Walk: open, started by ${JSON.stringify(walk.startedByLabel)} at ${since} (${durationText(
    minutesBetween(walk.startedAt, now.toISOString()),
  )} ago)${stale}`;
}

/** A committed end/discard as the walk tool reports it. */
export function walkCloseText(walk: Walk, timezone: string): string {
  const started = localTimeAt(new Date(walk.startedAt), timezone);
  if (walk.discarded) {
    return `Discarded: the walk started by ${JSON.stringify(walk.startedByLabel)} at ${started}, thrown away as stale.`;
  }
  const minutes = minutesBetween(walk.startedAt, walk.endedAt ?? walk.startedAt);
  const ended = walk.endedAt === undefined ? "" : `, ended at ${localTimeAt(new Date(walk.endedAt), timezone)}`;
  return `Ended: a walk by ${JSON.stringify(walk.startedByLabel)} at ${started}${ended} — ${durationText(
    minutes,
  )}${observationsText(walk)}.`;
}

/** A freshly started walk as the tool reports it. */
export function walkStartText(walk: Walk, timezone: string): string {
  return `Started: a walk by ${JSON.stringify(walk.startedByLabel)} at ${localTimeAt(
    new Date(walk.startedAt),
    timezone,
  )}.`;
}
