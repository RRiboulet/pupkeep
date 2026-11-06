// Arming the feeding reminders from the meal schedule (P2-09, PLAN §12.2).
//
// The write that changes the schedule is also the write that arms the day's
// reminders, in the same commit: a caregiver who saves their meal times either
// has both or neither. Two rules make that safe to repeat:
//
//   * a reminder is identified by `(slotId, localDate)`. An arm is a task plus a
//     ref in `app.household`, and an arm with the same due instant **reuses** the
//     task while it is still live — saving the same schedule twice must not
//     double every reminder. A ref whose task has gone terminal (a fired or
//     aborted task) is dead, not a reminder: P4-04's reconciliation replaces it,
//     so a re-save cannot trust a stale id;
//   * a rescheduled slot gets a new task, and the old one no-ops when it wakes
//     because its input no longer matches the schedule (`feedReminderDecision`).
//
// What this does **not** do is plan a day in advance: re-arming tomorrow is
// P4-04's planner, which will call `armFeedReminders` from its own commit and
// reconcile a missing task from the persisted refs instead of re-creating it.
//
// A slot whose time (plus the delay) has already passed beyond the grace window
// is not armed at all: a phone that boots at noon must not fire this morning's
// missed reminders in a burst (§12.2).

import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import type { FeedReminderRef, Household, MealSlot } from "../../shared/domain.ts";
import { parseFeedReminderRefs } from "../domain/docs.ts";
import { DomainConflictError, UnavailableError } from "../domain/errors.ts";
import { localDateAt, instantAtLocalWallClock } from "../domain/time.ts";
import { FEED_REMINDER_GRACE_MS, FeedReminder, type FeedReminderInput, reminderDelayMs } from "./feed-reminder.ts";

/**
 * Order-sensitive on purpose: `feedReminders` mirrors the slot order of the
 * schedule that armed it, so a reordered schedule rewrites an otherwise equal
 * list. That is one small household write on a rare save, and it keeps the
 * refs readable in the same order as the meals a caregiver sees.
 */
function sameRefs(a: readonly FeedReminderRef[], b: readonly FeedReminderRef[]): boolean {
  return (
    a.length === b.length &&
    a.every((ref, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        ref.taskId === other.taskId &&
        ref.slotId === other.slotId &&
        ref.localDate === other.localDate &&
        ref.dueAt === other.dueAt
      );
    })
  );
}

/**
 * The reminders today's schedule wants, in slot order. Pure, so the planner and
 * the tests use the same rule as the write: active slots only, the household's
 * delay applied to a wall-clock slot time, and an offset already past its grace
 * window skipped rather than fired late.
 */
export function planFeedReminders(
  household: Pick<Household, "timezone" | "settings">,
  slots: readonly MealSlot[],
  now: Date,
  timezone: string = household.timezone,
): FeedReminderInput[] {
  const localDate = localDateAt(now, timezone);
  const delayMs = reminderDelayMs(household);
  const cutoff = now.getTime() - FEED_REMINDER_GRACE_MS;
  const plan: FeedReminderInput[] = [];
  for (const slot of slots) {
    if (!slot.active) continue;
    const dueAt = instantAtLocalWallClock(localDate, slot.timeLocal, timezone).getTime() + delayMs;
    if (dueAt < cutoff) continue;
    plan.push({ slotId: slot.id, label: slot.label, localDate, dueAt });
  }
  return plan;
}

/**
 * Arm today's feeding reminders inside the schedule's commit. Creates a
 * background task on the hidden system conversation for every reminder that is
 * not already armed at the same instant, and replaces the persisted refs for
 * today. Past days' refs are dropped: their tasks are terminal or will skip.
 *
 * The caller passes the household draft it already holds. That is deliberate:
 * acquiring the document here with `tx.doc()` would **create** a missing
 * household (an empty one with no conversations, which boot refuses), and
 * P4-04's planner is meant to reuse this function from its own commit.
 *
 * The ref, not the task table, is the identity: a same-day A→B→A edit can arm a
 * second task with the same input as the first. Both wake and both decide
 * `due`, and delivery stays exactly-once because the server dedupe key (§12.3)
 * is authoritative. A ref whose task went terminal is replaced on the next arm;
 * scanning the whole task table would buy nothing here.
 */
export async function armFeedReminders(
  tx: Tx,
  household: Household,
  slots: readonly MealSlot[],
  now: Date,
  /**
   * The zone the plan is for. The timezone write passes the new zone before
   * storing it, so the due instants are the ones the caregiver will live in.
   */
  timezone: string = household.timezone,
): Promise<void> {
  // A household without its hidden thread has not booted; creating a task now
  // would either fail or attach it to nothing. Refuse rather than half-arm.
  if (household.systemConversationId <= 0) {
    // Not ready is a 503 sentence, not a 500 and a stack: the one failure
    // mapper lives in `http.ts`, so the domain throws its own class.
    throw new UnavailableError("the household is not ready for reminders yet; retry after boot");
  }

  const plan = planFeedReminders(household, slots, now, timezone);
  const localDate = localDateAt(now, timezone);
  const existing = household.feedReminders;
  const kept = existing.filter((ref) => ref.localDate > localDate);

  // A ref outlives its task: a fired or aborted task is terminal while the ref
  // still names the right instant. Read every ref's state **now**, before the
  // first write of this commit (a table read after a write is `ReadAfterWrite`),
  // so a dead task is replaced rather than trusted.
  const dead = new Set<number>();
  for (const ref of existing) {
    const record = await tx.task(ref.taskId as TaskId);
    if (record === undefined || record.state.status === "terminal") dead.add(ref.taskId);
  }

  const armed: FeedReminderRef[] = [];
  for (const item of plan) {
    const current = existing.find((ref) => ref.slotId === item.slotId && ref.localDate === item.localDate);
    if (current !== undefined && current.dueAt === item.dueAt && !dead.has(current.taskId)) {
      // The same slot, instant and a live task: this already is today's
      // reminder. A ref whose task went terminal is replaced below.
      armed.push(current);
      continue;
    }
    // The plan item is the task's input, field for field: one type, so the
    // arming rule and the waking rule cannot drift apart.
    const taskId = await tx.createTask(
      FeedReminder,
      item,
      {
        ownership: { kind: "conversation" },
        conversationId: household.systemConversationId as ConversationId,
        background: true,
      },
    );
    armed.push({ taskId: Number(taskId), slotId: item.slotId, localDate: item.localDate, dueAt: item.dueAt });
  }

  const next = [...kept, ...armed];
  // Backstop, as `logFeed` does for its event list: a committed document the
  // parser refuses is a boot failure, so a settings value that would build an
  // unstorable `dueAt` (a huge reminder delay) rolls the save back instead.
  if (!parseFeedReminderRefs(next)) {
    throw new DomainConflictError("the feeding reminder delay is out of range; correct it and save the meals again");
  }
  if (!sameRefs(existing, next)) household.feedReminders = next;
}
