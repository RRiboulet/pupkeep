// The shower card's pure half (PLAN §13.1, §13.2, §16 P3-07).
//
// The card logs a shower through the same writer the agent uses and reports
// state — the last shower, the next due date and the recent history. It gives no
// advice: the due date is P3-06's derived date, the copy is app-built.
//
// This module holds the parts a Node test can pin without a browser: the
// "recent few" cap (the history is unbounded), the request body, and the
// household-local copy for a due date. Dates arrive as `YYYY-MM-DD` strings that
// were already computed in the household zone by the server, so nothing here
// re-derives one from an instant or from the device's zone (§8.4).
//
// It imports no Preact and touches no DOM, like `meals.js`, `walks.js`,
// `growth-chart.js` and `training.js`.

import { localTimeText } from "./clock.js";

/** The document's caps, mirrored here because the shell has no build step. */
export const SHAMPOO_MAX = 80;
export const NOTES_MAX = 280;

/** The card shows the recent few; the history itself is a count, not a list. */
export const RECENT_SHOWERS = 5;

/**
 * One formatter for a stored local date. `Date.UTC` plus a UTC formatter reads
 * the three numbers back unchanged: formatting `new Date("2026-11-15")` in a
 * zone behind UTC would otherwise show the 14th.
 */
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** `2026-11-15` → `15 Nov 2026`; an unparseable value is shown as it arrived. */
export function dateText(localDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(localDate ?? ""));
  if (match === null) return String(localDate ?? "");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(at.getTime())) return String(localDate);
  return DATE_FORMAT.format(at);
}

/**
 * The request body. Both fields are optional, so an empty draft is a valid
 * shower — the primary action is "log a shower", the details are extra. Text is
 * trimmed once, so a retried draft with padded text replays under the same key.
 */
export function showerBody(draft) {
  const body = {};
  const shampoo = String(draft?.shampoo ?? "").trim();
  const notes = String(draft?.notes ?? "").trim();
  if (shampoo !== "") body.shampoo = shampoo;
  if (notes !== "") body.notes = notes;
  return body;
}

/** The recent few, newest first (the server already sorted the history). */
export function recentShowers(history, max = RECENT_SHOWERS) {
  return (history ?? []).slice(0, max);
}

/** How many older showers the card is not showing. */
export function earlierCount(history, max = RECENT_SHOWERS) {
  return Math.max(0, (history ?? []).length - max);
}

/** "every 21 days", the server setting's own phrasing. */
export function intervalText(days) {
  if (!Number.isFinite(days)) return "";
  const whole = Math.round(days);
  return whole === 1 ? "every day" : `every ${whole} days`;
}

/**
 * The next-due sentence in household-local terms. "Due today", "overdue" and
 * "in N days" are P3-06's one `daysUntilDue` comparison, never a second
 * arithmetic on the card.
 */
export function dueText(status) {
  if (!status || status.nextDue === null || status.daysUntilDue === null) {
    return "No showers logged yet.";
  }
  const due = dateText(status.nextDue);
  if (status.daysUntilDue === 0) return `Next due ${due} — due today.`;
  if (status.daysUntilDue < 0) {
    const days = -status.daysUntilDue;
    return `Next due ${due} — ${days} day${days === 1 ? "" : "s"} overdue.`;
  }
  return `Next due ${due} — in ${status.daysUntilDue} day${status.daysUntilDue === 1 ? "" : "s"}.`;
}

/** "Last shower 10 Oct 2026 by Alex." — empty when nothing was logged yet. */
export function lastShowerText(status) {
  const last = status?.last;
  if (!last) return "";
  const by = last.byLabel ? ` by ${last.byLabel}` : "";
  return `Last shower ${dateText(last.localDate)}${by}.`;
}

/**
 * The one line under a shower: who logged it, and the household-local time of
 * the stored instant. The date itself is the stored local date, not re-derived.
 */
export function rowMetaText(row, timezone) {
  const parts = [];
  if (row?.byLabel) parts.push(`by ${row.byLabel}`);
  if (typeof row?.at === "string") {
    const at = new Date(row.at);
    if (!Number.isNaN(at.getTime())) parts.push(`at ${localTimeText(row.at, timezone)}`);
  }
  return parts.join(" ");
}
