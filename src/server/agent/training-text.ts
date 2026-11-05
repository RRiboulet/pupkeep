// The milestone board's model-facing copy (PLAN §9.5, §10.1, §10.3).
//
// Kept out of `training-tools.ts` so the context tool can render the one-line
// summary without importing another extension's registration module, exactly as
// `feed-text.ts` and `growth-text.ts` do. Two rules run through the copy:
//
//   * a milestone id is what `update_milestone` needs, so every line carries it
//     next to the title — the model never has to guess an id from a title;
//   * titles, notes and labels are caregiver data: JSON-quoted, so a crafted
//     value stays visibly data in the model's context (§9.5).
//
// The board is grouped by status, in the `app.training` view's own order inside
// each group (the catalog's reading order, then the household's own).

import type { MilestoneView } from "../../shared/training.ts";
import { localDateAt, localTimeAt } from "../domain/time.ts";

/** The board's group order and labels; the one place either is written server-side. */
const GROUPS: ReadonlyArray<{ status: MilestoneView["status"]; label: string }> = [
  { status: "mastered", label: "Mastered" },
  { status: "practicing", label: "Practicing" },
  { status: "not_started", label: "Not started" },
];

/** Enough rows for a context bound; the catalog plus ordinary customs is far smaller. */
const MAX_ROWS = 40;

function counts(rows: readonly MilestoneView[]): { total: number; mastered: number; practicing: number } {
  return {
    total: rows.length,
    mastered: rows.filter((row) => row.status === "mastered").length,
    practicing: rows.filter((row) => row.status === "practicing").length,
  };
}

/** `2026-10-30 08:00` in the household zone, never a raw UTC instant. */
function instantText(instant: string, timezone: string): string {
  const at = new Date(instant);
  return `${localDateAt(at, timezone)} ${localTimeAt(at, timezone)}`;
}

function rowText(row: MilestoneView, timezone: string): string {
  const parts = [`id ${JSON.stringify(row.id)}`, JSON.stringify(row.title)];
  if (row.origin === "custom") parts.push("(household's own)");
  if (row.note !== undefined) parts.push(`note ${JSON.stringify(row.note)}`);
  if (row.status === "mastered" && row.masteredAt !== undefined) {
    parts.push(
      `mastered ${instantText(row.masteredAt, timezone)}${
        row.byLabel === undefined ? "" : ` by ${JSON.stringify(row.byLabel)}`
      }`,
    );
  } else if (row.byLabel !== undefined && row.updatedAt !== undefined) {
    parts.push(`changed ${instantText(row.updatedAt, timezone)} by ${JSON.stringify(row.byLabel)}`);
  }
  return parts.join(", ");
}

/** The board grouped by status, with the counts and every id `update_milestone` needs. */
export function trainingBoardText(rows: readonly MilestoneView[], timezone: string): string {
  const { total, mastered, practicing } = counts(rows);
  const lines = [`Milestones: ${mastered} of ${total} mastered, ${practicing} practicing.`];
  let printed = 0;
  let truncated = false;
  for (const group of GROUPS) {
    const members = rows.filter((row) => row.status === group.status);
    if (members.length === 0) continue;
    if (printed >= MAX_ROWS) {
      truncated = true;
      break;
    }
    lines.push(`${group.label}:`);
    for (const row of members) {
      if (printed >= MAX_ROWS) {
        truncated = true;
        break;
      }
      lines.push(`  ${rowText(row, timezone)}`);
      printed += 1;
    }
    if (truncated) break;
  }
  if (truncated) lines.push(`and ${total - printed} more`);
  return lines.join("\n");
}

/**
 * One line for `get_context` (§10.1): the counts and up to three practicing
 * titles, so the model can answer "what's left" without the whole board.
 */
export function milestoneSummaryText(rows: readonly MilestoneView[]): string {
  const { total, mastered, practicing } = counts(rows);
  if (total === 0) return "Milestones: none";
  const names = rows
    .filter((row) => row.status === "practicing")
    .slice(0, 3)
    .map((row) => JSON.stringify(row.title));
  const tail = names.length > 0 ? ` (practicing ${names.join(", ")})` : "";
  return `Milestones: ${mastered} of ${total} mastered, ${practicing} practicing${tail}`;
}
