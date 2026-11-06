// The meal schedule and the meals logged against it (PLAN §8.1, §7.3, §8.5).
//
// Two writers, one document, one commit each:
//   * P1-14's first-run wizard replaces the schedule and bumps `rev`, so two
//     caregivers editing the schedule from the same read cannot silently
//     overwrite each other;
//   * P2-02's `logFeed` appends one meal. That is the plan's "partial unique
//     index" enforced where a conflict can still be answered with 409: the same
//     `(slotId, localDate)` twice is refused with who/when, not appended. A
//     feed does **not** bump `rev`: `rev` is the schedule's revision, and a
//     caregiver logging breakfast must not invalidate a wizard that is open on
//     the other phone.
//
// A logged feed is one commit: the event, the activity entry, the notification
// intents and the idempotency record land together or not at all (§7.2).
//
// The slots are wall-clock times in the household zone (§8.4). This module
// stores what the household eats when; turning a slot into an instant is
// `domain/time.ts`'s `instantAtLocalWallClock` (the one DST rule), and the
// schedule write arms today's reminders with it in the same commit (P2-09).

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { JsonObject, Tx } from "@earendil-works/pi-durable";
import type { FeedEvent, Feeding, MealSlot, NotificationIntent } from "../../shared/domain.ts";
import { MEAL_SCHEDULE_RULE, parseFeedEvent, parseFeedEvents, parseMealSlots } from "../../shared/feeding.ts";
import { notificationIntent, notificationKey } from "../../shared/notifications.ts";
import { appendNotificationIntents } from "../notifications/intents.ts";
import { armFeedReminders } from "../reminders/schedule.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorRef, ActorResolver } from "./actor.ts";
import { outcomeOf, requestHashOf, runIdempotent, type CommandOutcome, type WriteOutcome } from "./commands.ts";
import { ActivityDoc, FeedingDoc, HouseholdDoc, NotificationsDoc, parseFeeding, type DocStore } from "./docs.ts";
import { DomainConflictError, StaleRevisionError, UnavailableError } from "./errors.ts";
import { localDateAt, localTimeAt } from "./time.ts";

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

/**
 * The commit half of a schedule save, shared by the wizard's route and an
 * approved agent proposal (§9.3, §10.3). Runs entirely inside the caller's
 * transaction: the schedule, today's re-armed reminders and the activity line
 * land together or not at all.
 */
export type MealSlotCommit = {
  /** Already resolved from the household this transaction reads (§9.2). */
  readonly actor: ActorRef;
  readonly actionId: string;
  /** The revision the caller read; a stale one writes nothing. */
  readonly rev: number;
  /** One to twelve slots, at least one active, distinct times (§8.1). */
  readonly slots: unknown;
  readonly now: Date;
};

function mealCount(count: number): string {
  return `${count} ${count === 1 ? "meal" : "meals"}`;
}

/**
 * Replace the schedule inside the caller's commit. The whole list is written
 * rather than patched slot by slot: the wizard edits one schedule, and one
 * commit is what a caregiver's save means (§7.2). The parser runs here, after
 * the caller's idempotency lookup, so the document can never hold a schedule no
 * reader can parse.
 */
export async function updateMealSlotsIn(tx: Tx, input: MealSlotCommit): Promise<{ rev: number; count: number }> {
  const slots = parseMealSlots(input.slots);
  if (!slots) throw new DomainConflictError(MEAL_SCHEDULE_RULE);
  const household = await tx.doc(HouseholdDoc);
  const draft = await tx.doc(FeedingDoc);
  if (draft.rev !== input.rev) throw new StaleRevisionError("the meal schedule changed since it was read");

  const first = draft.slots.length === 0;

  // P2-09: the same commit arms today's feeding reminders on the hidden system
  // conversation (§12.2). A reschedule re-arms; an unchanged schedule reuses the
  // tasks it already has. It runs before the schedule write because it reads the
  // reminder tasks' state, and a table read after a write is `ReadAfterWrite`.
  await armFeedReminders(tx, household, slots, input.now);

  draft.slots = slots;
  draft.rev = input.rev + 1;

  appendActivity(
    await tx.doc(ActivityDoc),
    activityEntry({
      kind: "feeding.slots",
      // Counts only: a slot label is caregiver free text and does not belong in
      // a one-line feed a partner reads at a glance.
      summary: first
        ? `${input.actor.label} set the meal schedule (${mealCount(slots.length)})`
        : `${input.actor.label} updated the meal schedule (${mealCount(slots.length)})`,
      actorId: input.actor.id,
      actorLabel: input.actor.label,
      now: input.now,
    }),
  );
  return { rev: draft.rev, count: slots.length };
}

/**
 * Replace the schedule from a route or a tool: one idempotent commit around
 * `updateMealSlotsIn`. A replay of the same key and body returns the recorded
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
        const household = await tx.doc(HouseholdDoc);
        const actor = await input.actor(tx, household);
        const committed = await updateMealSlotsIn(tx, {
          actor,
          actionId: input.actionId,
          rev: input.rev,
          slots: input.slots,
          now,
        });
        return { rev: committed.rev, count: committed.count };
      },
    );
  } catch (error) {
    if (error instanceof StaleRevisionError) return "stale";
    throw error;
  }

  return outcomeOf(outcome);
}

// --- logging a meal (P2-02) -------------------------------------------------

/**
 * A different action already fed this slot on this local date (§7.3). Carries
 * the committed record so the HTTP route can answer 409 with who/when instead
 * of a bare message.
 */
export class FeedConflictError extends DomainConflictError {
  /** The committed feed that claimed the slot; the route answers 409 with it. */
  readonly existing: FeedEvent;

  constructor(existing: FeedEvent, message: string) {
    super(message);
    this.name = "FeedConflictError";
    this.existing = existing;
  }
}

export type FeedWrite = {
  /** Resolved inside the commit, through the household the write reads. */
  readonly actor: ActorResolver;
  /** The HTTP idempotency key or the agent tool's task id, namespaced (§7.3). */
  readonly actionId: string;
  /** A meal slot, or `null` for an extra feeding. */
  readonly slotId: string | null;
  readonly amount?: string;
  readonly note?: string;
  /** `ui` from the routes, `agent` from a tool (P2-03/P2-04). */
  readonly source: FeedEvent["source"];
  /** Server clock; injected by tests. */
  readonly now?: Date;
  /** Test seam for the event id. */
  readonly eventId?: string;
};

export type FeedOutcome =
  | { kind: "logged"; event: FeedEvent }
  /** The same action, already committed: success, not a conflict (§7.3). */
  | { kind: "replayed"; event: FeedEvent }
  /** One idempotency key was reused for a different request. */
  | { kind: "key-conflict" };

/** `"Breakfast"`: free text stays visibly data in a one-line log (§9.5). */
function quoted(text: string): string {
  return JSON.stringify(text);
}

/**
 * Append one meal. The slot must exist and be active; an extra feeding has no
 * slot and never claims one. Everything the plan calls for lands in the same
 * commit: the event, one activity entry, one notification intent per *other*
 * household member, and the idempotency record.
 *
 * The checks that depend on the clock (the local date) and on the committed
 * document (the slot, the existing feed) run inside the callback, after the
 * idempotency lookup, so a replay is never re-judged.
 */
export async function logFeed(store: DocStore, context: Context, input: FeedWrite): Promise<FeedOutcome> {
  const now = input.now ?? new Date();
  // Normalised once, so "no amount" and "an empty amount" are the same request:
  // otherwise the same key retried with `""` instead of absent would report a
  // key collision for a body that stores the same event.
  const amount = input.amount?.trim() || undefined;
  const note = input.note?.trim() || undefined;
  // One request, one hash: the same meal on the same channel. The actor and the
  // clock are resolved inside the commit and are not the client's to vary;
  // `source` is caller-derived, so a route and a tool reusing one key is a key
  // conflict rather than a silent replay under the wrong channel.
  const request = {
    slotId: input.slotId,
    amount: amount ?? null,
    note: note ?? null,
    source: input.source,
  } as JsonObject;

  const outcome: CommandOutcome<{ event: FeedEvent }> = await runIdempotent(
    { store, context },
    { key: input.actionId, requestHash: requestHashOf(request), now },
    async (tx) => {
      const household = await tx.doc(HouseholdDoc);
      const actor = await input.actor(tx, household);
      const localDate = localDateAt(now, household.timezone);
      const feeding = await tx.doc(FeedingDoc);

      let slot: MealSlot | undefined;
      if (input.slotId !== null) {
        slot = feeding.slots.find((candidate) => candidate.id === input.slotId);
        if (!slot) throw new DomainConflictError("that meal time is no longer in the schedule");
        if (!slot.active) throw new DomainConflictError("that meal time is not active");

        const existing = feeding.events.find(
          (event) => event.slotId === input.slotId && event.localDate === localDate,
        );
        if (existing) {
          // §7.3: a different action for an already-fed slot is a conflict with
          // who/when — never a second event. The copy is deliberate: the error
          // is read after the commit has rolled back, when the draft it came
          // from can no longer be touched.
          const copy: FeedEvent = { ...existing };
          throw new FeedConflictError(
            copy,
            `${copy.byLabel} already logged this meal at ${localTimeAt(new Date(copy.at), household.timezone)}`,
          );
        }
      }

      const event: FeedEvent = {
        id: input.eventId ?? randomUUID(),
        slotId: input.slotId,
        localDate,
        at: now.toISOString(),
        byUserId: actor.id,
        byLabel: actor.label,
        source: input.source,
        actionId: input.actionId,
      };
      if (amount !== undefined) event.amount = amount;
      if (note !== undefined) event.note = note;

      // Backstop, not the primary check: a document the parser refuses fails
      // boot (§8.1), so the list is validated before it is stored. The slot and
      // conflict checks above are what a caregiver sees; this one rolls a buggy
      // append back instead of wedging the household.
      const parsed = parseFeedEvent(event);
      if (!parsed) throw new DomainConflictError("that meal could not be logged; check the amount and note");
      const events = [...feeding.events, parsed];
      if (!parseFeedEvents(events)) throw new DomainConflictError("that meal could not be logged");
      feeding.events = events;

      // One description of the action, reused by the activity entry, the intent
      // body and the dedupe key, so the three cannot drift.
      const time = localTimeAt(now, household.timezone);
      const subject =
        slot === undefined
          ? { key: ["extra", parsed.id], summary: `${actor.label} added an extra feeding` }
          : { key: ["slot", slot.id], summary: `${actor.label} fed ${quoted(slot.label)}` };
      const body = `${subject.summary} at ${time}`;

      appendActivity(
        await tx.doc(ActivityDoc),
        activityEntry({
          kind: "feed.logged",
          summary: subject.summary,
          actorId: actor.id,
          actorLabel: actor.label,
          now,
        }),
      );

      // The partner's signal, committed here and delivered in P4. One intent per
      // other caregiver; the actor never notifies themselves.
      const intents: NotificationIntent[] = [];
      for (const member of household.members) {
        if (actor.id !== null && member.id === actor.id) continue;
        intents.push(
          notificationIntent({
            // Encoded parts joined by `|`, so two ids cannot run together into
            // one key and silently drop an intent (§12.3).
            dedupeKey: notificationKey("fed", localDate, ...subject.key, member.id),
            category: "fed",
            userId: member.id,
            body,
            now,
          }),
        );
      }
      // Same backstop as the event list: a list the parser refuses rolls the
      // whole feed back rather than storing a document boot cannot read.
      await appendNotificationIntents(tx, intents, now);

      return { event: parsed };
    },
  );

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as { event: FeedEvent };
  return { kind: outcome.kind === "replayed" ? "replayed" : "logged", event: recorded.event };
}
