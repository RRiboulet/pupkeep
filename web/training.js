// The milestone board's pure half (PLAN §13.1, §13.2, §16 P3-05).
//
// The board is grouped by status and driven by the same writer the agent uses.
// This module holds the parts a Node test can pin without a browser: the group
// order and labels, the request bodies (including the one distinction that
// matters — an absent note keeps it, an empty note clears it), and the one-line
// meta under a row. The view in `views/milestones.js` turns these into elements.
//
// It imports no Preact and touches no DOM, like `meals.js`, `walks.js` and
// `growth-chart.js`. Dates go through `clock.js`, the one household-local
// formatter the shell shares, so a milestone mastered at 00:30 in Paris reads
// as that day — never as the UTC date of the stored instant.

import { localDate as clockDate, localTimeText } from "./clock.js";

/** The document's caps, mirrored here because the shell has no build step. */
export const NOTE_MAX = 280;
export const TITLE_MAX = 60;

export const STATUS_LABELS = {
  mastered: "Mastered",
  practicing: "Practicing",
  not_started: "Not started",
};

/** Mastered first, then what is in progress, then the untouched checklist. */
export const BOARD_GROUPS = ["mastered", "practicing", "not_started"];

/** The board's rows grouped for display, each group in the server's row order. */
export function boardGroups(rows) {
  return BOARD_GROUPS.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    rows: (rows ?? []).filter((row) => row.status === status),
  }));
}

/** Setting only a status: the note is deliberately absent, so it is kept. */
export function statusUpdate(row, status) {
  return { milestoneId: row.id, status };
}

/**
 * Setting only a note. An empty (or whitespace) note clears it — the one place
 * the wire needs an explicit `null`, because an absent key would mean "keep".
 */
export function noteUpdate(row, text) {
  const trimmed = String(text ?? "").trim();
  return { milestoneId: row.id, note: trimmed === "" ? null : trimmed };
}

/** A new milestone's body. */
export function customMilestone(title) {
  return { title: String(title ?? "").trim() };
}

function whenText(instant, timezone) {
  if (typeof instant !== "string") return "";
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return "";
  // A stored instant is UTC; a caregiver reads the household's zone (§8.4).
  return timezone ? `${clockDate(at, timezone)} ${localTimeText(instant, timezone)}` : "";
}

/**
 * The one line under a row's title: who mastered it and when, who last changed
 * it, or its note. Free text is shown as-is in the DOM (the browser escapes it);
 * this is display copy, not model context.
 */
export function rowMetaText(row, timezone) {
  if (row.status === "mastered" && row.masteredAt) {
    const by = row.byLabel ? ` by ${row.byLabel}` : "";
    return `mastered ${whenText(row.masteredAt, timezone)}${by}`.trimEnd();
  }
  if (row.updatedAt) {
    return `changed ${whenText(row.updatedAt, timezone)}${row.byLabel ? ` by ${row.byLabel}` : ""}`.trimEnd();
  }
  return "";
}
