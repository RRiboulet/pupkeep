// The household document: one reader, and the one place that mirrors auth into
// it (PLAN §7.1, §8.1).
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
import type { Household, MemberProfile } from "../../shared/domain.ts";
import { reconcileMembers, type AppConfig } from "../config.ts";
import { HouseholdDoc, parseHousehold, parseMemberProfiles, type DocStore } from "./docs.ts";
import { UnavailableError } from "./errors.ts";

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
