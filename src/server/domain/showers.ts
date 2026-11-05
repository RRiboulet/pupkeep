// The shower service (PLAN §8.1, §8.4, §7.3, §9.2, §16 P3-06).
//
// One writer, one document: `logShower` appends a shower and, in the same
// commit, one activity entry and the `app.commands` idempotency record. A
// shower has no revision and no conflict — a second rinse on the same afternoon
// is legitimate, unlike a feed that claims a meal.
//
// The decisions live in `shared/showers.ts` (the shape, the text bounds, the
// derived next due date); this module adds the two things that need the server:
// the clock (which decides `localDate` in the household zone — never client
// input, §8.4) and the actor (resolved inside the commit from the household it
// reads, §9.2).
//
// The interval is **not** read here: the next due date is derived by the route,
// the tool and the card from `app.household.settings.showerIntervalDays`, which
// is the plan's one source for it. A log commit must not need the interval, and
// a settings change must not require re-writing history.

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Household, Shower, Showers } from "../../shared/domain.ts";
import {
  SHOWER_RULE,
  parseShower,
  parseShowerFields,
  parseShowerList,
  showerHistory,
  showerStatus,
  type ShowerView,
} from "../../shared/showers.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorResolver } from "./actor.ts";
import { requestHashOf, runIdempotent, type CommandOutcome } from "./commands.ts";
import { ActivityDoc, HouseholdDoc, ShowersDoc, parseShowers, type DocStore } from "./docs.ts";
import { DomainConflictError, UnavailableError } from "./errors.ts";
import { readHousehold } from "./household.ts";
import { localDateAt } from "./time.ts";

/** `app.showers` is missing or unreadable; retry once the server has booted. */
export class ShowersUnavailableError extends UnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "ShowersUnavailableError";
  }
}

/** The shower history. Boot keeps the document present. */
export async function readShowers(store: DocStore, context: Context): Promise<Showers> {
  const snapshot = await store.snapshot(ShowersDoc, context);
  const showers = snapshot === undefined ? undefined : parseShowers(snapshot);
  if (!showers) throw new ShowersUnavailableError("the shower history is not available; retry after boot");
  return showers;
}

/**
 * The shower surface's one view (P3-07): the history, the derived next due
 * date and the interval, built from the household's own zone and clock. One
 * builder serves the route, the write's answer and the tool, so the card and
 * the model cannot disagree about a due date (the growth precedent).
 */
export function showerView(household: Household, showers: Showers, now: Date): ShowerView {
  const today = localDateAt(now, household.timezone);
  const intervalDays = household.settings.showerIntervalDays;
  return {
    history: showerHistory(showers),
    status: showerStatus(showers, intervalDays, today),
    intervalDays,
  };
}

/** The view from committed documents: one reader behind every surface. */
export async function readShowerView(store: DocStore, context: Context, now: Date): Promise<ShowerView> {
  const [household, showers] = await Promise.all([
    readHousehold(store, context),
    readShowers(store, context),
  ]);
  return showerView(household, showers, now);
}

export type ShowerWrite = {
  /** Resolved inside the commit, through the household the write reads. */
  readonly actor: ActorResolver;
  /** The HTTP idempotency key or the agent tool's task id, namespaced (§7.3). */
  readonly actionId: string;
  readonly shampoo?: string;
  readonly notes?: string;
  /** `ui` from the route, `agent` from a tool (P3-07). */
  readonly source: Shower["source"];
  /** Server clock; injected by tests. */
  readonly now?: Date;
  /** Test seam for the shower id. */
  readonly id?: string;
};

export type ShowerOutcome =
  | { kind: "logged" | "replayed"; shower: Shower }
  /** One idempotency key was reused for a different request. */
  | { kind: "key-conflict" };

/**
 * Append one shower. The clock (the local date) and the actor are resolved
 * inside the callback, so a replay returns the recorded shower rather than
 * re-deriving a date or a label from a later clock or a renamed member.
 */
export async function logShower(store: DocStore, context: Context, input: ShowerWrite): Promise<ShowerOutcome> {
  const now = input.now ?? new Date();

  // Normalised once, so padded text and an absent field describe one request:
  // the same key retried with `"  oatmeal "` and `"oatmeal"` must replay, not
  // collide. `parseShowerFields` is the parser the route and the tool use too.
  const fields = parseShowerFields({
    ...(input.shampoo !== undefined ? { shampoo: input.shampoo } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
  if (!fields) throw new DomainConflictError(SHOWER_RULE);
  const request = {
    shampoo: fields.shampoo ?? null,
    notes: fields.notes ?? null,
    source: input.source,
  } as JsonObject;

  const outcome: CommandOutcome<{ shower: Shower }> = await runIdempotent(
    { store, context },
    { key: input.actionId, requestHash: requestHashOf(request), now },
    async (tx) => {
      const household = await tx.doc(HouseholdDoc);
      const actor = await input.actor(tx, household);
      const localDate = localDateAt(now, household.timezone);

      const shower: Shower = {
        id: input.id ?? randomUUID(),
        localDate,
        at: now.toISOString(),
        byUserId: actor.id,
        byLabel: actor.label,
        source: input.source,
        actionId: input.actionId,
      };
      if (fields.shampoo !== undefined) shower.shampoo = fields.shampoo;
      if (fields.notes !== undefined) shower.notes = fields.notes;

      // Backstop, as `logFeed` does: a document the parser refuses would fail
      // the next boot, so the appended list is validated before it is stored.
      const parsed = parseShower(shower);
      if (!parsed) throw new DomainConflictError(SHOWER_RULE);
      const draft = await tx.doc(ShowersDoc);
      // A session that reached a write without boot (a hand-built harness, a
      // partial restore) still gets a real `createdAt`; an empty one fails the
      // next boot.
      if (draft.createdAt === "") draft.createdAt = now.toISOString();
      const showers = [...draft.showers, parsed];
      if (!parseShowerList(showers)) throw new DomainConflictError(SHOWER_RULE);
      draft.showers = showers;

      appendActivity(
        await tx.doc(ActivityDoc),
        activityEntry({
          kind: "shower.logged",
          // The shampoo is caregiver free text; it stays off the one-line feed
          // (which is what the other caregiver reads at a glance) and on the
          // record.
          summary: `${actor.label} logged a shower`,
          actorId: actor.id,
          actorLabel: actor.label,
          now,
        }),
      );

      return { shower: parsed };
    },
  );

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as { shower: Shower };
  return { kind: outcome.kind === "replayed" ? "replayed" : "logged", shower: recorded.shower };
}
