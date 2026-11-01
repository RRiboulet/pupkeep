// `app.activity`: the last N human-readable events (PLAN §8.1).
//
// The rule the plan repeats is that these entries are built by domain functions,
// never by the model: the agent may *cause* an event, but the sentence and the
// actor label come from the same code path the HTTP route uses. That is what
// makes the activity feed trustworthy for a caregiver who was not looking.

import { randomUUID } from "node:crypto";
import type { Activity, ActivityEntry } from "../../shared/domain.ts";

/** PLAN §8.1: the activity document keeps its last 200 entries. */
export const ACTIVITY_LIMIT = 200;

export interface ActivityInput {
  readonly kind: string;
  readonly summary: string;
  /** Config member id, or `null` for the household fallback (§9.2). */
  readonly actorId: string | null;
  readonly actorLabel: string;
  readonly now: Date;
  /** Injected in tests; a fresh uuid otherwise. */
  readonly id?: string;
}

export function activityEntry(input: ActivityInput): ActivityEntry {
  return {
    id: input.id ?? randomUUID(),
    at: input.now.toISOString(),
    kind: input.kind,
    summary: input.summary,
    actorId: input.actorId,
    actorLabel: input.actorLabel,
  };
}

/**
 * Append one entry and keep the newest `limit`, oldest first. A draft is only
 * usable inside its commit, so this replaces the whole array rather than
 * mutating it in place.
 */
export function appendActivity(
  activity: Activity,
  entry: ActivityEntry,
  limit = ACTIVITY_LIMIT,
): ActivityEntry[] {
  const entries = [...activity.entries, entry].slice(-limit);
  activity.entries = entries;
  return entries;
}

/** The newest `limit` entries, newest first — what `get_context` shows. */
export function recentActivity(activity: Activity, limit = 10): ActivityEntry[] {
  return activity.entries.slice(-limit).reverse();
}
