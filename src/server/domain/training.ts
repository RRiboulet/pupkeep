// The milestone service (PLAN §8.1, §7.3, §7.4, §9.2, §16 P3-04).
//
// Two writers, one document, one commit each:
//   * `updateMilestone` sets a status and/or a note on a milestone the household
//     already has (a catalog entry or its own), with who and when;
//   * `addCustomMilestone` adds a milestone of the household's own.
//
// Both resolve the actor **inside** the commit from the household the write
// reads (§9.2), write one activity entry and the idempotency record, and answer
// a replay from the recorded result. Neither invents history: undoing a mastery
// is an ordinary status change with its own activity line, so the board never
// has to guess what happened.
//
// There is no revision. Two caregivers changing the same milestone are two
// explicit actions, and the last commit wins with its own who/when — the same
// rule as a feed's action id, without a schedule to protect. The catalog lives
// in the build (`shared/training.ts`), so a catalog edit can never rewrite a
// household's state; a state whose catalog id this build no longer ships stays
// in the document untouched.

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { CustomMilestone, MilestoneState, MilestoneStatus, Training } from "../../shared/domain.ts";
import {
  CUSTOM_ID_PREFIX,
  MILESTONE_CATALOG,
  MILESTONE_NOOP_RULE,
  MILESTONE_NOTE_LIMIT,
  MILESTONE_RULE,
  MILESTONE_TITLE_LIMIT,
  MILESTONE_TITLE_RULE,
  catalogEntry,
  isMilestoneStatus,
  milestoneView,
  type MilestoneView,
  parseCustomMilestone,
  parseMilestoneState,
  parseTrainingList,
} from "../../shared/training.ts";
import { hasControlCharacter } from "../../shared/profile.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorResolver } from "./actor.ts";
import { requestHashOf, runIdempotent, type CommandOutcome } from "./commands.ts";
import { ActivityDoc, HouseholdDoc, TrainingDoc, parseTraining, type DocStore } from "./docs.ts";
import { DomainConflictError, UnavailableError } from "./errors.ts";

/** `app.training` is missing or unreadable; retry once the server has booted. */
export class TrainingUnavailableError extends UnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "TrainingUnavailableError";
  }
}

/** The milestone board. Boot keeps the document present. */
export async function readTraining(store: DocStore, context: Context): Promise<Training> {
  const snapshot = await store.snapshot(TrainingDoc, context);
  const training = snapshot === undefined ? undefined : parseTraining(snapshot);
  if (!training) throw new TrainingUnavailableError("the milestone board is not available; retry after boot");
  return training;
}

/**
 * The board as the route, the POST answers and the agent tool read it: six
 * lines in one place, so P3-05 does not assemble `readTraining` + `milestoneView`
 * twice and let the two surfaces drift.
 */
export async function readTrainingView(store: DocStore, context: Context): Promise<MilestoneView[]> {
  return milestoneView(await readTraining(store, context));
}

/** A milestone the household has: a catalog entry this build ships, or its own. */
function titleOf(training: Training, id: string): string | undefined {
  const custom = training.custom.find((entry) => entry.id === id);
  if (custom) return custom.title;
  return catalogEntry(id)?.title;
}

/**
 * The note a change leaves behind: absent keeps what is there, `null` or an
 * empty string clears it, text replaces it. Normalised before hashing, so a
 * retry with padded text is the same request (§7.3).
 */
type NoteChange = { readonly op: "keep" } | { readonly op: "clear" } | { readonly op: "set"; readonly text: string };

function noteChange(note: string | null | undefined): NoteChange | undefined {
  if (note === undefined) return { op: "keep" };
  if (note === null) return { op: "clear" };
  const trimmed = note.trim();
  if (trimmed === "") return { op: "clear" };
  if (trimmed.length > MILESTONE_NOTE_LIMIT || hasControlCharacter(trimmed)) return undefined;
  return { op: "set", text: trimmed };
}

function statusWord(status: MilestoneStatus): string {
  return status === "not_started" ? "not started" : status;
}

/**
 * The one activity sentence for a change, built from what **actually** changed:
 * a same-status call with the note untouched must not claim a note edit, and a
 * `null` note on a milestone that had none must not claim a clear. An explicit
 * re-assert (same status, same note) is still an action, so it reads as the
 * status the caller set.
 */
function milestoneSummary(
  title: string,
  before: MilestoneState | undefined,
  status: MilestoneStatus,
  explicitStatus: MilestoneStatus | undefined,
  noteChanged: boolean,
  noteOp: NoteChange["op"],
): string {
  const quoted = JSON.stringify(title);
  // An untouched milestone is `not_started`, not "missing": a note-only edit on
  // one must not read as a status change.
  const previousStatus = before?.status ?? "not_started";
  if (previousStatus !== status || (explicitStatus !== undefined && !noteChanged)) {
    if (status === "mastered") return `marked ${quoted} mastered`;
    if (status === "practicing") return `started practicing ${quoted}`;
    return `set ${quoted} to ${statusWord(status)}`;
  }
  if (noteOp === "clear") return `cleared the note on ${quoted}`;
  return `${before?.note === undefined ? "added a note to" : "updated the note on"} ${quoted}`;
}

export type MilestoneUpdate = {
  /** Resolved inside the commit, through the household the write reads. */
  readonly actor: ActorResolver;
  /** The HTTP idempotency key or the agent tool's task id, namespaced (§7.3). */
  readonly actionId: string;
  /** A catalog id this build ships, or one of the household's own. */
  readonly milestoneId: string;
  /** Absent keeps the current status. */
  readonly status?: MilestoneStatus;
  /** Absent keeps the note, `null`/"" clears it, text replaces it. */
  readonly note?: string | null;
  /** `ui` from the route, `agent` from a tool (§9.2 rule 3). */
  readonly source: "ui" | "agent";
  readonly now?: Date;
};

export type MilestoneUpdateOutcome =
  | { kind: "updated" | "replayed"; state: MilestoneState; /** The change, without the actor: "added a note to …" */ summary: string }
  | { kind: "key-conflict" };

/** No such milestone (a typo, a stale screen, or a catalog entry a newer build has). */
export class MilestoneUnknownError extends DomainConflictError {
  constructor() {
    super("that milestone is not on the board; re-read it and try again");
    this.name = "MilestoneUnknownError";
  }
}

/** Another milestone already has this title (catalog or custom). */
export class MilestoneDuplicateError extends DomainConflictError {
  constructor() {
    super(MILESTONE_TITLE_RULE);
    this.name = "MilestoneDuplicateError";
  }
}

/**
 * Change one milestone. At least one of status/note must be present; the status
 * defaults to the current one (or `not_started` for a milestone nobody has
 * touched). `masteredAt` exists exactly while the status is `mastered`.
 */
export async function updateMilestone(
  store: DocStore,
  context: Context,
  input: MilestoneUpdate,
): Promise<MilestoneUpdateOutcome> {
  const now = input.now ?? new Date();
  if (input.status !== undefined && !isMilestoneStatus(input.status)) {
    throw new DomainConflictError(MILESTONE_RULE);
  }
  const note = noteChange(input.note);
  if (!note) throw new DomainConflictError(MILESTONE_RULE);
  if (input.status === undefined && note.op === "keep") {
    // No status and no note: the same sentence the domain uses for a redundant
    // clear, so a caller reads one rule for "nothing to do".
    throw new DomainConflictError(MILESTONE_NOOP_RULE);
  }

  const request = {
    // Trimmed like every other id: a padded retry is the same request (§7.3).
    milestoneId: input.milestoneId.trim(),
    status: input.status ?? null,
    note,
    source: input.source,
  } as JsonObject;

  // The typed refusals (unknown milestone) propagate: they roll the key back
  // with everything else, and the route maps the class to a 409 sentence.
  const outcome: CommandOutcome<{ state: MilestoneState; summary: string }> = await runIdempotent(
    { store, context },
    { key: input.actionId, requestHash: requestHashOf(request), now },
    async (tx) => {
      const household = await tx.doc(HouseholdDoc);
      const actor = await input.actor(tx, household);
      const draft = await tx.doc(TrainingDoc);
      // A session that reached a write without boot (a hand-built harness, a
      // partial restore) still gets a real `createdAt`: an empty one fails the
      // next boot, exactly like the sibling writers' guard.
      if (draft.createdAt === "") draft.createdAt = now.toISOString();
      const milestoneId = input.milestoneId.trim();
      const title = titleOf(draft, milestoneId);
      if (title === undefined) throw new MilestoneUnknownError();
      const before = draft.states.find((entry) => entry.id === milestoneId);
      const status = input.status ?? before?.status ?? "not_started";
      const effectiveNote = note.op === "keep" ? before?.note : note.op === "set" ? note.text : undefined;
      // What really changed decides the activity sentence: a same-status call
      // with the note untouched must not claim a note edit.
      const noteChanged = (before?.note ?? undefined) !== (effectiveNote ?? undefined);
      // A clear on a milestone with no note, or the same text again, changes
      // nothing: refuse it rather than write a state and an activity line that
      // claim a change. A status re-assert is an explicit action and is allowed.
      if (input.status === undefined && !noteChanged) throw new DomainConflictError(MILESTONE_NOOP_RULE);

      const state: MilestoneState = {
        id: milestoneId,
        status,
        updatedAt: now.toISOString(),
        byUserId: actor.id,
        byLabel: actor.label,
        actionId: input.actionId,
        source: input.source,
      };
      if (effectiveNote !== undefined) state.note = effectiveNote;
      if (status === "mastered") {
        // "Mastered at" is when it was mastered: re-marking an already mastered
        // milestone keeps the first instant (the activity feed has the repeat).
        state.masteredAt =
          before?.status === "mastered" && before.masteredAt !== undefined ? before.masteredAt : now.toISOString();
      }

      // Backstop: a document the parser refuses fails the next boot.
      const parsed = parseMilestoneState(state);
      if (!parsed) throw new DomainConflictError(MILESTONE_RULE);
      // Replace in place (a new state appends): the array stays in the order the
      // milestones were first touched, so a document read is stable across saves.
      const existing = draft.states.findIndex((entry) => entry.id === milestoneId);
      const states =
        existing === -1
          ? [...draft.states, parsed]
          : draft.states.map((entry, index) => (index === existing ? parsed : entry));
      if (!parseTrainingList({ states, custom: draft.custom })) {
        throw new DomainConflictError(MILESTONE_RULE);
      }
      draft.states = states;

      const summary = milestoneSummary(title, before, status, input.status, noteChanged, note.op);
      appendActivity(
        await tx.doc(ActivityDoc),
        activityEntry({
          kind: "training.milestone",
          summary: `${actor.label} ${summary}`,
          actorId: actor.id,
          actorLabel: actor.label,
          now,
        }),
      );
      return { state: parsed, summary };
    },
  );

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as {
    state: MilestoneState;
    summary: string;
  };
  return {
    kind: outcome.kind === "replayed" ? "replayed" : "updated",
    state: recorded.state,
    summary: recorded.summary,
  };
}

export type CustomMilestoneWrite = {
  readonly actor: ActorResolver;
  readonly actionId: string;
  readonly title: string;
  /** `ui` from the route, `agent` from a tool (§9.2 rule 3). */
  readonly source: "ui" | "agent";
  readonly now?: Date;
  /** Test seam for the id. */
  readonly id?: string;
};

export type CustomMilestoneOutcome =
  | { kind: "added" | "replayed"; milestone: CustomMilestone }
  | { kind: "key-conflict" };

function titleKey(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * Add a milestone of the household's own. Its id is `custom:<uuid>`, so it can
 * never collide with a catalog id, and its title must not duplicate any
 * milestone the board already shows — two identical rows with different ids
 * would make "which one did we master?" ambiguous.
 */
export async function addCustomMilestone(
  store: DocStore,
  context: Context,
  input: CustomMilestoneWrite,
): Promise<CustomMilestoneOutcome> {
  const now = input.now ?? new Date();
  const title = input.title.trim();
  if (title === "" || title.length > MILESTONE_TITLE_LIMIT) {
    throw new DomainConflictError(MILESTONE_TITLE_RULE);
  }

  const request = { title, source: input.source } as JsonObject;

  const outcome: CommandOutcome<{ milestone: CustomMilestone }> = await runIdempotent(
    { store, context },
    { key: input.actionId, requestHash: requestHashOf(request), now },
    async (tx) => {
      const household = await tx.doc(HouseholdDoc);
      const actor = await input.actor(tx, household);
      const draft = await tx.doc(TrainingDoc);
      if (draft.createdAt === "") draft.createdAt = now.toISOString();
      // Against every title the board shows — the catalog's and the household's —
      // so two identical rows cannot be created in the first place.
      const duplicate =
        MILESTONE_CATALOG.some((entry) => titleKey(entry.title) === titleKey(title)) ||
        draft.custom.some((entry) => titleKey(entry.title) === titleKey(title));
      if (duplicate) throw new DomainConflictError(MILESTONE_TITLE_RULE);

      const milestone: CustomMilestone = {
        id: input.id ?? `${CUSTOM_ID_PREFIX}${randomUUID()}`,
        title,
        createdAt: now.toISOString(),
        byUserId: actor.id,
        byLabel: actor.label,
        actionId: input.actionId,
        source: input.source,
      };

      const parsed = parseCustomMilestone(milestone);
      if (!parsed) throw new DomainConflictError(MILESTONE_TITLE_RULE);
      const custom = [...draft.custom, parsed];
      if (!parseTrainingList({ states: draft.states, custom })) {
        throw new DomainConflictError(MILESTONE_TITLE_RULE);
      }
      draft.custom = custom;

      appendActivity(
        await tx.doc(ActivityDoc),
        activityEntry({
          kind: "training.milestone",
          summary: `${actor.label} added the milestone ${JSON.stringify(parsed.title)}`,
          actorId: actor.id,
          actorLabel: actor.label,
          now,
        }),
      );
      return { milestone: parsed };
    },
  );

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as { milestone: CustomMilestone };
  return { kind: outcome.kind === "replayed" ? "replayed" : "added", milestone: recorded.milestone };
}
