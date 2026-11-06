// The feeding reminder task (P2-09, PLAN §10.3, §12.1, §12.2).
//
// A reminder is a durable task, not a timer in the server process: it sleeps
// until the slot's time plus the household's delay, survives a restart, and on
// waking decides — deterministically, with no model — whether the household
// still needs to be told. Everything that could call the model is absent: the
// task never asks for its conversation's agent, so the hidden system
// conversation it is owned by can never spend budget (§9.1, §10.3).
//
// What this task deliberately does **not** do is deliver. P4-05/P4-06 own the
// notification outbox, Web Push and ntfy, and P4-04 owns the daily planner that
// re-arms a day at a time. Today a due reminder commits its decision as the
// task's terminal result and writes nothing; when delivery lands, that is a
// task-definition version bump whose `deliver` phase writes the intents before
// the terminal commit.
//
// Three skips keep a restart from firing a burst of stale reminders (§12.2):
//   * the schedule no longer matches the task (slot removed, deactivated or
//     moved) — an old task no-ops instead of reminding at the wrong time;
//   * the slot was fed for its local date — the reminder is moot;
//   * the wake is past the grace window — a phone that was off for the morning
//     does not announce yesterday's breakfast now.

import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { AppointmentReminder } from "./appointment-reminder.ts";
import { FeedPlanner } from "./feed-planner.ts";
import type { Feeding, Household } from "../../shared/domain.ts";
import { FeedingDoc, HouseholdDoc } from "../domain/docs.ts";
import { instantAtLocalWallClock } from "../domain/time.ts";

/** The registered task kind; P4-04's planner will be `app.feed.planner`. */
export const FEED_REMINDER_TASK = "app.feed.reminder";
export const FEED_REMINDER_VERSION = 1;

/**
 * How late a reminder may still be useful (§12.2's "feeds within a few
 * hours"). The same window decides whether the schedule write arms a slot whose
 * time has just passed, so "skip a passed offset" is one rule in one place.
 */
export const FEED_REMINDER_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * Longest single sleep (§8.5: reminder sleeps are capped in chunks and re-armed
 * after a clock jump). A slot armed this morning for tonight would otherwise
 * sleep through the whole day in one hop, and a phone that was off for a day
 * would wake to a deadline it can no longer reason about.
 */
export const FEED_REMINDER_SLEEP_CHUNK_MS = 6 * 60 * 60 * 1000;

/**
 * The task's input, fixed when the schedule armed it. `dueAt` is the instant
 * the slot becomes overdue: the household-zone slot time plus
 * `settings.feedReminderDelayMin` (§12.1).
 */
export type FeedReminderInput = {
  slotId: string;
  /** The slot's label when armed, for the in-app copy P4 writes. */
  label: string;
  /** `YYYY-MM-DD` in the household zone: the day this reminder belongs to. */
  localDate: string;
  /** Epoch milliseconds on the harness clock. */
  dueAt: number;
};

export type FeedReminderCheckpoint = { phase: "wait" } | { phase: "check" };

/**
 * What the task decided when it woke. `due` is the only outcome that, once
 * delivery exists, writes a notification; the others are skips. The result is
 * committed as the terminal outcome so the decision is inspectable after a
 * restart and P4-04 can reconcile against it.
 */
export type FeedReminderResult =
  /**
   * Unfed and on time: the reminder P4 delivers. `label` is the slot's label at
   * wake time, not the one in the task's input, so a rename between arming and
   * waking cannot put a stale meal name in the in-app copy.
   */
  | { kind: "due"; slotId: string; label: string; localDate: string; dueAt: number }
  | { kind: "fed"; slotId: string; localDate: string; byLabel: string }
  /**
   * The slot was removed, deactivated or moved, so this task is an old arm —
   * or the documents it checks against are absent (a partial restore). Either
   * way the reminder no longer matches the household's schedule.
   */
  | { kind: "rescheduled"; slotId: string; localDate: string }
  /** The wake is later than the grace window; a restart must not fire it now. */
  | { kind: "late"; slotId: string; localDate: string; dueAt: number };

/** Slot time + the household's delay, in milliseconds from the epoch. */
export function reminderDelayMs(household: Pick<Household, "settings">): number {
  // The setting is a number of minutes, not necessarily an integer; the stored
  // `dueAt` must be an integer (it is a clock reading), so round once here.
  return Math.round(household.settings.feedReminderDelayMin * 60_000);
}

/**
 * The pure decision the waking task makes, shared with the tests and, later,
 * with anything else that needs to know whether a reminder is still true.
 *
 * Order matters: a stale arm is not "late" (it is simply no longer this
 * household's reminder), and a fed slot is skipped however late the wake is.
 */
export function feedReminderDecision(
  household: Pick<Household, "timezone" | "settings">,
  feeding: Pick<Feeding, "slots" | "events">,
  input: FeedReminderInput,
  nowMs: number,
): FeedReminderResult {
  const slot = feeding.slots.find((candidate) => candidate.id === input.slotId);
  if (slot === undefined || !slot.active) {
    return { kind: "rescheduled", slotId: input.slotId, localDate: input.localDate };
  }
  const dueAt =
    instantAtLocalWallClock(input.localDate, slot.timeLocal, household.timezone).getTime() +
    reminderDelayMs(household);
  if (dueAt !== input.dueAt) {
    return { kind: "rescheduled", slotId: input.slotId, localDate: input.localDate };
  }
  const fed = feeding.events.find(
    (event) => event.slotId === input.slotId && event.localDate === input.localDate,
  );
  if (fed) {
    return { kind: "fed", slotId: input.slotId, localDate: input.localDate, byLabel: fed.byLabel };
  }
  if (nowMs > input.dueAt + FEED_REMINDER_GRACE_MS) {
    return { kind: "late", slotId: input.slotId, localDate: input.localDate, dueAt: input.dueAt };
  }
  return { kind: "due", slotId: input.slotId, label: slot.label, localDate: input.localDate, dueAt: input.dueAt };
}

/**
 * `wait` parks the task on the harness clock (in chunks), `check` re-reads the
 * committed household and schedule and decides. The split is not cosmetic: a
 * phase that sleeps must end there, because a phase reruns from its top after a
 * crash and work after a sleep would otherwise run twice.
 *
 * The check reads through `runtime.snapshot()`, never `tx.doc()`: acquiring a
 * missing document inside the commit would **create** it (an empty household
 * with no conversations), which is a boot failure a partial restore must not
 * gain from a stray reminder. A missing document is a stale arm like any other.
 */
export const FeedReminder = defineTask<FeedReminderInput, FeedReminderCheckpoint, FeedReminderResult>({
  name: FEED_REMINDER_TASK,
  version: FEED_REMINDER_VERSION,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      const now = runtime.now();
      if (now >= task.input.dueAt) {
        // Armed for a slot that is already due (a schedule saved inside the
        // grace window): no sleep, straight to the decision.
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "check" } }), context);
        return;
      }
      await runtime.sleepUntil(
        Math.min(task.input.dueAt, now + FEED_REMINDER_SLEEP_CHUNK_MS),
        { phase: "wait" },
        context,
      );
    },
    check: async (task, runtime, context) => {
      const household = await runtime.snapshot(HouseholdDoc, context);
      const feeding = await runtime.snapshot(FeedingDoc, context);
      const result: FeedReminderResult =
        household === undefined || feeding === undefined
          ? { kind: "rescheduled", slotId: task.input.slotId, localDate: task.input.localDate }
          : feedReminderDecision(household, feeding, task.input, runtime.now());
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result } }),
        context,
      );
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/**
 * The extension every server process installs. Tasks are resolved by name
 * whichever conversation selects the extension, so the hidden system
 * conversation needs no selection of its own.
 */
export function createReminders(): Extension<ToolRegistration> {
  return { name: "reminders", tasks: [FeedReminder, AppointmentReminder, FeedPlanner] };
}
