// `app.approvals` and its invariants (PLAN §7.3, §7.4, §9.3, §16 P4-07).
//
// A proposal is a **request, not a change**: the agent may only write one of
// these, and the domain effect happens in the single commit that a caregiver's
// confirmation runs. Two properties make that safe to reason about:
//
//   * **the stored action is complete.** It carries the fields, the meal slots or
//     the target id *and the revision it was read from*, so confirming executes
//     exactly what was shown. A record that moved in the meantime is refused
//     (the service answers a stale conflict) rather than being overwritten with an
//     action the caregiver never saw;
//   * **expiry is derived.** `expiresAt` is stored, `expired` is computed from the
//     confirming commit's clock (`approvalStateAt`). Nothing has to sweep the
//     document on a timer, and a clock that was briefly wrong cannot permanently
//     settle a proposal.
//
// What this module fixes about the shape:
//   * ids are opaque and unique; `actionId` follows the same rule as every care
//     write (§7.3);
//   * `summary` is app-built one-line text with caregiver free text JSON-quoted
//     inside it, so a title can never masquerade as an instruction (§9.5);
//   * the §9.2 fence holds: a proposal with no requester id travels with the
//     household label, and the same for the deciding member;
//   * `decidedBy`/`decidedByLabel`/`decidedAt` exist **iff** the record is
//     decided, and `result` exists **iff** it was confirmed — a half-decided
//     record is a document the parser refuses rather than a UI that guesses.

import type { Approval, ApprovalAction, ApprovalResult, ApprovalState } from "./domain.ts";
import { APPROVAL_STATUSES, OPAQUE_ID_PATTERN, isIsoInstant } from "./domain.ts";
import { HOUSEHOLD_FALLBACK_LABEL } from "./chat.ts";
import { hasControlCharacter } from "./profile.ts";
import type { AppointmentFields } from "./calendar.ts";
import { parseAppointmentFields } from "./calendar.ts";
import { parseMealSlots } from "./feeding.ts";

/** §9.3: a proposal is usable for a day. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * §8.1's document bounds. `app.activity` keeps 200 entries and `app.commands`
 * 1000; an approval is one small record, and a live pending one is never pruned.
 */
export const APPROVAL_LIMIT = 100;
export const APPROVAL_ID_LIMIT = 64;
/** Matches `COMMAND_KEY_LIMIT`: `http:<key>` or `tool:<taskId>`. */
export const APPROVAL_ACTION_ID_LIMIT = 120;
/**
 * One line of app-built copy. An update's summary names two titles (up to 120
 * characters each) and two wall-clock times, so the bound leaves room for the
 * longest legal card rather than truncating one.
 */
export const APPROVAL_SUMMARY_LIMIT = 400;

/**
 * The one sentence a proposal the document cannot store answers with: an action
 * this build can execute, one line of app-built summary, a decision that cannot
 * precede its proposal and a result only where something ran.
 */
export const APPROVAL_RULE =
  "a proposal needs an action this build can execute (an appointment change or a meal schedule), one line of summary, and a decision that follows it";

/**
 * The action kinds this build can execute. A proposal for anything else is a
 * shape this build does not understand: storing it would leave a card that can
 * never be confirmed, so the parser refuses it.
 */
export const APPROVAL_ACTION_KINDS = [
  "appointment.create",
  "appointment.update",
  "appointment.cancel",
  "feeding.schedule",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

/** App-built one-line text: trimmed, non-empty, no control characters, bounded. */
function lineText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > limit || hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

/** Display text, uncapped for the reason `shared/feed` gives: a member label. */
function displayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

function opacity(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) return undefined;
  return OPAQUE_ID_PATTERN.test(value) ? value : undefined;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The appointment fields one action carries. The stored copy is complete — the
 * parser refuses a create whose offset list is absent, because a confirmed action
 * must not need the household's current settings to mean something.
 */
function parseStoredFields(
  raw: unknown,
): { kind: "appointment.create"; fields: AppointmentFields } | undefined {
  const fields = parseAppointmentFields(raw);
  // The stored create fixes its offset list: a later household-settings change
  // must not alter what the caregiver was shown.
  if (!fields || fields.reminderOffsetsMin === undefined) return undefined;
  return { kind: "appointment.create", fields };
}

/** One stored action, or `undefined` for a shape this build cannot execute. */
export function parseApprovalAction(raw: unknown): ApprovalAction | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const kind = record.kind;
  if (kind === "appointment.create") {
    if (!onlyKeys(record, ["kind", "fields"])) return undefined;
    return parseStoredFields(record.fields);
  }
  if (kind === "appointment.update") {
    if (!onlyKeys(record, ["kind", "appointmentId", "rev", "fields"])) return undefined;
    const appointmentId = opacity(record.appointmentId, APPROVAL_ID_LIMIT);
    if (appointmentId === undefined || !isRevision(record.rev)) return undefined;
    const fields = parseAppointmentFields(record.fields);
    // An update's offset list is optional: absent keeps the record's own list
    // (P4-01's rule), so the action is still complete in what it asks for.
    if (!fields) return undefined;
    return { kind: "appointment.update", appointmentId, rev: record.rev, fields };
  }
  if (kind === "appointment.cancel") {
    if (!onlyKeys(record, ["kind", "appointmentId", "rev"])) return undefined;
    const appointmentId = opacity(record.appointmentId, APPROVAL_ID_LIMIT);
    if (appointmentId === undefined || !isRevision(record.rev)) return undefined;
    return { kind: "appointment.cancel", appointmentId, rev: record.rev };
  }
  if (kind === "feeding.schedule") {
    if (!onlyKeys(record, ["kind", "rev", "slots"])) return undefined;
    if (!isRevision(record.rev)) return undefined;
    const slots = parseMealSlots(record.slots);
    if (!slots) return undefined;
    return { kind: "feeding.schedule", rev: record.rev, slots };
  }
  return undefined;
}

/** One stored result: the kind it belongs to and the app-built sentence. */
function parseApprovalResult(raw: unknown): ApprovalResult | undefined {
  const record = asRecord(raw);
  if (!record || !onlyKeys(record, ["kind", "summary", "appointmentId"])) return undefined;
  if (!(APPROVAL_ACTION_KINDS as readonly unknown[]).includes(record.kind)) return undefined;
  const summary = lineText(record.summary, APPROVAL_SUMMARY_LIMIT);
  if (summary === undefined) return undefined;
  const result: ApprovalResult = { kind: record.kind as ApprovalResult["kind"], summary };
  if (record.appointmentId !== undefined) {
    const appointmentId = opacity(record.appointmentId, APPROVAL_ID_LIMIT);
    if (appointmentId === undefined) return undefined;
    result.appointmentId = appointmentId;
  }
  return result;
}

const APPROVAL_KEYS = [
  "id",
  "action",
  "summary",
  "status",
  "requestedBy",
  "requestedByLabel",
  "createdAt",
  "expiresAt",
  "actionId",
  "rev",
  "decidedBy",
  "decidedByLabel",
  "decidedAt",
  "result",
] as const;

/** §9.2's fence in one place: no id always travels with the household label. */
function pairedMember(
  id: unknown,
  label: unknown,
): { id: string | null; label: string } | undefined {
  const parsedLabel = displayText(label);
  if (parsedLabel === undefined) return undefined;
  if (id === null) {
    return parsedLabel === HOUSEHOLD_FALLBACK_LABEL ? { id: null, label: parsedLabel } : undefined;
  }
  const parsedId = displayText(id);
  if (parsedId === undefined) return undefined;
  return { id: parsedId, label: parsedLabel };
}

/**
 * One stored approval, or `undefined` for a shape this build does not accept.
 * Every field is checked: a proposal the parser refuses must fail boot rather
 * than be silently repaired into an action nobody proposed.
 */
export function parseApproval(raw: unknown): Approval | undefined {
  const record = asRecord(raw);
  if (!record || !onlyKeys(record, APPROVAL_KEYS)) return undefined;

  const id = opacity(record.id, APPROVAL_ID_LIMIT);
  if (id === undefined) return undefined;
  const action = parseApprovalAction(record.action);
  if (!action) return undefined;
  const summary = lineText(record.summary, APPROVAL_SUMMARY_LIMIT);
  if (summary === undefined) return undefined;
  if (!(APPROVAL_STATUSES as readonly unknown[]).includes(record.status)) return undefined;
  const requester = pairedMember(record.requestedBy, record.requestedByLabel);
  if (!requester) return undefined;
  if (!isIsoInstant(record.createdAt) || !isIsoInstant(record.expiresAt)) return undefined;
  // A proposal that expires before it exists is a corrupt clock reading, not a
  // legal record.
  if (Date.parse(record.expiresAt) < Date.parse(record.createdAt)) return undefined;
  const actionId = opacity(record.actionId, APPROVAL_ACTION_ID_LIMIT);
  if (actionId === undefined || !isRevision(record.rev)) return undefined;

  const status = record.status as Approval["status"];
  const decided = status !== "pending";
  const hasDecisionFields =
    record.decidedBy !== undefined || record.decidedByLabel !== undefined || record.decidedAt !== undefined;
  if (decided !== hasDecisionFields) return undefined;

  const approval: Approval = {
    id,
    action,
    summary,
    status,
    requestedBy: requester.id,
    requestedByLabel: requester.label,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    actionId,
    rev: record.rev,
  };

  if (decided) {
    const decider = pairedMember(record.decidedBy, record.decidedByLabel);
    if (!decider || !isIsoInstant(record.decidedAt)) return undefined;
    if (Date.parse(record.decidedAt) < Date.parse(record.createdAt)) return undefined;
    approval.decidedBy = decider.id;
    approval.decidedByLabel = decider.label;
    approval.decidedAt = record.decidedAt;
  }

  // A result exists exactly when something was executed.
  if ((status === "confirmed") !== (record.result !== undefined)) return undefined;
  if (record.result !== undefined) {
    const result = parseApprovalResult(record.result);
    if (!result) return undefined;
    // A result names the action kind it came from: a record whose two halves
    // disagree is a bug, not a preference.
    if (result.kind !== action.kind) return undefined;
    approval.result = result;
  }
  return approval;
}

/**
 * A stored approval list: unique ids. Order is append order, deliberately not a
 * rule — a reader sorts by `createdAt` where it needs chronology.
 */
export function parseApprovalList(raw: unknown): Approval[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const approvals: Approval[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const approval = parseApproval(item);
    if (!approval || ids.has(approval.id)) return undefined;
    ids.add(approval.id);
    approvals.push(approval);
  }
  return approvals;
}

/**
 * What a reader sees at one clock reading (§9.3): the stored decision, or
 * `expired` for a proposal that is still pending and past its instant. The
 * confirming commit evaluates this with its own clock; a reader only renders it.
 */
export function approvalStateAt(approval: Pick<Approval, "status" | "expiresAt">, now: Date): ApprovalState {
  if (approval.status !== "pending") return approval.status;
  return Date.parse(approval.expiresAt) <= now.getTime() ? "expired" : "pending";
}

/**
 * §8.5's retention for this document: a live pending proposal is never pruned
 * (a caregiver may still decide it), and among the rest the newest `limit` are
 * kept. Expired proposals are not "owed" to anyone — their card says so, and the
 * next confirmation refuses them — so they fall into the prunable half.
 */
export function appendApprovals(
  existing: readonly Approval[],
  incoming: readonly Approval[],
  now: Date,
  limit = APPROVAL_LIMIT,
): Approval[] {
  const all = [...existing, ...incoming];
  if (all.length <= limit) return all;
  const live = all.filter((approval) => approvalStateAt(approval, now) === "pending");
  const liveSet = new Set(live);
  const terminal = all.filter((approval) => !liveSet.has(approval));
  if (!Number.isInteger(limit) || limit <= 0) return live;
  const keep = new Set<Approval>([...live, ...terminal.slice(-limit)]);
  // Document order is append order; a reader sorts where it needs chronology.
  return all.filter((approval) => keep.has(approval));
}
