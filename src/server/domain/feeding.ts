// The meal schedule (PLAN §8.1: `app.feeding` holds the meal slots; P2-01 adds
// the feed events and the service that logs against them).
//
// P1-14's first-run wizard is the only writer today. It goes through the same
// commit discipline as every other care write: one `harness.commit` writes the
// slots, the bumped revision, the activity entry and the idempotency record, or
// nothing at all. `rev` is optimistic concurrency, exactly as on `app.puppy`:
// two caregivers editing the schedule from the same read cannot silently
// overwrite each other; the second save is refused with the current schedule.
//
// The slots are wall-clock times in the household zone (§8.4). Nothing here
// turns a slot into an instant: that is P4's planner, and it is where the DST
// rules live. This module only stores what the household eats when.

import type { Context } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Feeding, MealSlot } from "../../shared/domain.ts";
import { MEAL_SCHEDULE_RULE, parseMealSlots } from "../../shared/feeding.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorResolver } from "./actor.ts";
import { outcomeOf, requestHashOf, runIdempotent, type CommandOutcome, type WriteOutcome } from "./commands.ts";
import { ActivityDoc, FeedingDoc, HouseholdDoc, parseFeeding, type DocStore } from "./docs.ts";
import { DomainConflictError, StaleRevisionError, UnavailableError } from "./errors.ts";

/** `app.feeding` is missing or unreadable; retry once the server has booted. */
export class FeedingUnavailableError extends UnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "FeedingUnavailableError";
  }
}

/** The household's meal schedule. Boot keeps the document present. */
export async function readFeeding(store: DocStore, context: Context): Promise<Feeding> {
  const snapshot = await store.snapshot(FeedingDoc, context);
  const feeding = snapshot === undefined ? undefined : parseFeeding(snapshot);
  if (!feeding) {
    throw new FeedingUnavailableError("the meal schedule is not available; retry after boot");
  }
  return feeding;
}

export type MealSlotWrite = {
  /** Resolved inside the commit; the label is the household's current one. */
  readonly actor: ActorResolver;
  /** The HTTP `Idempotency-Key`, namespaced by the caller (§7.4's `actionId`). */
  readonly actionId: string;
  /** The schedule revision the caller read. */
  readonly rev: number;
  /** One to twelve slots, at least one active, distinct times (§8.1). */
  readonly slots: readonly MealSlot[];
  readonly now?: Date;
};

function mealCount(count: number): string {
  return `${count} ${count === 1 ? "meal" : "meals"}`;
}

/**
 * Replace the schedule. The whole list is written rather than patched slot by
 * slot: the wizard edits one schedule, and one commit is what a caregiver's
 * save means (§7.2). A replay of the same key and body returns the recorded
 * success even though its own commit bumped the revision.
 */
export async function updateMealSlots(
  store: DocStore,
  context: Context,
  input: MealSlotWrite,
): Promise<WriteOutcome> {
  const now = input.now ?? new Date();
  const request = { rev: input.rev, slots: input.slots } as unknown as JsonObject;
  let outcome: CommandOutcome<{ rev: number; count: number }>;
  try {
    outcome = await runIdempotent(
      { store, context },
      { key: input.actionId, requestHash: requestHashOf(request), now },
      async (tx) => {
        // Validated inside the callback, after the idempotency lookup: the
        // document may never hold a schedule no reader can parse.
        const slots = parseMealSlots(input.slots);
        if (!slots) throw new DomainConflictError(MEAL_SCHEDULE_RULE);
        const actor = await input.actor(tx, await tx.doc(HouseholdDoc));
        const draft = await tx.doc(FeedingDoc);
        if (draft.rev !== input.rev) throw new StaleRevisionError("the meal schedule changed since it was read");

        const first = draft.slots.length === 0;
        draft.slots = slots;
        draft.rev = input.rev + 1;

        appendActivity(
          await tx.doc(ActivityDoc),
          activityEntry({
            kind: "feeding.slots",
            // Counts only: a slot label is caregiver free text and does not
            // belong in a one-line feed a partner reads at a glance.
            summary: first
              ? `${actor.label} set the meal schedule (${mealCount(slots.length)})`
              : `${actor.label} updated the meal schedule (${mealCount(slots.length)})`,
            actorId: actor.id,
            actorLabel: actor.label,
            now,
          }),
        );
        return { rev: draft.rev, count: slots.length };
      },
    );
  } catch (error) {
    if (error instanceof StaleRevisionError) return "stale";
    throw error;
  }

  return outcomeOf(outcome);
}
