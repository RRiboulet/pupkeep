// The daily feed planner (P4-04, PLAN §8.4, §9.1, §10.3, §12.2).
//
// One durable task owns the feeding schedule's day, and only one: it wakes at
// the household-local midnight (and at least every six hours), arms that day's
// per-slot reminders through `armFeedReminders`, and goes back to sleep. Two
// properties matter and are both structural:
//
//   * **no duplicate planner.** The task id lives in `app.household`
//     (`feedPlannerTaskId`), and startup reconciliation (`reconcileFeedReminders`)
//     reuses it while the task is live and creates a replacement only when it is
//     missing, terminal or blocked. A second boot therefore cannot add a second
//     planner that would double every reminder;
//   * **no late burst.** The plan only ever arms today's slots whose due instant
//     is still ahead (`planFeedReminders` skips the rest), so a process that was
//     off for a day plans the next day rather than replaying yesterday's meals.
//
// The task never asks for its conversation's agent, so the hidden system
// conversation it is owned by can never spend budget (§9.1). The time comes from
// the household zone, never the host's (§8.4): the wake instant is the next
// local midnight in that zone, capped in six-hour chunks so a clock jump or a
// zone change is noticed within a chunk rather than a day.

import type { Context } from "@earendil-works/chord";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { dateMinusDays } from "../../shared/dates.ts";
import { FeedingDoc, HouseholdDoc, type DocStore } from "../domain/docs.ts";
import { instantAtLocalWallClock, localDateAt } from "../domain/time.ts";
import { armFeedReminders } from "./schedule.ts";

/** The registered planner kind. */
export const FEED_PLANNER_TASK = "app.feed.planner";
export const FEED_PLANNER_VERSION = 1;

/** Longest single sleep: a clock jump or a zone change is noticed within this. */
export const FEED_PLANNER_SLEEP_CHUNK_MS = 6 * 60 * 60 * 1000;

/** A minute after local midnight, so the planner is safely on the new day. */
export const FEED_PLANNER_MIDNIGHT_GRACE_MS = 60_000;

export type FeedPlannerCheckpoint =
  | {
      phase: "wait";
      /** The household-local date whose reminders are armed. */
      plannedDate?: string;
    }
  | { phase: "plan" };

/**
 * The instant the planner should next reconsider: local midnight of the day
 * after `today`, plus a minute, capped by the sleep chunk. Pure, so the task and
 * the tests agree about when a day is planned, including a DST-side midnight
 * (`instantAtLocalWallClock` resolves a nonexistent hour with its documented
 * rule).
 */
export function feedPlannerWake(
  today: string,
  timezone: string,
  nowMs: number,
  chunkMs = FEED_PLANNER_SLEEP_CHUNK_MS,
): number {
  const nextDay = dateMinusDays(today, -1);
  const midnight = instantAtLocalWallClock(nextDay, "00:00", timezone).getTime();
  return Math.min(midnight + FEED_PLANNER_MIDNIGHT_GRACE_MS, nowMs + chunkMs);
}

/**
 * `wait` checks the day against the checkpoint and either wakes the `plan`
 * phase or sleeps to the next midnight (in chunks). `plan` arms today's
 * reminders in one commit and stores the planned date. The split matters: a
 * phase that sleeps must end there, because a phase reruns from its top after a
 * crash; the plan commit is idempotent (`armFeedReminders` reuses a live task
 * for the same instant), so a rerun cannot double a reminder.
 */
export const FeedPlanner = defineTask<Record<string, never>, FeedPlannerCheckpoint, never>({
  name: FEED_PLANNER_TASK,
  version: FEED_PLANNER_VERSION,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      // The zone decides the day; a missing household (a partial restore) is
      // not a reason to create one from a task — sleep and let boot repair it.
      const household = await runtime.snapshot(HouseholdDoc, context);
      if (household === undefined) {
        await runtime.sleepUntil(
          runtime.now() + FEED_PLANNER_SLEEP_CHUNK_MS,
          { phase: "wait" },
          context,
        );
        return;
      }
      const today = localDateAt(new Date(runtime.now()), household.timezone);
      if (task.state.checkpoint.phase !== "wait" || task.state.checkpoint.plannedDate !== today) {
        // A short commit with no sleep: the plan runs in its own phase, so a
        // crash at either boundary is a rerun of one idempotent step.
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "plan" } }), context);
        return;
      }
      const next = feedPlannerWake(today, household.timezone, runtime.now());
      await runtime.sleepUntil(next, { phase: "wait", plannedDate: today }, context);
    },
    plan: async (_task, runtime, context) => {
      const now = new Date(runtime.now());
      const household = await runtime.snapshot(HouseholdDoc, context);
      const feeding = await runtime.snapshot(FeedingDoc, context);
      if (household === undefined || feeding === undefined) {
        // Nothing to plan against; retry after a chunk rather than marking the
        // day planned. The household is the boot's to create, not a task's.
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait" } }), context);
        return;
      }
      await runtime.commit(async (tx) => {
        // The documents are re-read inside the commit: the snapshot above only
        // decided that they exist, and the zone may have moved since.
        const draft = await tx.doc(HouseholdDoc);
        const current = localDateAt(now, draft.timezone);
        const slots = (await tx.doc(FeedingDoc)).slots;
        // The arm reads the refs' task state before its first write, so a dead
        // ref is replaced by this day's plan rather than trusted.
        await armFeedReminders(tx, draft, slots, now);
        // The state returned from the commit replaces the checkpoint, so the
        // next wake knows today is done and sleeps to midnight.
        return { status: "running", checkpoint: { phase: "wait", plannedDate: current } };
      }, context);
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/**
 * Startup reconciliation (PLAN §12.2): make sure exactly one planner exists and
 * that today's per-slot reminders are armed. It repairs rather than re-creates:
 * a live planner id is kept, a terminal one is replaced, and
 * `armFeedReminders` reuses a live slot task for the same instant while
 * replacing a dead ref (a task that already went terminal).
 *
 * Runs in one commit, after bootstrap and before scheduling resumes. A failure
 * is logged by the caller; the next boot retries, and the next schedule write
 * also arms, so a missed reconciliation cannot silently stop reminders.
 */
export type FeedPlannerReconciliation = {
  /** Whether a planner task was created (missing or terminal). */
  createdPlanner: boolean;
  plannerTaskId: number | null;
  /** How many slot reminders were newly armed or replaced. */
  armedReminders: number;
};

export async function reconcileFeedReminders(
  store: DocStore,
  context: Context,
  now: Date,
): Promise<FeedPlannerReconciliation> {
  const existing = await store.snapshot(HouseholdDoc, context);
  if (existing === undefined) {
    // Boot creates the household; a reconciliation before that has nothing to
    // repair and must not create an empty one.
    return { createdPlanner: false, plannerTaskId: null, armedReminders: 0 };
  }

  return store.commit(async (tx) => {
    const household = await tx.doc(HouseholdDoc);
    if (household.systemConversationId <= 0) {
      return { createdPlanner: false, plannerTaskId: null, armedReminders: 0 };
    }
    let plannerTaskId = household.feedPlannerTaskId;
    // Read the planner's state early: every table read must precede the first
    // write of this commit. Only a task that can still run counts as the
    // planner; a terminal one is gone, and a task blocked by a missing
    // definition keeps its live record (the scheduler reports it), so it is
    // reused rather than duplicated.
    const current = plannerTaskId === null ? undefined : await tx.task(plannerTaskId as TaskId);
    const live = current !== undefined && current.state.status !== "terminal";

    const before = new Set(household.feedReminders.map((ref) => ref.taskId));
    await armFeedReminders(tx, household, (await tx.doc(FeedingDoc)).slots, now);

    let createdPlanner = false;
    if (!live) {
      plannerTaskId = Number(
        await tx.createTask(
          FeedPlanner,
          {},
          {
            ownership: { kind: "conversation" },
            conversationId: household.systemConversationId as ConversationId,
            background: true,
          },
        ),
      );
      household.feedPlannerTaskId = plannerTaskId;
      createdPlanner = true;
    }
    const armedReminders = household.feedReminders.filter((ref) => !before.has(ref.taskId)).length;
    return { createdPlanner, plannerTaskId, armedReminders };
  }, context);
}
