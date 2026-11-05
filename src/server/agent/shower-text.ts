// The shower surface's model-facing copy (PLAN §9.5, §10.1, §10.3, §16 P3-07).
//
// Kept out of `shower-tools.ts` so the context tool can render the one-line
// summary without importing another extension's registration module, exactly as
// `feed-text.ts`, `growth-text.ts` and `training-text.ts` do. Two rules run
// through the copy:
//
//   * every date is the household-local calendar date P3-06 stored with the
//     record, never a UTC re-derivation; a stored instant is rendered in the
//     household zone, never the host's or the device's (§8.4);
//   * free text a caregiver wrote (shampoo, note, label) is JSON-quoted, so a
//     crafted value stays visibly data in the model's context (§9.5).
//
// The copy reports state and nothing else: no advice, no schedule coaching
// (P3-07's guardrail). "Due" is P3-06's one comparison — `daysUntilDue <= 0` —
// so the model and the card cannot disagree about it.

import type { ShowerStatus, ShowerView } from "../../shared/showers.ts";
import { localTimeAt } from "../domain/time.ts";

/** Enough rows for a context bound; the list is unbounded (P3-07's note). */
const MAX_ROWS = 20;

/** "every 21 days", the one phrasing of the household's interval. */
export function showerIntervalText(intervalDays: number): string {
  return intervalDays === 1 ? "every day" : `every ${intervalDays} days`;
}

/**
 * The due date in the household's own calendar terms: the stored `YYYY-MM-DD`
 * plus the signed day count P3-06 derived. Never re-formatted from an instant,
 * so a due date cannot move a day across a zone or a DST change.
 */
function duePhrase(status: ShowerStatus): string {
  if (status.nextDue === null || status.daysUntilDue === null) return "";
  if (status.daysUntilDue === 0) return `next due ${status.nextDue} (due today)`;
  if (status.daysUntilDue < 0) {
    const days = -status.daysUntilDue;
    return `next due ${status.nextDue} (${days} day${days === 1 ? "" : "s"} overdue)`;
  }
  return `next due ${status.nextDue} (in ${status.daysUntilDue} day${status.daysUntilDue === 1 ? "" : "s"})`;
}

/** The status line every shower answer carries. */
export function showerStatusText(view: ShowerView): string {
  const interval = `Interval: ${showerIntervalText(view.intervalDays)}.`;
  const { last } = view.status;
  if (last === null) return `Showers: none logged yet. ${interval}`;
  return (
    `Showers: last ${last.localDate} by ${JSON.stringify(last.byLabel)}, ` +
    `${duePhrase(view.status)}. ${interval}`
  );
}

/** `2026-10-10 08:00` in the household zone, never a raw UTC instant. */
function showerWhenText(shower: ShowerView["history"][number], timezone: string): string {
  return `${shower.localDate} ${localTimeAt(new Date(shower.at), timezone)}`;
}

function showerRowText(shower: ShowerView["history"][number], timezone: string): string {
  const parts = [showerWhenText(shower, timezone), `by ${JSON.stringify(shower.byLabel)}`];
  if (shower.shampoo !== undefined) parts.push(`shampoo ${JSON.stringify(shower.shampoo)}`);
  if (shower.notes !== undefined) parts.push(`note ${JSON.stringify(shower.notes)}`);
  return parts.join(", ");
}

/**
 * The status and the history, newest first, bounded: `list_showers` answers with
 * this. The whole history is never printed, so a long-lived household cannot
 * grow the model's context without limit (P3-07's carried note).
 */
export function showerReportText(view: ShowerView, timezone: string): string {
  const lines = [showerStatusText(view)];
  if (view.history.length === 0) {
    lines.push("History: none yet.");
    return lines.join("\n");
  }
  lines.push("History (newest first):");
  const shown = view.history.slice(0, MAX_ROWS);
  for (const shower of shown) lines.push(`  ${showerRowText(shower, timezone)}`);
  const earlier = view.history.length - shown.length;
  if (earlier > 0) lines.push(`and ${earlier} earlier shower${earlier === 1 ? "" : "s"}`);
  return lines.join("\n");
}

/**
 * One line for `get_context` (§10.1): the last shower, the next due date and
 * the interval, so the model can answer "when is the next shower" without the
 * history.
 */
export function showerSummaryText(view: ShowerView): string {
  const interval = showerIntervalText(view.intervalDays);
  const { last } = view.status;
  if (last === null) return `Showers: none logged yet (${interval})`;
  return `Showers: last ${last.localDate}, ${duePhrase(view.status)}, ${interval}`;
}
