// The puppy profile (PLAN §8.1, §7.4, §13.1): one document, one service, and
// the one reader that builds the shared care view (`profileView`).
//
// Both HTTP (`PATCH /api/puppy`) and the agent tool (`update_puppy_profile`) call
// this module, so there is one place that checks a revision, writes the
// idempotency record and appends the activity entry. Neither caller may write
// `app.puppy` directly. The household timezone (P1-14) and the meal schedule
// (P1-14, P2) have their own writers in `household.ts` and `feeding.ts`; they
// share this module's view so the `profile` frame is always one whole snapshot.
//
// Three invariants live here:
//   * `rev` is optimistic concurrency: an edit echoes the revision it read, and
//     a stale one is refused with the current profile rather than overwriting it;
//   * the same action (same idempotency key, same request) is success, even on
//     replay — see `src/server/domain/commands.ts`;
//   * age is derived from the *household-local* date, never stored, so moving
//     the household timezone cannot leave a wrong age in the document.

import type { Context } from "@earendil-works/chord";
import type { JsonObject, SessionDocToken } from "@earendil-works/pi-durable";
import type { Feeding, Household, Puppy } from "../../shared/domain.ts";
import type { PuppyFields, PuppyPatch, PuppyProfile, SetupStep } from "../../shared/profile.ts";
import { ActivityDoc, HouseholdDoc, PuppyDoc, parsePuppy, type DocStore } from "./docs.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorResolver } from "./actor.ts";
import { type CommandOutcome, requestHashOf, runIdempotent } from "./commands.ts";
import { DomainConflictError, StaleRevisionError, UnavailableError } from "./errors.ts";
import { readFeeding } from "./feeding.ts";
import { readHousehold } from "./household.ts";
import { ageOf, localDateAt } from "./time.ts";


/** `app.puppy` is missing or unreadable; retry once the server has booted. */
export class ProfileUnavailableError extends UnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "ProfileUnavailableError";
  }
}

export interface ProfileUpdate {
  /**
   * Who is making the change, resolved *inside* the commit. HTTP already knows
   * (the session); the agent tool has to look at the latest `app.chat` entry
   * (§9.2 rule 2), and that read belongs on the same transaction as the write.
   */
  readonly actor: ActorResolver;
  /** `Idempotency-Key`, or the tool task's id (§7.4, §10.3). */
  readonly actionId: string;
  /** The revision the caller read; must equal the document's current one. */
  readonly rev: number;
  readonly patch: PuppyPatch;
  readonly now?: Date;
}


export type ProfileUpdateOutcome =
  | { kind: "updated"; profile: PuppyProfile }
  /** The same action, already committed: success, not a conflict (§7.4). */
  | { kind: "replayed"; profile: PuppyProfile }
  /** A newer revision exists; the caller re-reads, it does not auto-retry. */
  | { kind: "stale"; profile: PuppyProfile }
  /** One idempotency key was reused for a different request. */
  | { kind: "key-conflict" };

function readDoc<T extends JsonObject>(
  store: DocStore,
  token: SessionDocToken<T>,
  context: Context,
  parse: (value: unknown) => T | undefined,
  what: string,
): Promise<T> {
  return store.snapshot(token, context).then((snapshot) => {
    const value = snapshot === undefined ? undefined : parse(snapshot);
    if (!value) throw new ProfileUnavailableError(`${what} is not available; retry after boot`);
    return value;
  });
}

export function readPuppy(store: DocStore, context: Context): Promise<Puppy> {
  return readDoc(store, PuppyDoc, context, (value) => parsePuppy(value), "app.puppy");
}

/** The editable fields, copied out of the document. */
export function puppyFields(puppy: Puppy): PuppyFields {
  const { name, birthday, breed, sex, targetWeightKg } = puppy;
  return { name, birthday, breed, sex, targetWeightKg };
}

/**
 * What first-run setup still needs (P1-14). Derived from the documents, in the
 * wizard's order: the zone every `localDate` depends on, the puppy itself, and
 * a meal schedule that shows at least one meal. A partner who joins mid-wizard
 * sees the same list, so either caregiver can finish it.
 */
export function setupState(household: Household, puppy: Puppy, feeding: Feeding): {
  complete: boolean;
  missing: SetupStep[];
} {
  const missing: SetupStep[] = [];
  if (household.timezoneConfirmedAt === null) missing.push("timezone");
  if (puppy.name.trim() === "") missing.push("puppy");
  if (feeding.slots.length === 0) missing.push("meals");
  return { complete: missing.length === 0, missing };
}

/** The wire/view shape: document facts plus derived age, roster, meals and setup. */
export function profileView(household: Household, puppy: Puppy, feeding: Feeding, now: Date): PuppyProfile {
  const today = localDateAt(now, household.timezone);
  return {
    rev: puppy.rev,
    puppy: puppyFields(puppy),
    age: ageOf(puppy.birthday, today),
    household: {
      name: household.name,
      timezone: household.timezone,
      timezoneConfirmedAt: household.timezoneConfirmedAt,
      rev: household.rev,
      members: household.members.map((member) => ({ ...member })),
    },
    meals: { rev: feeding.rev, slots: feeding.slots.map((slot) => ({ ...slot })) },
    setup: setupState(household, puppy, feeding),
    today,
  };
}

/**
 * Read the three committed documents and build the current view. One reader for
 * HTTP, the `profile` frame and the tools, so all three can never disagree
 * about the household's state.
 */
export async function readProfile(store: DocStore, context: Context, now: Date): Promise<PuppyProfile> {
  const [household, puppy, feeding] = await Promise.all([
    readHousehold(store, context),
    readPuppy(store, context),
    readFeeding(store, context),
  ]);
  return profileView(household, puppy, feeding, now);
}

function applyPatch(draft: Puppy, patch: PuppyPatch): void {
  if (patch.name !== undefined) draft.name = patch.name;
  if (patch.birthday !== undefined) draft.birthday = patch.birthday;
  if (patch.breed !== undefined) draft.breed = patch.breed;
  if (patch.sex !== undefined) draft.sex = patch.sex;
  if (patch.targetWeightKg !== undefined) draft.targetWeightKg = patch.targetWeightKg;
}

function summaryOf(before: Puppy, after: Puppy, actorLabel: string): string {
  if (before.name === "" && after.name !== "") return `${actorLabel} added ${after.name} to the household`;
  // A profile can still be nameless (P1-14's wizard fills it): say "the puppy's
  // profile" rather than quoting an empty name.
  if (after.name === "") return `${actorLabel} updated the puppy's profile`;
  // The document's names are free text; they are quoted in the feed so a name
  // that reads like a sentence cannot pass itself off as one.
  return `${actorLabel} updated the profile of "${after.name}"`;
}

/**
 * Apply one patch. The revision check runs **inside** the commit, after the
 * idempotency lookup, so a retried save (same key, same request) replays as
 * success even though its own earlier commit bumped the revision.
 */
export async function updatePuppyProfile(
  store: DocStore,
  context: Context,
  input: ProfileUpdate,
): Promise<ProfileUpdateOutcome> {
  const now = input.now ?? new Date();
  const household = await readHousehold(store, context);
  const today = localDateAt(now, household.timezone);

  const request = { rev: input.rev, patch: input.patch } as JsonObject;
  let outcome: CommandOutcome<{ rev: number }>;
  try {
    outcome = await runIdempotent(
      { store, context },
      { key: input.actionId, requestHash: requestHashOf(request), now },
      async (tx) => {
        // Inside the callback, so a replay (which never runs this) is not
        // re-judged against a `today` that has since moved: the module's
        // "same action is success" rule outranks a re-derivation.
        if (input.patch.birthday != null && input.patch.birthday > today) {
          throw new DomainConflictError("a birthday cannot be in the future");
        }
        // §7.1: the label resolves through the document *inside* the commit, so
        // a rename that landed since the caller's read cannot label the write
        // with a name the household no longer has.
        const actor = await input.actor(tx, await tx.doc(HouseholdDoc));
        const draft = await tx.doc(PuppyDoc);
        if (draft.rev !== input.rev) throw new StaleRevisionError("the profile changed since it was read");

        const before = { ...draft };
        applyPatch(draft, input.patch);
        draft.rev = input.rev + 1;

        appendActivity(
          await tx.doc(ActivityDoc),
          activityEntry({
            kind: "profile.updated",
            summary: summaryOf(before, draft, actor.label),
            actorId: actor.id,
            actorLabel: actor.label,
            now,
          }),
        );
        return { rev: draft.rev };
      },
    );
  } catch (error) {
    if (error instanceof StaleRevisionError) {
      return { kind: "stale", profile: await readProfile(store, context, now) };
    }
    throw error;
  }

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const profile = await readProfile(store, context, now);
  return outcome.kind === "replayed" ? { kind: "replayed", profile } : { kind: "updated", profile };
}
