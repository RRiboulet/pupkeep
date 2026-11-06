// The household document: one reader, the one place that mirrors auth into it,
// and (P1-14) the one human-editable write — the timezone (PLAN §7.1, §8.1).
//
// `config.json` is the authority for auth identities and roles; `app.household`
// holds the display profiles. Boot reconciles the two in full. A member created
// after boot — today that is an accepted invite — is mirrored here, at the
// moment the invite is redeemed, instead of on every read:
//
//   * a read that writes is surprising, and putting the repair on GET paths made
//     `agent/thread.ts` import the auth authority for a care route's benefit;
//   * "is the roster shorter than the cap?" is a false proxy for "is someone
//     missing": remove a partner, invite a replacement before the next restart,
//     and the document still had two entries, so the newcomer was never added;
//   * an invite is the only in-process way a member appears, and it is rare, so
//     one commit there is cheaper than a membership check on every snapshot.
//
// A member added by editing `config.json` by hand is still mirrored by the next
// boot, which is what the plan promises. Removals follow the same rule: the
// invite path applies the full reconciliation plan (it has the fresh config in
// hand), and boot repairs whatever a crash left behind.

import type { Context } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Household, MemberProfile } from "../../shared/domain.ts";
import { reconcileMembers, type AppConfig } from "../config.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorResolver } from "./actor.ts";
import { outcomeOf, requestHashOf, runIdempotent, type CommandOutcome, type WriteOutcome } from "./commands.ts";
import { isIanaZone } from "../../shared/profile.ts";
import { AGENT_BUDGET_MAX_USD, isAgentBudget } from "../../shared/usage.ts";
import {
  ActivityDoc,
  FeedingDoc,
  HouseholdDoc,
  parseHousehold,
  parseMemberProfiles,
  type DocStore,
} from "./docs.ts";
import { armFeedReminders } from "../reminders/schedule.ts";
import { DomainConflictError, StaleRevisionError, UnavailableError } from "./errors.ts";

/** `app.household` is missing or unreadable; retry once the server has booted. */
export class HouseholdUnavailableError extends UnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "HouseholdUnavailableError";
  }
}

/** The household document exists and parses. Boot keeps it true. */
export async function readHousehold(store: DocStore, context: Context): Promise<Household> {
  const snapshot = await store.snapshot(HouseholdDoc, context);
  const household = snapshot === undefined ? undefined : parseHousehold(snapshot);
  if (!household) {
    throw new HouseholdUnavailableError("the household document is not available; retry after boot");
  }
  return household;
}

export type HouseholdSync = {
  /** Member ids whose profile was added. */
  created: string[];
  /** Member ids whose profile was dropped (auth is gone). */
  removed: string[];
  /** Set when the merged roster would not parse; nothing was written. */
  skipped?: string;
};

function sameProfiles(a: readonly MemberProfile[], b: readonly MemberProfile[]): boolean {
  return a.length === b.length && a.every((member, index) => {
    const other = b[index];
    return other !== undefined && other.id === member.id && other.name === member.name;
  });
}

/**
 * Make the document's profiles match `config`. Idempotent: with nothing to do it
 * writes nothing. A merge that would not parse (a duplicate display name typed
 * into `config.json`) is refused and reported rather than written, because a
 * document boot cannot parse is worse than a stale label.
 */
export async function syncHouseholdMembers(
  store: DocStore,
  context: Context,
  config: AppConfig,
): Promise<HouseholdSync> {
  const household = await readHousehold(store, context);
  const plan = reconcileMembers(config, household.members);
  if (plan.createProfiles.length === 0 && plan.removeProfiles.length === 0) {
    return { created: [], removed: [] };
  }

  const dropped = new Set(plan.removeProfiles.map((profile) => profile.id));
  const merged = [
    ...household.members.filter((member) => !dropped.has(member.id)),
    ...plan.createProfiles,
  ];
  const profiles = parseMemberProfiles(merged);
  if (!profiles) {
    return {
      created: [],
      removed: [],
      skipped: "the merged household profiles would not parse; left for the next boot to report",
    };
  }

  let created: string[] = [];
  let removed: string[] = [];
  await store.commit(async (tx) => {
    const draft = await tx.doc(HouseholdDoc);
    // Re-read inside the commit: a concurrent sync (or a boot) may have applied
    // the same plan, and the second pass must write nothing.
    if (sameProfiles(draft.members, profiles)) return;
    created = plan.createProfiles.map((profile) => profile.id);
    removed = plan.removeProfiles.map((profile) => profile.id);
    draft.members = profiles;
  }, context);
  return { created, removed };
}

// --- the household's one human-editable write (P1-14) -----------------------

export type HouseholdWrite = {
  /** Resolved inside the commit, against the same household the write reads. */
  readonly actor: ActorResolver;
  /** The HTTP `Idempotency-Key`, namespaced by the caller (§7.4's `actionId`). */
  readonly actionId: string;
  /** The household revision the caller read. */
  readonly rev: number;
  /** IANA zone; `Europe/Paris`, not `+01:00`. */
  readonly timezone: string;
  readonly now?: Date;
};

/**
 * Set (or re-confirm) the household timezone. One commit: the zone, the
 * confirmation instant, the bumped revision, the activity entry and the
 * idempotency record land together or not at all.
 *
 * Confirming an unchanged zone still counts: the caregiver has checked the one
 * value every future `localDate` derives from, and first-run setup is not
 * complete until that has happened. Only the roster is exempt from `rev` —
 * boot and an invite mirror members without revising the household.
 */
export async function updateHouseholdTimezone(
  store: DocStore,
  context: Context,
  input: HouseholdWrite,
): Promise<WriteOutcome> {
  const now = input.now ?? new Date();
  const request = { rev: input.rev, timezone: input.timezone } as JsonObject;
  let outcome: CommandOutcome<{ rev: number; timezone: string }>;
  try {
    outcome = await runIdempotent(
      { store, context },
      { key: input.actionId, requestHash: requestHashOf(request), now },
      async (tx) => {
        // Inside the callback and after the idempotency lookup: a replay must
        // not be re-judged, and a bad zone must not reach the document.
        if (!isIanaZone(input.timezone)) {
          throw new DomainConflictError(`"${input.timezone}" is not an IANA timezone`);
        }
        const draft = await tx.doc(HouseholdDoc);
        const actor = await input.actor(tx, draft);
        if (draft.rev !== input.rev) throw new StaleRevisionError("the household changed since it was read");

        const before = draft.timezone;
        const changed = before !== input.timezone;
        if (changed) {
          // P4-04: the meal reminders are wall-clock instants in the household
          // zone, so a zone change makes today's arms stale. Re-arm for the new
          // zone **before** storing it — the arm reads task state, which must
          // precede this commit's writes — and the old tasks no-op when they
          // wake because their `dueAt` no longer matches.
          const feeding = await tx.doc(FeedingDoc);
          await armFeedReminders(tx, draft, feeding.slots, now, input.timezone);
        }
        draft.timezone = input.timezone;
        draft.timezoneConfirmedAt = now.toISOString();
        draft.rev = input.rev + 1;
        appendActivity(
          await tx.doc(ActivityDoc),
          activityEntry({
            kind: "household.timezone",
            summary: changed
              ? `${actor.label} changed the household timezone from ${before} to ${input.timezone}`
              : `${actor.label} confirmed the household timezone (${input.timezone})`,
            actorId: actor.id,
            actorLabel: actor.label,
            now,
          }),
        );
        return { rev: draft.rev, timezone: input.timezone };
      },
    );
  } catch (error) {
    if (error instanceof StaleRevisionError) return "stale";
    throw error;
  }

  return outcomeOf(outcome);
}

// --- the agent's monthly cap (P4-08) ----------------------------------------

export type BudgetWrite = {
  /** Resolved inside the commit, against the household the write reads. */
  readonly actor: ActorResolver;
  readonly actionId: string;
  /** The household revision the caller read. */
  readonly rev: number;
  /** Whole cents, `0`–`AGENT_BUDGET_MAX_USD` (§11.3). */
  readonly capUsd: number;
  readonly now?: Date;
};

/**
 * Set the monthly agent cap. One commit: the setting, the bumped revision, the
 * activity line and the idempotency record. The cap is enforced server-side on
 * the next submission (§11.3) — this route only stores the owner's decision.
 *
 * It shares `app.household`'s revision with the timezone write, so a stale draft
 * of either is refused rather than silently overwriting the other.
 */
export async function updateAgentBudget(
  store: DocStore,
  context: Context,
  input: BudgetWrite,
): Promise<WriteOutcome> {
  const now = input.now ?? new Date();
  const request = { rev: input.rev, agentBudgetUsd: input.capUsd } as JsonObject;
  let outcome: CommandOutcome<{ rev: number; agentBudgetUsd: number }>;
  try {
    outcome = await runIdempotent(
      { store, context },
      { key: input.actionId, requestHash: requestHashOf(request), now },
      async (tx) => {
        // Validated inside the callback, after the idempotency lookup: a replay
        // must not be re-judged, and a bad cap must not reach the document.
        if (!isAgentBudget(input.capUsd)) {
          throw new DomainConflictError(`a monthly budget is whole cents from 0 to ${AGENT_BUDGET_MAX_USD}`);
        }
        const draft = await tx.doc(HouseholdDoc);
        const actor = await input.actor(tx, draft);
        if (draft.rev !== input.rev) throw new StaleRevisionError("the household changed since it was read");

        const before = draft.settings.agentBudgetUsd;
        draft.settings.agentBudgetUsd = input.capUsd;
        draft.rev = input.rev + 1;
        appendActivity(
          await tx.doc(ActivityDoc),
          activityEntry({
            kind: "household.budget",
            // Amounts only: a cap is not caregiver text and cannot forge a line.
            summary:
              before === input.capUsd
                ? `${actor.label} re-confirmed the monthly agent budget ($${input.capUsd.toFixed(2)})`
                : `${actor.label} set the monthly agent budget to $${input.capUsd.toFixed(2)}`,
            actorId: actor.id,
            actorLabel: actor.label,
            now,
          }),
        );
        return { rev: draft.rev, agentBudgetUsd: input.capUsd };
      },
    );
  } catch (error) {
    if (error instanceof StaleRevisionError) return "stale";
    throw error;
  }

  return outcomeOf(outcome);
}
