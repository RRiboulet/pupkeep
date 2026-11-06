// The approvals service (PLAN §7.3, §7.4, §9.2, §9.3, §10.3, §16 P4-07).
//
// §9.3's contract, and how this module keeps it:
//
//   * **a proposal changes nothing else.** `proposeApproval` writes one
//     `app.approvals` record, one activity line, one notification intent per
//     caregiver and the idempotency key — no care document is touched. The domain
//     effect only happens in `confirmApproval`'s commit;
//   * **confirmation is one commit.** Read the approval, check its derived state
//     (expired is evaluated with the commit's clock), check the revision the
//     caregiver read, run the stored action through the *same* domain function
//     HTTP uses (`createAppointmentIn`, `changeAppointmentIn`,
//     `updateMealSlotsIn`), write the decision, the activity line, the
//     notification and the `app.approval` thread entry — all in that one
//     transaction, with one idempotency key;
//   * **the model never executes.** There is no tool in this path: the only
//     caller of `confirmApproval` is the HTTP route, i.e. a caregiver's session;
//   * **a double confirm is idempotent.** A confirmed record answers its stored
//     result without running the action again, so a retried tap cannot cancel an
//     appointment twice or move a schedule twice. A *declined* proposal is
//     refused rather than executed;
//   * **a moved target is refused.** The action carries the revision it was
//     proposed against; if the appointment or the meal schedule changed in the
//     meantime, the confirming commit throws, nothing is written, and the
//     proposal stays pending so a caregiver can decline it or ask again.
//
// Expiry is derived (`approvalStateAt`), never stored: a phone whose clock was a
// day off must be able to answer "still pending" once it is fixed, and nothing
// has to rewrite terminal records on a timer.

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, JsonObject, Tx } from "@earendil-works/pi-durable";
import type {
  Approval,
  ApprovalAction,
  ApprovalResult,
  ApprovalState,
  Appointment,
  Household,
  MealSlot,
} from "../../shared/domain.ts";
import type { AppointmentFields } from "../../shared/calendar.ts";
import {
  APPOINTMENT_FIELD_KEYS,
  APPOINTMENT_RULE,
  parseAppointment,
  parseAppointmentFields,
} from "../../shared/calendar.ts";
import {
  APPROVAL_RULE,
  APPROVAL_SUMMARY_LIMIT,
  APPROVAL_TTL_MS,
  appendApprovals,
  approvalStateAt,
  parseApproval,
  parseApprovalList,
} from "../../shared/approvals.ts";
import { APPROVAL_ENTRY_KIND, type ApprovalEntryData } from "../../shared/chat.ts";
import { MEAL_SCHEDULE_RULE, parseMealSlots } from "../../shared/feeding.ts";
import { notificationIntent, notificationKey } from "../../shared/notifications.ts";
import { appendNotificationIntents } from "../notifications/intents.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorRef, ActorResolver } from "./actor.ts";
import { AppointmentStaleError, changeAppointmentIn, createAppointmentIn } from "./calendar.ts";
import { requestHashOf, runIdempotent, type CommandOutcome } from "./commands.ts";
import {
  ActivityDoc,
  ApprovalsDoc,
  CalendarDoc,
  FeedingDoc,
  HouseholdDoc,
  parseApprovals,
  type DocStore,
} from "./docs.ts";
import { DomainConflictError, StaleRevisionError, UnavailableError } from "./errors.ts";
import { updateMealSlotsIn } from "./feeding.ts";
import { appointmentInstant } from "./calendar.ts";

/** `app.approvals` is missing or unreadable; retry once the server has booted. */
export class ApprovalsUnavailableError extends UnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalsUnavailableError";
  }
}

/** No proposal with that id. A `DomainConflictError` so the mapper keeps its 404. */
export class ApprovalUnknownError extends DomainConflictError {
  constructor(message = "that proposal is not in the approval list") {
    super(message, 404);
    this.name = "ApprovalUnknownError";
  }
}

/**
 * A refusal a decision cannot answer, and why. A **private rollback signal**:
 * the caller maps it to its one 409 shape with the committed proposal, and
 * nothing (least of all the action) is written. One class rather than four:
 * every case carries the proposal it read and differs only in the sentence and
 * the outcome name.
 */
type RefusalReason = "stale" | "expired" | "declined" | "already-confirmed";

const REFUSAL_MESSAGE: Readonly<Record<RefusalReason, string>> = Object.freeze({
  stale: "the proposal changed since it was read",
  expired: "that proposal expired; nothing was executed",
  declined: "that proposal was declined; nothing was executed",
  "already-confirmed": "that proposal was already confirmed; the change is done",
});

class ApprovalRefusalError extends Error {
  readonly reason: RefusalReason;
  readonly current: Approval;

  constructor(reason: RefusalReason, current: Approval) {
    super(REFUSAL_MESSAGE[reason]);
    this.name = "ApprovalRefusalError";
    this.reason = reason;
    this.current = current;
  }
}

/** The proposals. Boot keeps the document present. */
export async function readApprovals(store: DocStore, context: Context): Promise<Approval[]> {
  const snapshot = await store.snapshot(ApprovalsDoc, context);
  const approvals = snapshot === undefined ? undefined : parseApprovals(snapshot);
  if (!approvals) throw new ApprovalsUnavailableError("the approval list is not available; retry after boot");
  return approvals.approvals;
}

/**
 * One proposal as every surface renders it (P4-07): the stored record plus the
 * **derived** state at one clock reading. Expiry is never stored, so this is the
 * one place a record becomes a card a caregiver can act on.
 */
export type ApprovalView = Approval & { state: ApprovalState };

export function approvalView(approval: Approval, now: Date): ApprovalView {
  return { ...approval, state: approvalStateAt(approval, now) };
}

/** Newest first: the centre lists the freshest proposal at the top. */
export function approvalViews(approvals: readonly Approval[], now: Date): ApprovalView[] {
  return [...approvals]
    .sort((a, b) => {
      const byCreated = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      return byCreated !== 0 ? byCreated : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((approval) => approvalView(approval, now));
}

/** `"Vet visit"` — caregiver text stays visibly data inside app copy (§9.5). */
function quoted(value: string): string {
  return JSON.stringify(value);
}

/** `2026-12-20 at 09:00`, the household wall clock a caregiver reads. */
function whenText(localDate: string, timeLocal: string): string {
  return `${localDate} at ${timeLocal}`;
}

/**
 * The one-line summaries a proposal and a result use. They are app-built (never
 * the model's words) and they name the caregiver's own text JSON-quoted, so a
 * title can never read like an instruction. Every builder stays inside
 * `APPROVAL_SUMMARY_LIMIT`: the document parser refuses a longer one, and the
 * action payloads that name many items are summarised, not dumped.
 */
export const approvalCopy = {
  appointmentCreate(fields: { title: string; localDate: string; timeLocal: string }): string {
    return `add the appointment ${quoted(fields.title)} on ${whenText(fields.localDate, fields.timeLocal)}`;
  },
  appointmentUpdate(
    current: { title: string; localDate: string; timeLocal: string },
    fields: { title: string; localDate: string; timeLocal: string },
  ): string {
    // Only a moved title or time reads as a move: a note or place fix must not
    // claim the visit changed when it did not.
    const moved = current.title !== fields.title || whenText(current.localDate, current.timeLocal) !== whenText(fields.localDate, fields.timeLocal);
    if (!moved) return `change the appointment ${quoted(current.title)} on ${whenText(current.localDate, current.timeLocal)}`;
    return (
      `change the appointment ${quoted(current.title)} from ` +
      `${whenText(current.localDate, current.timeLocal)} to ${quoted(fields.title)} on ` +
      `${whenText(fields.localDate, fields.timeLocal)}`
    );
  },
  appointmentCancel(current: { title: string; localDate: string; timeLocal: string }): string {
    return `cancel the appointment ${quoted(current.title)} on ${whenText(current.localDate, current.timeLocal)}`;
  },
  feedingSchedule(slots: readonly { label: string; timeLocal: string; active: boolean }[]): string {
    const active = slots.filter((slot) => slot.active);
    const shown = active.slice(0, 4).map((slot) => `${quoted(slot.label)} at ${slot.timeLocal}`);
    const more = active.length - shown.length;
    const list = `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
    return `change the meal schedule to ${active.length} ${active.length === 1 ? "meal" : "meals"}: ${list}`;
  },
  /**
   * The last-resort guard that the line fits the document's bound. Unreachable
   * under the current field caps (the longest legal card is 319 characters
   * against a 400-character limit), so it is deliberately not a truncation rule
   * anyone relies on: a future field that made a builder longer would surface as
   * a refused proposal rather than an unstorable one.
   */
  clamp(text: string): string {
    return text.length <= APPROVAL_SUMMARY_LIMIT ? text : `${text.slice(0, APPROVAL_SUMMARY_LIMIT - 1)}…`;
  },
};

// --- proposing --------------------------------------------------------------

/** The action a proposal stores, built inside the propose commit's own reads. */
export type ProposedAction = {
  readonly action: ApprovalAction;
  readonly summary: string;
};

export type ProposeInput = {
  /** Resolved inside the propose commit (§9.2). */
  readonly actor: ActorResolver;
  /** The agent tool's task id, namespaced `tool:<id>` (§7.3). */
  readonly actionId: string;
  /** The normalised request the proposal was made from; hashed for replay. */
  readonly request: JsonObject;
  /**
   * Build the stored action from the commit's current state. It reads documents
   * through `tx` (never the caller's earlier snapshot), so the revision the
   * action carries is the revision the confirm will be checked against.
   */
  readonly intent: (tx: Tx, household: Household) => Promise<ProposedAction>;
  readonly now?: Date;
  /** Test seam; a fresh uuid otherwise. */
  readonly id?: string;
};

export type ProposeOutcome =
  | { kind: "proposed" | "replayed"; approval: Approval }
  /** One idempotency key was reused for a different request. */
  | { kind: "key-conflict" };

/**
 * Write one proposal. Nothing else changes: the record, the activity line, the
 * caregivers' notification intents and the idempotency key land together, and a
 * refused shape rolls the whole commit back (including the key) instead of
 * burning it.
 */
export async function proposeApproval(
  store: DocStore,
  context: Context,
  input: ProposeInput,
): Promise<ProposeOutcome> {
  const now = input.now ?? new Date();
  const outcome: CommandOutcome<{ approval: Approval }> = await runIdempotent(
    { store, context },
    { key: input.actionId, requestHash: requestHashOf(input.request), now },
    async (tx) => {
      const household = await tx.doc(HouseholdDoc);
      const actor = await input.actor(tx, household);
      const proposed = await input.intent(tx, household);

      const approval: Approval = {
        id: input.id ?? randomUUID(),
        action: proposed.action,
        summary: approvalCopy.clamp(proposed.summary),
        status: "pending",
        requestedBy: actor.id,
        requestedByLabel: actor.label,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
        actionId: input.actionId,
        rev: 0,
      };
      // Backstop: a record the parser refuses would fail the next boot, so the
      // proposal is validated before it is stored.
      const parsed = parseApproval(approval);
      if (!parsed) throw new DomainConflictError(APPROVAL_RULE);

      const draft = await tx.doc(ApprovalsDoc);
      if (draft.createdAt === "") draft.createdAt = now.toISOString();
      const approvals = appendApprovals(draft.approvals, [parsed], now);
      if (!parseApprovalList(approvals)) throw new DomainConflictError(APPROVAL_RULE);
      draft.approvals = approvals;

      appendActivity(
        await tx.doc(ActivityDoc),
        activityEntry({
          kind: "approval.proposed",
          summary: `${actor.label} asked the household to confirm: ${parsed.summary}`,
          actorId: actor.id,
          actorLabel: actor.label,
          now,
        }),
      );

      // §12.1: both caregivers are told a decision is waiting. No screen is named
      // (there is no card UI yet), and nothing about the action rides a push body
      // (§14.3: the title is category text, the body is in-app only).
      await notifyApproval(
        tx,
        household,
        parsed,
        "proposed",
        `${actor.label} asks: ${parsed.summary}. A caregiver has to confirm it before anything changes.`,
        now,
      );

      return { approval: parsed };
    },
  );

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as { approval: Approval };
  return { kind: outcome.kind === "replayed" ? "replayed" : "proposed", approval: recorded.approval };
}

// --- deciding ---------------------------------------------------------------

export type DecideInput = {
  /** The caregiver's session, resolved inside the deciding commit (§9.2). */
  readonly actor: ActorResolver;
  /** The HTTP `Idempotency-Key`, namespaced `http:<key>` (§7.3). */
  readonly actionId: string;
  readonly id: string;
  /** The proposal revision the caregiver read. */
  readonly rev: number;
  readonly now?: Date;
};

/**
 * What a decision did, as HTTP reports it. One union for both verbs because they
 * share one responder: a confirm never answers `already-confirmed`, and a cancel
 * never answers `declined` or `target-changed` (declining an expired proposal is
 * allowed — expiry blocks execution, not dismissal). Keeping the settled
 * readings in one type is what keeps the two routes' answers identical.
 */
export type DecideOutcome =
  | { kind: "confirmed" | "cancelled" | "replayed"; approval: Approval; retiredTaskIds: number[] }
  /**
   * A newer revision exists: the committed proposal travels with the answer, so
   * the caller can show the other caregiver's decision without a second read.
   */
  | { kind: "stale"; approval: Approval }
  /** Expired before the decision: nothing was executed. */
  | { kind: "expired"; approval: Approval }
  /** Declined earlier: confirming it would execute an action nobody agreed to. */
  | { kind: "declined"; approval: Approval }
  /** Already confirmed: cancelling it would undo something already done. */
  | { kind: "already-confirmed"; approval: Approval }
  /** The record the action targets moved (or vanished): nothing was executed. */
  | { kind: "target-changed"; message: string }
  | { kind: "key-conflict" };

type Executed = {
  readonly result: ApprovalResult;
  readonly retiredTaskIds: number[];
};

/** The stored action's sentence, for the record, the feed and the thread. */
function executedSummary(action: ApprovalAction, appointmentTitle?: string): string {
  const title = appointmentTitle === undefined ? "" : ` ${quoted(appointmentTitle)}`;
  switch (action.kind) {
    case "appointment.create":
      return `added the appointment${title}`;
    case "appointment.update":
      return `changed the appointment${title}`;
    case "appointment.cancel":
      return `cancelled the appointment${title}`;
    case "feeding.schedule":
      return `changed the meal schedule (${action.slots.length} ${action.slots.length === 1 ? "meal" : "meals"})`;
  }
}

/**
 * Run the stored action inside the deciding commit (§9.3: the deterministic
 * domain function, never the model). The appointment writers need the title for
 * their sentence, so each branch reports what it wrote.
 */
async function executeApprovalAction(
  tx: Tx,
  approval: Approval,
  ctx: { readonly actor: ActorRef; readonly actionId: string; readonly now: Date },
): Promise<Executed> {
  const action = approval.action;
  if (action.kind === "appointment.create") {
    const appointment = await createAppointmentIn(tx, {
      actor: ctx.actor,
      actionId: ctx.actionId,
      fields: action.fields,
      now: ctx.now,
    });
    return {
      result: { kind: action.kind, summary: executedSummary(action, appointment.title), appointmentId: appointment.id },
      retiredTaskIds: [],
    };
  }
  if (action.kind === "appointment.update" || action.kind === "appointment.cancel") {
    const common = {
      actor: ctx.actor,
      actionId: ctx.actionId,
      id: action.appointmentId,
      rev: action.rev,
      now: ctx.now,
    };
    const committed = await changeAppointmentIn(
      tx,
      action.kind === "appointment.update"
        ? { ...common, kind: "update", fields: action.fields }
        : { ...common, kind: "cancel" },
    );
    return {
      result: {
        kind: action.kind,
        summary: executedSummary(action, committed.appointment.title),
        appointmentId: committed.appointment.id,
      },
      retiredTaskIds: committed.retiredTaskIds,
    };
  }
  await updateMealSlotsIn(tx, {
    actor: ctx.actor,
    actionId: ctx.actionId,
    rev: action.rev,
    slots: action.slots,
    now: ctx.now,
  });
  return { result: { kind: action.kind, summary: executedSummary(action) }, retiredTaskIds: [] };
}

/** §9.3: the outcome is appended to the shared thread, so both caregivers see it. */
async function appendApprovalEntry(
  tx: Tx,
  household: Household,
  approval: Approval,
  status: "confirmed" | "cancelled",
  actor: ActorRef,
  text: string,
  now: Date,
): Promise<void> {
  const data: ApprovalEntryData = {
    approvalId: approval.id,
    // The entry carries no model content, so the deciding commit's clock is its
    // only stamp; the transcript shows it instead of a missing time.
    at: now.toISOString(),
    status,
    text,
    byUserId: actor.id,
    byLabel: actor.label,
  };
  // No model content: an `app.approval` entry is history for the caregivers, not
  // a turn the model has to read (and pay for).
  await tx.appendEntry(household.conversationId as ConversationId, {
    kind: APPROVAL_ENTRY_KIND,
    data,
  });
}

/**
 * §12.1's `approval` fan-out, shared by the proposal and both decisions: one
 * intent per caregiver, the app-built body in-app only, and a dedupe key that
 * names the phase so a proposal and its decision are two items, not one.
 */
async function notifyApproval(
  tx: Tx,
  household: Household,
  approval: Approval,
  phase: "proposed" | "confirmed" | "cancelled",
  body: string,
  now: Date,
): Promise<void> {
  await appendNotificationIntents(
    tx,
    household.members.map((member) =>
      notificationIntent({
        dedupeKey: notificationKey("approval", approval.id, phase, member.id),
        category: "approval",
        userId: member.id,
        body,
        now,
      }),
    ),
    now,
  );
}

/**
 * Confirm one proposal: the one commit §9.3 describes. The stored action is
 * executed as it was proposed (its own revision check included), the decision is
 * recorded, and the activity line, the notification and the thread entry ride
 * with it.
 */
export async function confirmApproval(
  store: DocStore,
  context: Context,
  input: DecideInput,
): Promise<DecideOutcome> {
  const now = input.now ?? new Date();
  let outcome: CommandOutcome<{ approval: Approval; retiredTaskIds: number[]; executed: boolean }>;
  try {
    outcome = await runIdempotent(
      { store, context },
      { key: input.actionId, requestHash: requestHashOf({ id: input.id, rev: input.rev, decision: "confirm" }), now },
      async (tx) => {
        const household = await tx.doc(HouseholdDoc);
        const actor = await input.actor(tx, household);
        const draft = await tx.doc(ApprovalsDoc);
        const index = draft.approvals.findIndex((entry) => entry.id === input.id);
        const found = index === -1 ? undefined : draft.approvals[index];
        if (!found) throw new ApprovalUnknownError();

        const state = approvalStateAt(found, now);
        if (state === "confirmed") {
          // A double confirm is idempotent: the recorded result is the answer,
          // and the action never runs again (§9.3). Nothing is written but this
          // call's idempotency record.
          const settled = parseApproval(found);
          if (!settled) throw new DomainConflictError(APPROVAL_RULE);
          return { approval: settled, retiredTaskIds: [], executed: false };
        }
        if (state === "cancelled") throw new ApprovalRefusalError("declined", detached(found));
        if (state === "expired") throw new ApprovalRefusalError("expired", detached(found));
        if (found.rev !== input.rev) throw new ApprovalRefusalError("stale", detached(found));

        const executed = await executeApprovalAction(tx, found, {
          actor,
          actionId: input.actionId,
          now,
        });

        const next: Approval = {
          ...found,
          status: "confirmed",
          decidedBy: actor.id,
          decidedByLabel: actor.label,
          decidedAt: now.toISOString(),
          rev: found.rev + 1,
          actionId: input.actionId,
          result: executed.result,
        };
        const parsed = parseApproval(next);
        if (!parsed) throw new DomainConflictError(APPROVAL_RULE);
        const approvals = draft.approvals.map((entry, position) => (position === index ? parsed : entry));
        if (!parseApprovalList(approvals)) throw new DomainConflictError(APPROVAL_RULE);
        draft.approvals = approvals;

        // The one sentence the feed, the thread and the notification share, so
        // the three cannot describe the same decision differently.
        const text = `${actor.label} confirmed: ${executed.result.summary}`;
        appendActivity(
          await tx.doc(ActivityDoc),
          activityEntry({
            kind: "approval.confirmed",
            summary: text,
            actorId: actor.id,
            actorLabel: actor.label,
            now,
          }),
        );
        await appendApprovalEntry(tx, household, parsed, "confirmed", actor, text, now);
        await notifyApproval(tx, household, parsed, "confirmed", text, now);

        return { approval: parsed, retiredTaskIds: executed.retiredTaskIds, executed: true };
      },
    );
  } catch (error) {
    // The refusal's reason *is* the outcome name: a confirm can meet a stale
    // revision, an expired proposal or a declined one (a confirmed one returned
    // its result above).
    if (error instanceof ApprovalRefusalError) return { kind: error.reason, approval: error.current };
    // A target that moved (an appointment or the meal schedule) is refused, not
    // applied to whatever is there now; the whole commit rolls back and the
    // proposal stays pending.
    if (error instanceof AppointmentStaleError) {
      return {
        kind: "target-changed",
        message: "the appointment changed since the proposal was made; nothing was executed",
      };
    }
    if (error instanceof StaleRevisionError) {
      return {
        kind: "target-changed",
        message: "the meal schedule changed since the proposal was made; nothing was executed",
      };
    }
    throw error;
  }

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as {
    approval: Approval;
    retiredTaskIds?: number[];
    executed?: boolean;
  };
  return {
    // A settled proposal's stored result is a replay: nothing executed now.
    kind: outcome.kind === "replayed" || recorded.executed === false ? "replayed" : "confirmed",
    approval: recorded.approval,
    retiredTaskIds: recorded.retiredTaskIds ?? [],
  };
}

/**
 * Decline one proposal. Nothing is executed, so this is its own small commit:
 * the decision, the activity line, the notification and the thread entry.
 */
export async function cancelApproval(
  store: DocStore,
  context: Context,
  input: DecideInput,
): Promise<DecideOutcome> {
  const now = input.now ?? new Date();
  let outcome: CommandOutcome<{ approval: Approval; executed: boolean }>;
  try {
    outcome = await runIdempotent(
      { store, context },
      { key: input.actionId, requestHash: requestHashOf({ id: input.id, rev: input.rev, decision: "cancel" }), now },
      async (tx) => {
        const household = await tx.doc(HouseholdDoc);
        const actor = await input.actor(tx, household);
        const draft = await tx.doc(ApprovalsDoc);
        const index = draft.approvals.findIndex((entry) => entry.id === input.id);
        const found = index === -1 ? undefined : draft.approvals[index];
        if (!found) throw new ApprovalUnknownError();

        const state = approvalStateAt(found, now);
        if (state === "cancelled") {
          const settled = parseApproval(found);
          if (!settled) throw new DomainConflictError(APPROVAL_RULE);
          return { approval: settled, executed: false };
        }
        if (state === "confirmed") {
          // Declining something already done would pretend the change away.
          const settled = parseApproval(found);
          if (!settled) throw new DomainConflictError(APPROVAL_RULE);
          throw new ApprovalRefusalError("already-confirmed", settled);
        }
        // An **expired** proposal can still be declined: expiry makes it
        // unusable (§9.3), not undismissable, and nothing is executed either way.
        // That is how an expired card leaves the list with a decision on it.
        if (found.rev !== input.rev) throw new ApprovalRefusalError("stale", detached(found));

        const next: Approval = {
          ...found,
          status: "cancelled",
          decidedBy: actor.id,
          decidedByLabel: actor.label,
          decidedAt: now.toISOString(),
          rev: found.rev + 1,
          actionId: input.actionId,
        };
        const parsed = parseApproval(next);
        if (!parsed) throw new DomainConflictError(APPROVAL_RULE);
        const approvals = draft.approvals.map((entry, position) => (position === index ? parsed : entry));
        if (!parseApprovalList(approvals)) throw new DomainConflictError(APPROVAL_RULE);
        draft.approvals = approvals;

        const text = `${actor.label} declined: ${parsed.summary}`;
        appendActivity(
          await tx.doc(ActivityDoc),
          activityEntry({
            kind: "approval.cancelled",
            summary: text,
            actorId: actor.id,
            actorLabel: actor.label,
            now,
          }),
        );
        await appendApprovalEntry(tx, household, parsed, "cancelled", actor, text, now);
        await notifyApproval(tx, household, parsed, "cancelled", text, now);
        return { approval: parsed, executed: true };
      },
    );
  } catch (error) {
    // A decline can meet a stale revision or a proposal already executed; an
    // expired one is declined normally (expiry blocks execution, not dismissal).
    if (error instanceof ApprovalRefusalError) return { kind: error.reason, approval: error.current };
    throw error;
  }

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as {
    approval: Approval;
    executed?: boolean;
  };
  return {
    kind: outcome.kind === "replayed" || recorded.executed === false ? "replayed" : "cancelled",
    approval: recorded.approval,
    retiredTaskIds: [],
  };
}

/** A copy the caller can hold after the commit rolls back. */
function detached(approval: Approval): Approval {
  const parsed = parseApproval(approval);
  if (!parsed) throw new DomainConflictError(APPROVAL_RULE);
  return parsed;
}

// --- proposal builders ------------------------------------------------------

/**
 * The proposals this build can make, built from the proposing commit's own
 * reads. That is what makes "the stored, already-validated action" true: the
 * revision a confirm is checked against is the revision the agent saw when it
 * proposed, and the agent never supplies it.
 */

/** A create's action: the zone is the household's at execution, the offsets are fixed. */
export function appointmentCreateAction(household: Household, fields: AppointmentFields): ProposedAction {
  const stored: AppointmentFields = {
    ...fields,
    // The stored action is complete: a household setting that changes between
    // proposal and confirmation must not silently change what was shown.
    reminderOffsetsMin: fields.reminderOffsetsMin ?? [...household.settings.appointmentReminderOffsetsMin],
  };
  // The domain is the fence, not only the tool: a proposal the document would
  // refuse must fail here, before the commit stores half of one.
  if (!parseAppointmentFields(stored)) throw new DomainConflictError(APPOINTMENT_RULE);
  return {
    action: { kind: "appointment.create", fields: stored },
    summary: approvalCopy.appointmentCreate(stored),
  };
}

/**
 * The appointment a proposal names, from the proposing commit's calendar.
 *
 * The **lifecycle** is checked here, not only at confirmation: a proposal
 * against a record that is already cancelled (or completed) could never execute,
 * so storing one would tell the household a decision is waiting for an action
 * that cannot run. Refusing at propose time gives the model a sentence it can
 * report, and the household no dead card.
 */
async function proposedAppointment(tx: Tx, id: string): Promise<Appointment> {
  const draft = await tx.doc(CalendarDoc);
  const found = draft.appointments.find((entry) => entry.id === id);
  if (!found) throw new DomainConflictError("that appointment is not in the calendar", 404);
  const parsed = parseAppointment(found);
  if (!parsed) throw new DomainConflictError(APPROVAL_RULE);
  if (parsed.status !== "scheduled") {
    throw new DomainConflictError(
      parsed.status === "cancelled" ? "that appointment is already cancelled" : "that appointment is already completed",
    );
  }
  return parsed;
}

/**
 * The editable fields a patch asks for, merged onto the committed record. A
 * partial patch is what a caregiver means by "move it to 10:00"; the stored
 * action is still the **whole** record, so confirming writes exactly what the
 * proposal showed (§9.3).
 */
export function mergeAppointmentFields(current: Appointment, patch: Record<string, unknown>): unknown {
  const merged: Record<string, unknown> = {};
  for (const key of APPOINTMENT_FIELD_KEYS) {
    // The committed record is the base; a patch key overrides it, and a `null`
    // patch means "clear it", which is how the field parser spells absence.
    if (patch[key] !== undefined) merged[key] = patch[key];
    else if (key === "reminderOffsetsMin") merged[key] = current.reminderOffsetsMin;
    else if (key in current) merged[key] = (current as unknown as Record<string, unknown>)[key];
  }
  return merged;
}

export async function appointmentUpdateAction(
  tx: Tx,
  id: string,
  patch: Record<string, unknown>,
): Promise<ProposedAction> {
  const current = await proposedAppointment(tx, id);
  const fields = parseAppointmentFields(mergeAppointmentFields(current, patch));
  if (!fields) throw new DomainConflictError(APPOINTMENT_RULE);
  return {
    action: { kind: "appointment.update", appointmentId: id, rev: current.rev, fields },
    summary: approvalCopy.appointmentUpdate(current, fields),
  };
}

export async function appointmentCancelAction(tx: Tx, id: string): Promise<ProposedAction> {
  const current = await proposedAppointment(tx, id);
  return {
    action: { kind: "appointment.cancel", appointmentId: id, rev: current.rev },
    summary: approvalCopy.appointmentCancel(current),
  };
}

export async function feedingScheduleAction(tx: Tx, slots: MealSlot[]): Promise<ProposedAction> {
  const parsed = parseMealSlots(slots);
  if (!parsed) throw new DomainConflictError(MEAL_SCHEDULE_RULE);
  const draft = await tx.doc(FeedingDoc);
  return {
    action: { kind: "feeding.schedule", rev: draft.rev, slots: parsed },
    summary: approvalCopy.feedingSchedule(parsed),
  };
}
