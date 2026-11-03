// The feeding domain's model-facing copy (PLAN §9.5, §10.1, §10.3).
//
// Kept out of `feed-tools.ts` so the overview tool can render today's meals
// without importing another extension's registration module: both import this
// pure renderer downward, and P2-07's walk copy can follow the same shape.
//
// Two rules run through every line:
//   * caregiver free text (a slot label, an amount, a note, a name) is
//     JSON-quoted, so a crafted value stays visibly data (§9.5);
//   * a meal the document holds is never silently omitted: a slot with no feed
//     says "not fed", and a feed filed against a slot that has since left the
//     schedule is listed as such (events are authoritative, slots are a view).

import type { FeedEvent } from "../../shared/domain.ts";
import type { FeedingDay } from "../../shared/feeding.ts";
import { localTimeAt } from "../domain/time.ts";

/** Extras are listed; past this many the newest are kept and the tail counted. */
const MAX_EXTRA_LINES = 20;
/** Feeds filed against a slot no longer in the schedule; same idea. */
const MAX_HISTORICAL_LINES = 20;

export function mealText(event: FeedEvent, timezone: string): string {
  const parts = [`at ${localTimeAt(new Date(event.at), timezone)}`];
  if (event.amount) parts.push(JSON.stringify(event.amount));
  if (event.note) parts.push(`note ${JSON.stringify(event.note)}`);
  return parts.join(", ");
}

function slotText(entry: FeedingDay["slots"][number], timezone: string): string {
  // The id is what `log_feeding` needs; the label and time are what a caregiver
  // reads. Both appear, so the model never has to guess an id from a label.
  const label = `id ${JSON.stringify(entry.slot.id)}, ${JSON.stringify(entry.slot.label)} (${entry.slot.timeLocal})`;
  if (entry.feed === null) return `${label}: not fed`;
  return `${label}: fed by ${JSON.stringify(entry.feed.byLabel)}, ${mealText(entry.feed, timezone)}`;
}

/**
 * The day's events under a slot that is no longer active or in the schedule.
 * `feedingDay`'s `slots` and `extras` cannot show these, and dropping them would
 * let a logged meal disappear from the answer — the failure mode this formatter
 * exists to prevent.
 */
function historicalText(day: FeedingDay, timezone: string): string[] {
  const active = new Set(day.slots.map((entry) => entry.slot.id));
  const orphaned = day.events.filter((event) => event.slotId !== null && !active.has(event.slotId));
  const shown = orphaned.slice(-MAX_HISTORICAL_LINES);
  const lines = shown.map(
    (event) =>
      `filed against meal time ${JSON.stringify(event.slotId)} (no longer in the schedule): ` +
      `fed by ${JSON.stringify(event.byLabel)}, ${mealText(event, timezone)}`,
  );
  const more = orphaned.length - shown.length;
  if (more > 0) lines.unshift(`and ${more} earlier meals for meal times no longer in the schedule`);
  return lines;
}

/** One day as the model reads it; empty schedule and empty day are distinct. */
export function feedingDayText(day: FeedingDay, today: string, timezone: string): string {
  const history = historicalText(day, timezone);
  if (day.slots.length === 0 && day.extras.length === 0 && history.length === 0) return "no meal schedule yet";
  const lines = day.slots.map((entry) => slotText(entry, timezone));
  const extras = day.extras.slice(-MAX_EXTRA_LINES);
  for (const extra of extras) {
    lines.push(`extra feeding: ${JSON.stringify(extra.byLabel)}, ${mealText(extra, timezone)}`);
  }
  const moreExtras = day.extras.length - extras.length;
  if (moreExtras > 0) lines.push(`and ${moreExtras} earlier extra feedings`);
  lines.push(...history);
  const suffix = day.localDate === today ? "today" : `not today (today is ${today})`;
  return `(${suffix}, ${timezone}) ${lines.join("; ")}`;
}

/** One committed feed as the log tools report it; the slot is the event's, not the arguments'. */
export function feedWriteText(
  event: FeedEvent,
  replayed: boolean,
  day: FeedingDay,
  timezone: string,
): string {
  const prefix = replayed ? "Already logged" : "Logged";
  if (event.slotId === null) {
    return `${prefix}: an extra feeding on ${event.localDate} ${mealText(event, timezone)}, by ${JSON.stringify(event.byLabel)}.`;
  }
  const slot = day.slots.find((entry) => entry.slot.id === event.slotId)?.slot;
  const what =
    slot === undefined
      ? `meal time ${JSON.stringify(event.slotId)} (no longer in the schedule)`
      : JSON.stringify(slot.label);
  return `${prefix}: ${what} on ${event.localDate} ${mealText(event, timezone)}, by ${JSON.stringify(event.byLabel)}.`;
}
