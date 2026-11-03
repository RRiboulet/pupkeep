// The walk service (PLAN §8.3, §7.3, §8.5, §9.2).
//
// Two writers, one document, one commit each:
//   * `startWalk` appends one record and returns it. At most one walk is open;
//     starting while one is open is a conflict that carries the open walk, and
//     once that walk is §8.5-stale the conflict says so — a new start stays
//     blocked until the walk is ended (or P2-07 offers a discard).
//   * `endWalk` closes the open walk with the caregiver's observations. Ending
//     an ended walk is a conflict that carries the record, and the same action
//     id replays as success.
//
// Both timestamps come from the server clock (`now`), never from a client: a
// phone's clock skew must not reorder two caregivers' walks (§8.4). A walk needs
// no revision — its natural key is "the open one" and its history is append-only.
//
// Each commit writes the walk, one activity entry and the idempotency record; a
// crash at any boundary leaves either all of it or none.

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Walk, Walks } from "../../shared/domain.ts";
import { WALK_STALE_AFTER_MS, parseWalks as parseWalkList, walkIsStale } from "../../shared/walks.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorResolver } from "./actor.ts";
import { requestHashOf, runIdempotent } from "./commands.ts";
import { ActivityDoc, HouseholdDoc, WalksDoc, parseWalks, type DocStore } from "./docs.ts";
import { DomainConflictError, UnavailableError } from "./errors.ts";

/** `app.walks` is missing or unreadable; retry once the server has booted. */
export class WalksUnavailableError extends UnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "WalksUnavailableError";
  }
}

/** An open walk blocks another start; the caller answers 409 with it. */
export class WalkOpenError extends DomainConflictError {
  readonly walk: Walk;
  /** §8.5: the blocking walk has been open past its window. */
  readonly stale: boolean;

  constructor(walk: Walk, stale: boolean) {
    super(
      stale
        ? `${walk.startedByLabel} left a walk open over ${WALK_STALE_AFTER_MS / 3_600_000} hours ago; end it before starting another`
        : `${walk.startedByLabel} is already walking; end that walk before starting another`,
    );
    this.name = "WalkOpenError";
    this.walk = walk;
    this.stale = stale;
  }
}

/** There is no open walk (or no walk with the given id) to end. */
export class WalkMissingError extends DomainConflictError {
  constructor() {
    super("there is no open walk to end");
    this.name = "WalkMissingError";
  }
}

/** A different action tried to end a walk that is already closed. */
export class WalkEndedError extends DomainConflictError {
  readonly walk: Walk;

  constructor(walk: Walk) {
    super(`${walk.endedByLabel ?? walk.startedByLabel} already ended this walk`);
    this.name = "WalkEndedError";
    this.walk = walk;
  }
}

export async function readWalks(store: DocStore, context: Context): Promise<Walks> {
  const snapshot = await store.snapshot(WalksDoc, context);
  const walks = snapshot === undefined ? undefined : parseWalks(snapshot);
  if (!walks) throw new WalksUnavailableError("the walk history is not available; retry after boot");
  return walks;
}

export type WalkStart = {
  readonly actor: ActorResolver;
  /** HTTP `Idempotency-Key` or the agent tool's task id, namespaced (§7.3). */
  readonly actionId: string;
  readonly now?: Date;
  /** Test seam for the record id. */
  readonly walkId?: string;
};

export type WalkStartOutcome =
  | { kind: "started" | "replayed"; walk: Walk }
  /** An open walk exists and is not stale: the caller answers 409 with it. */
  | { kind: "open"; walk: Walk }
  /** An open walk exists past §8.5's window: 409 until it is resolved. */
  | { kind: "stale"; walk: Walk }
  | { kind: "key-conflict" };

/**
 * Start a walk. The open-walk check runs inside the callback, after the
 * idempotency lookup, so a replay is never re-judged: a start whose response was
 * lost returns the recorded walk even after the other caregiver ended it.
 */
export async function startWalk(store: DocStore, context: Context, input: WalkStart): Promise<WalkStartOutcome> {
  const now = input.now ?? new Date();
  const request = {} as JsonObject;

  try {
    const outcome = await runIdempotent(
      { store, context },
      { key: input.actionId, requestHash: requestHashOf(request), now },
      async (tx) => {
        // Resolve the actor from the household the transaction reads (§9.2).
        const actor = await input.actor(tx, await tx.doc(HouseholdDoc));
        const walks = await tx.doc(WalksDoc);

        const open = walks.walks.find((walk) => walk.endedAt === undefined);
        if (open) {
          // A draft copy: the error outlives the rolled-back commit.
          throw new WalkOpenError({ ...open }, walkIsStale(open, now));
        }

        const walk: Walk = {
          id: input.walkId ?? randomUUID(),
          startedAt: now.toISOString(),
          startedActionId: input.actionId,
          startedBy: actor.id,
          startedByLabel: actor.label,
        };
        const draft = [...walks.walks, walk];
        // Backstop, not the primary check: a document the parser refuses fails
        // boot, so the list is validated before it is stored.
        if (!parseWalkList(draft)) throw new DomainConflictError("that walk could not be started");
        walks.walks = draft;
        if (walks.createdAt === "") walks.createdAt = now.toISOString();

        appendActivity(
          await tx.doc(ActivityDoc),
          activityEntry({
            kind: "walk.started",
            summary: `${actor.label} started a walk`,
            actorId: actor.id,
            actorLabel: actor.label,
            now,
          }),
        );
        return { walk };
      },
    );

    if (outcome.kind === "conflict") return { kind: "key-conflict" };
    const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as { walk: Walk };
    if (outcome.kind === "replayed") {
      // The recorded result is the walk as it was at the start; the current
      // record may have been ended since, and the caller wants the truth.
      const current = (await readWalks(store, context)).walks.find((walk) => walk.id === recorded.walk.id);
      return { kind: "replayed", walk: current ?? recorded.walk };
    }
    return { kind: "started", walk: recorded.walk };
  } catch (error) {
    if (error instanceof WalkOpenError) {
      return error.stale ? { kind: "stale", walk: error.walk } : { kind: "open", walk: error.walk };
    }
    throw error;
  }
}

export type WalkObservations = {
  readonly pee?: number;
  readonly poop?: number;
  readonly dogsMet?: string;
  readonly mood?: string;
  readonly notes?: string;
};

export type WalkEnd = {
  readonly actor: ActorResolver;
  readonly actionId: string;
  /** Omit to end the open walk; a stale banner targets one explicitly. */
  readonly walkId?: string;
  readonly observations?: WalkObservations;
  readonly now?: Date;
};

export type WalkEndOutcome =
  | { kind: "ended" | "replayed"; walk: Walk }
  /** A different action tried to end a walk that is already closed. */
  | { kind: "ended-already"; walk: Walk }
  /** There is no open walk (or no walk with the given id) to end. */
  | { kind: "no-open" }
  | { kind: "key-conflict" };

function durationMinutes(walk: Walk): number {
  const ms = Date.parse(walk.endedAt ?? walk.startedAt) - Date.parse(walk.startedAt);
  return Math.max(0, Math.round(ms / 60_000));
}

/** Trimmed free text; an empty observation is absent, not an empty string. */
function observationText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * End a walk. The same action id replays as success; a *different* action on an
 * ended walk is a conflict carrying the record; a stale walk can be ended (that
 * is the resolution) but never auto-closed.
 */
export async function endWalk(store: DocStore, context: Context, input: WalkEnd): Promise<WalkEndOutcome> {
  const now = input.now ?? new Date();
  const observations = input.observations ?? {};
  const request = {
    walkId: input.walkId ?? null,
    pee: observations.pee ?? null,
    poop: observations.poop ?? null,
    dogsMet: observations.dogsMet ?? null,
    mood: observations.mood ?? null,
    notes: observations.notes ?? null,
  } as JsonObject;

  try {
    const outcome = await runIdempotent(
      { store, context },
      { key: input.actionId, requestHash: requestHashOf(request), now },
      async (tx) => {
        const actor = await input.actor(tx, await tx.doc(HouseholdDoc));
        const walks = await tx.doc(WalksDoc);

        const walk =
          input.walkId === undefined
            ? walks.walks.find((candidate) => candidate.endedAt === undefined)
            : walks.walks.find((candidate) => candidate.id === input.walkId);
        if (!walk) throw new WalkMissingError();
        if (walk.endedAt !== undefined) throw new WalkEndedError({ ...walk });

        walk.endedAt = now.toISOString();
        walk.endActionId = input.actionId;
        walk.endedBy = actor.id;
        walk.endedByLabel = actor.label;
        const pee = observations.pee;
        if (pee !== undefined) walk.pee = pee;
        const poop = observations.poop;
        if (poop !== undefined) walk.poop = poop;
        const dogsMet = observationText(observations.dogsMet);
        if (dogsMet !== undefined) walk.dogsMet = dogsMet;
        const mood = observationText(observations.mood);
        if (mood !== undefined) walk.mood = mood;
        const notes = observationText(observations.notes);
        if (notes !== undefined) walk.notes = notes;

        const minutes = durationMinutes(walk);
        const draft = walks.walks.map((candidate) => (candidate.id === walk.id ? { ...walk } : candidate));
        if (!parseWalkList(draft)) throw new DomainConflictError("that walk could not be saved");
        walks.walks = draft;
        if (walks.createdAt === "") walks.createdAt = now.toISOString();

        appendActivity(
          await tx.doc(ActivityDoc),
          activityEntry({
            kind: "walk.ended",
            summary: `${actor.label} ended a walk (${minutes} ${minutes === 1 ? "minute" : "minutes"})`,
            actorId: actor.id,
            actorLabel: actor.label,
            now,
          }),
        );
        return { walk: { ...walk } };
      },
    );

    if (outcome.kind === "conflict") return { kind: "key-conflict" };
    const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as { walk: Walk };
    return { kind: outcome.kind === "replayed" ? "replayed" : "ended", walk: recorded.walk };
  } catch (error) {
    if (error instanceof WalkEndedError) return { kind: "ended-already", walk: error.walk };
    if (error instanceof WalkMissingError) return { kind: "no-open" };
    throw error;
  }
}
