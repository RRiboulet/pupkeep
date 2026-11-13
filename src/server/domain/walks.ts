// The walk service (PLAN §8.3, §7.3, §8.5, §9.2).
//
// Two writers, one document, one commit each:
//   * `startWalk` appends one record and returns it. At most one walk is open;
//     starting while one is open is a conflict that carries the open walk, and
//     once that walk is §8.5-stale the conflict says so — a new start stays
//     blocked until the walk is ended (the discard path is P2-07's decision).
//   * `endWalk` closes the walk with the caregiver's observations. The same
//     action id replays as success; a *different* action on an ended walk is a
//     conflict carrying the record, so the loser of a race learns who ended it
//     and when instead of being told "nothing is open" (§7.3, §9.1).
//
// Both timestamps come from the server clock (`now`), never from a client: a
// phone's clock skew must not reorder two caregivers' walks (§8.4). A walk needs
// no revision — its natural key is "the open one" and its history is append-only.
//
// Each commit writes the walk, one activity entry and the idempotency record; a
// crash at any boundary leaves either all of it or none.
//
// The refusals below are internal sentinels, thrown inside the commit so the key
// and the activity entry roll back, then translated to outcomes. The sentences a
// caregiver reads come from `shared/walks.ts`, so the route and the tool (P2-07)
// cannot drift.

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Walk, Walks } from "../../shared/domain.ts";
import { archiveCutoff, monthOf } from "../../shared/dates.ts";
import {
  WALK_NONE_OPEN_MESSAGE,
  parseWalksArchive,
  WALK_OBSERVATION_RULE,
  lastEndedWalk,
  openWalk,
  parseWalkList,
  parseWalkObservations,
  walkEndedMessage,
  walkIsStale,
  walkOpenMessage,
  type WalkObservations,
} from "../../shared/walks.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorResolver } from "./actor.ts";
import { requestHashOf, runIdempotent } from "./commands.ts";
import {
  ActivityDoc,
  HouseholdDoc,
  WalksArchiveDoc,
  WalksDoc,
  parseHousehold,
  parseWalks,
  type DocStore,
} from "./docs.ts";
import { DomainConflictError, UnavailableError } from "./errors.ts";
import { localDateAt } from "./time.ts";

/** `app.walks` is missing or unreadable; retry once the server has booted. */
export class WalksUnavailableError extends UnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "WalksUnavailableError";
  }
}

/** An open walk blocks another start; the caller answers 409 with it. */
class WalkOpenRefusal extends DomainConflictError {
  readonly walk: Walk;
  readonly stale: boolean;

  constructor(walk: Walk, stale: boolean) {
    super(walkOpenMessage(walk, stale));
    this.name = "WalkOpenRefusal";
    this.walk = walk;
    this.stale = stale;
  }
}

/** An end found a walk that is already closed; the caller answers 409 with it. */
class WalkEndedRefusal extends DomainConflictError {
  readonly walk: Walk;

  constructor(walk: Walk) {
    super(walkEndedMessage(walk));
    this.name = "WalkEndedRefusal";
    this.walk = walk;
  }
}

/** Nothing to end, and no ended walk to explain it. */
class WalkMissingRefusal extends DomainConflictError {
  constructor(message = WALK_NONE_OPEN_MESSAGE) {
    super(message);
    this.name = "WalkMissingRefusal";
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
  /**
   * HTTP `Idempotency-Key` or the agent tool's task id, namespaced (§7.3). The
   * caller validates it (`isCommandKey` / `tool:<taskId>`): an unstorable key is
   * a caller bug and fails `runIdempotent` loudly rather than as a 409.
   */
  readonly actionId: string;
  readonly now?: Date;
};

export type WalkStartOutcome =
  | { kind: "started" | "replayed"; walk: Walk }
  /** An open walk exists and is not stale: the caller answers 409 with it. */
  | { kind: "open"; walk: Walk; message: string }
  /** An open walk exists past §8.5's window: 409 until it is resolved. */
  | { kind: "stale"; walk: Walk; message: string }
  | { kind: "key-conflict" };

/**
 * Start a walk. The open-walk check runs inside the callback, after the
 * idempotency lookup, so a replay is never re-judged: a start whose response was
 * lost returns the *current* record — ended, if the other caregiver closed it
 * meanwhile — rather than a stale open copy.
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

        const open = openWalk(walks.walks);
        if (open) {
          // A copy: the error outlives the rolled-back commit.
          throw new WalkOpenRefusal({ ...open }, walkIsStale(open, now));
        }

        const walk: Walk = {
          id: randomUUID(),
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
    if (error instanceof WalkOpenRefusal) {
      return error.stale
        ? { kind: "stale", walk: error.walk, message: error.message }
        : { kind: "open", walk: error.walk, message: error.message };
    }
    throw error;
  }
}

export type WalkEnd = {
  readonly actor: ActorResolver;
  readonly actionId: string;
  /**
   * The walk the form saw. **P2-07's end form must pass it**: with no id the
   * service ends whatever is open now, which is right for the agent tool
   * ("end the walk") but would silently attach a stale form's observations to a
   * walk started since. Omit only for the agent/tool path.
   */
  readonly walkId?: string;
  readonly observations?: WalkObservations;
  readonly now?: Date;
};

export type WalkEndOutcome =
  | { kind: "ended" | "replayed"; walk: Walk }
  /** A different action tried to end an already-closed walk (§7.3: who/when). */
  | { kind: "ended-already"; walk: Walk; message: string }
  /** There is no open walk (and no ended one to explain it). */
  | { kind: "no-open"; message: string }
  | { kind: "key-conflict" };

function durationMinutes(walk: Walk): number {
  const ms = Date.parse(walk.endedAt ?? walk.startedAt) - Date.parse(walk.startedAt);
  return Math.max(0, Math.round(ms / 60_000));
}

/**
 * End a walk. The same action id replays as success — including a retry whose
 * observations were padded or spelled as `""` rather than omitted, because the
 * hash is built from the normalised observations. A *different* action on an
 * ended walk is a conflict carrying the record; with no `walkId`, the most
 * recent ended walk explains a lost race instead of answering "nothing is open".
 */
export async function endWalk(store: DocStore, context: Context, input: WalkEnd): Promise<WalkEndOutcome> {
  // Normalised before hashing and before the commit, so a retry of the same
  // observations is the same request (§7.3).
  const observations = parseWalkObservations(input.observations);
  if (!observations) throw new DomainConflictError(WALK_OBSERVATION_RULE);

  const now = input.now ?? new Date();
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
            ? openWalk(walks.walks)
            : walks.walks.find((candidate) => candidate.id === input.walkId);
        if (!walk) {
          // A lost no-id end race: explain it with the record (§7.3), not with
          // "no open walk" to a caregiver whose partner just ended it.
          const recent = input.walkId === undefined ? lastEndedWalk(walks.walks) : undefined;
          if (recent) throw new WalkEndedRefusal({ ...recent });
          throw new WalkMissingRefusal(
            input.walkId === undefined ? WALK_NONE_OPEN_MESSAGE : "there is no walk with that id",
          );
        }
        if (walk.endedAt !== undefined) throw new WalkEndedRefusal({ ...walk });
        if (now.getTime() < Date.parse(walk.startedAt)) {
          throw new DomainConflictError(
            "the server clock is behind this walk's start; end it once the clock is corrected",
          );
        }

        walk.endedAt = now.toISOString();
        walk.endActionId = input.actionId;
        walk.endedBy = actor.id;
        walk.endedByLabel = actor.label;
        if (observations.pee !== undefined) walk.pee = observations.pee;
        if (observations.poop !== undefined) walk.poop = observations.poop;
        if (observations.dogsMet !== undefined) walk.dogsMet = observations.dogsMet;
        if (observations.mood !== undefined) walk.mood = observations.mood;
        if (observations.notes !== undefined) walk.notes = observations.notes;

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
    if (error instanceof WalkEndedRefusal) {
      return { kind: "ended-already", walk: error.walk, message: error.message };
    }
    if (error instanceof WalkMissingRefusal) return { kind: "no-open", message: error.message };
    throw error;
  }
}

export type WalkDiscard = {
  readonly actor: ActorResolver;
  readonly actionId: string;
  /** The walk the banner showed. Required: a discard names its record. */
  readonly walkId: string;
  readonly now?: Date;
};

export type WalkDiscardOutcome =
  | { kind: "discarded" | "replayed"; walk: Walk }
  | { kind: "ended-already"; walk: Walk; message: string }
  | { kind: "no-open"; message: string }
  | { kind: "key-conflict" };

/**
 * Discard an open walk: close it at the server's now and mark it, because the
 * record cannot claim a trustworthy duration. §8.5's other resolution is an
 * ordinary end; the card offers discard only past its window, because a walk
 * left open overnight must not become a ten-hour "end" in the history.
 */
export async function discardWalk(
  store: DocStore,
  context: Context,
  input: WalkDiscard,
): Promise<WalkDiscardOutcome> {
  const now = input.now ?? new Date();
  const request = { walkId: input.walkId } as JsonObject;

  try {
    const outcome = await runIdempotent(
      { store, context },
      { key: input.actionId, requestHash: requestHashOf(request), now },
      async (tx) => {
        const actor = await input.actor(tx, await tx.doc(HouseholdDoc));
        const walks = await tx.doc(WalksDoc);

        const walk = walks.walks.find((candidate) => candidate.id === input.walkId);
        if (!walk) throw new WalkMissingRefusal("there is no walk with that id");
        if (walk.endedAt !== undefined) throw new WalkEndedRefusal({ ...walk });
        if (now.getTime() < Date.parse(walk.startedAt)) {
          throw new DomainConflictError(
            "the server clock is behind this walk's start; discard it once the clock is corrected",
          );
        }
        // §8.5: discard is the *stale* resolution. A fresh walk has a trustworthy
        // duration, so it is ended, not thrown away.
        if (!walkIsStale(walk, now)) {
          throw new DomainConflictError("that walk is not stale; end it instead of discarding it");
        }

        walk.endedAt = now.toISOString();
        walk.endActionId = input.actionId;
        walk.endedBy = actor.id;
        walk.endedByLabel = actor.label;
        walk.discarded = true;

        const draft = walks.walks.map((candidate) => (candidate.id === walk.id ? { ...walk } : candidate));
        if (!parseWalkList(draft)) throw new DomainConflictError("that walk could not be discarded");
        walks.walks = draft;
        if (walks.createdAt === "") walks.createdAt = now.toISOString();

        appendActivity(
          await tx.doc(ActivityDoc),
          activityEntry({
            kind: "walk.discarded",
            summary: `${actor.label} discarded a walk that was left open`,
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
    return { kind: outcome.kind === "replayed" ? "replayed" : "discarded", walk: recorded.walk };
  } catch (error) {
    if (error instanceof WalkEndedRefusal) {
      return { kind: "ended-already", walk: error.walk, message: error.message };
    }
    if (error instanceof WalkMissingRefusal) return { kind: "no-open", message: error.message };
    throw error;
  }
}

// --- the monthly archive (P5-07) --------------------------------------------

/** Months that stay in `app.walks`: the current one and the previous one. */
export const WALKS_ARCHIVE_KEEP_MONTHS = 2;

export interface WalkArchiveResult {
  readonly moved: number;
  readonly months: readonly string[];
}

/**
 * The closed walks that belong to a month before `cutoff`. An **open** walk is
 * never archivable, whatever its age: it is state a caregiver must resolve
 * (end or discard), and §8.5 keeps a stale walk visible instead of hiding it.
 * The household zone decides the month, from the server timestamp.
 */
export function archivableWalks(walks: Walks, cutoff: string, timezone: string): Walk[] {
  return walks.walks.filter((walk) => {
    if (walk.endedAt === undefined) return false;
    const month = monthOf(localDateAt(new Date(walk.startedAt), timezone));
    return month !== undefined && month < cutoff;
  });
}

/** Chronological, stable: the archive keeps the hot document's order. */
function byStartThenId(left: Walk, right: Walk): number {
  return left.startedAt === right.startedAt ? left.id.localeCompare(right.id) : left.startedAt.localeCompare(right.startedAt);
}

/**
 * Move closed walks older than the hot window into their month's archive, in
 * one commit. Called on boot; idempotent (a second call finds nothing and does
 * not commit). The same measurement that justifies the feed archive applies
 * here: a walk start or end rewrites the whole document, so its cost is linear
 * in the history it holds — ~340 bytes a walk, 2 walks a day.
 */
export async function archiveOldWalks(
  store: DocStore,
  context: Context,
  now: Date = new Date(),
  keepMonths: number = WALKS_ARCHIVE_KEEP_MONTHS,
): Promise<WalkArchiveResult> {
  const [walksSnapshot, householdSnapshot] = await Promise.all([
    store.snapshot(WalksDoc, context),
    store.snapshot(HouseholdDoc, context),
  ]);
  const walks = walksSnapshot === undefined ? undefined : parseWalks(walksSnapshot);
  const household = householdSnapshot === undefined ? undefined : parseHousehold(householdSnapshot);
  if (!walks || household === undefined) {
    throw new WalksUnavailableError("the walk history is not available; retry after boot");
  }
  const cutoff = archiveCutoff(localDateAt(now, household.timezone), keepMonths);
  if (cutoff === undefined) throw new WalksUnavailableError("the household zone cannot date the archive");
  if (archivableWalks(walks, cutoff, household.timezone).length === 0) return { moved: 0, months: [] };

  return store.commit(async (tx) => {
    const draft = await tx.doc(WalksDoc);
    const householdNow = await tx.doc(HouseholdDoc);
    const zone = householdNow.timezone;
    const cutoffNow = archiveCutoff(localDateAt(now, zone), keepMonths);
    if (cutoffNow === undefined) throw new DomainConflictError("the household zone cannot date the archive");

    const moving = archivableWalks(draft, cutoffNow, zone);
    if (moving.length === 0) return { moved: 0, months: [] };

    const byMonth = new Map<string, Walk[]>();
    for (const walk of moving) {
      const month = monthOf(localDateAt(new Date(walk.startedAt), zone))!;
      const list = byMonth.get(month) ?? [];
      list.push(walk);
      byMonth.set(month, list);
    }

    const createdAt = now.toISOString();
    for (const [month, walksOfMonth] of [...byMonth.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const archive = await tx.doc(WalksArchiveDoc, month, month);
      const known = new Set(archive.walks.map((walk) => walk.id));
      const merged = [...archive.walks, ...walksOfMonth.filter((walk) => !known.has(walk.id))].sort(byStartThenId);
      if (archive.createdAt === "") archive.createdAt = createdAt;
      const parsed = parseWalksArchive({ ...archive, walks: merged }, month);
      if (!parsed) throw new DomainConflictError("that month's walk archive is not a shape this build understands");
      archive.walks = parsed.walks;
    }

    const movingIds = new Set(moving.map((walk) => walk.id));
    draft.walks = draft.walks.filter((walk) => !movingIds.has(walk.id));
    if (!parseWalkList(draft.walks)) throw new DomainConflictError("the walk history could not be pruned");
    return { moved: moving.length, months: [...byMonth.keys()].sort() };
  }, context);
}
