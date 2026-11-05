// The training extension: the agent's only way to read or change a milestone
// (PLAN §10.1, §10.2, §10.3, §16 P3-05).
//
// The rules the plan sets, and what this file does about them:
//   * app tools only — nothing here touches shell, files, network or SQL;
//   * thin wrappers over the same domain functions HTTP uses (`updateMilestone`,
//     `addCustomMilestone`, `readTrainingView`), never a second implementation,
//     so the board the model changes and the board the screen shows cannot
//     disagree;
//   * both writes are `replay: "safe"` because the domain write is idempotent on
//     `api.taskId`; a rerun after a restart must return the recorded state
//     instead of changing the milestone twice;
//   * the actor is the caregiver who spoke (§9.2), resolved inside the write's
//     own `tx` with the tool task's memo as the crash-rerun short cut — never
//     taken from the model's arguments;
//   * a milestone id comes from `list_milestones` (or a previous answer): the
//     model never invents one, and an unknown id is a refusal it must report.
//
// The answer reports the committed board: the change, then the board grouped by
// status, so the model's next sentence quotes the same state the screen shows.

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  MILESTONE_ID_LIMIT,
  MILESTONE_NOTE_LIMIT,
  MILESTONE_STATUSES,
  MILESTONE_TITLE_LIMIT,
} from "../../shared/training.ts";
import { DomainConflictError, UnavailableError } from "../domain/errors.ts";
import {
  addCustomMilestone,
  readTrainingView,
  updateMilestone,
  type CustomMilestoneOutcome,
  type MilestoneUpdateOutcome,
} from "../domain/training.ts";
import { readHousehold } from "../domain/household.ts";
import { refused, speakerSeam, text } from "./tool-kit.ts";
import { trainingBoardText } from "./training-text.ts";

/** The training tools, as one extension so a conversation selects them together. */
export function createTrainingTools(): Extension<ToolRegistration> {
  const listMilestones = defineTool({
    name: "list_milestones",
    description:
      "Read the milestone board: every milestone with its id, title, status (mastered, practicing or not " +
      "started), note and who last changed it, grouped by status. The board is a checklist of things the " +
      "household may work on — it carries no schedule or training advice.",
    parameters: Type.Object({}),
    execute: async (_args, api, context: Context) => {
      let rows;
      let timezone;
      try {
        [rows, timezone] = await Promise.all([
          readTrainingView(api, context),
          readHousehold(api, context).then((household) => household.timezone),
        ]);
      } catch (error) {
        // Not ready is a sentence, not a failed task (the feeding tools' rule).
        if (!(error instanceof UnavailableError)) throw error;
        return refused("The milestone board is not available yet; retry after boot.");
      }
      return text(trainingBoardText(rows, timezone));
    },
  });

  const updateMilestoneTool = defineTool({
    name: "update_milestone",
    description:
      "Set one milestone's status and/or note. Call list_milestones first and pass the milestone's id. " +
      'Status is "not_started", "practicing" or "mastered"; marking mastered records who and when, and undoing ' +
      "it to practicing is an ordinary change (nothing is deleted). Omit status to keep it; omit note to keep the " +
      "current one, or send an empty note to clear it.",
    parameters: Type.Object({
      milestoneId: Type.String({ minLength: 1, maxLength: MILESTONE_ID_LIMIT }),
      status: Type.Optional(Type.Union(MILESTONE_STATUSES.map((status) => Type.Literal(status)))),
      note: Type.Optional(Type.String({ maxLength: MILESTONE_NOTE_LIMIT })),
    }),
    replay: "safe",
    execute: async (args, api, context: Context) => {
      const speaker = await speakerSeam(api, context);
      const now = new Date(api.now());
      let outcome: MilestoneUpdateOutcome;
      try {
        outcome = await updateMilestone(api, context, {
          actor: speaker.actor,
          // The task id is the durable identity of this call; the namespace
          // keeps a client-planted key from hijacking a later tool call (§7.3).
          actionId: `tool:${api.taskId}`,
          milestoneId: args.milestoneId,
          ...(args.status !== undefined ? { status: args.status } : {}),
          // An empty note means "clear": the model cannot send JSON null through
          // an optional string, so this is the wire rule its schema documents.
          ...(args.note !== undefined ? { note: args.note.trim() === "" ? null : args.note } : {}),
          source: "agent",
          now,
        });
      } catch (error) {
        // The domain's refusal is a sentence the model must repeat, not retry
        // blindly; anything else is a real failure and surfaces as one.
        if (!(error instanceof DomainConflictError)) throw error;
        await speaker.remember();
        return refused(`Not changed: ${error.message}. Nothing was written.`);
      }
      await speaker.remember();
      if (outcome.kind === "key-conflict") {
        return refused("Not changed: this call reused an idempotency key for a different change. Nothing was written.");
      }
      const [rows, household] = await Promise.all([
        readTrainingView(api, context),
        readHousehold(api, context),
      ]);
      const replay = outcome.kind === "replayed" ? " (already recorded; nothing new was written)" : "";
      // The domain's own sentence: a note-only change must not be reported as a
      // status change (the board line below would contradict it).
      return text(
        `Changed: ${JSON.stringify(outcome.state.byLabel)} ${outcome.summary}${replay}.\n` +
          `${trainingBoardText(rows, household.timezone)}`,
      );
    },
  });

  const addMilestone = defineTool({
    name: "add_milestone",
    description:
      "Add a milestone of the household's own when the starter board is missing one they care about. The title " +
      "must not duplicate a milestone already on the board. Use update_milestone to set its status afterwards.",
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: MILESTONE_TITLE_LIMIT }) }),
    replay: "safe",
    execute: async (args, api, context: Context) => {
      const speaker = await speakerSeam(api, context);
      const now = new Date(api.now());
      let outcome: CustomMilestoneOutcome;
      try {
        outcome = await addCustomMilestone(api, context, {
          actor: speaker.actor,
          actionId: `tool:${api.taskId}`,
          title: args.title,
          source: "agent",
          now,
        });
      } catch (error) {
        if (!(error instanceof DomainConflictError)) throw error;
        await speaker.remember();
        return refused(`Not added: ${error.message}. Nothing was written.`);
      }
      await speaker.remember();
      if (outcome.kind === "key-conflict") {
        return refused("Not added: this call reused an idempotency key for a different change. Nothing was written.");
      }
      const [rows, household] = await Promise.all([
        readTrainingView(api, context),
        readHousehold(api, context),
      ]);
      const replay = outcome.kind === "replayed" ? " (already recorded; nothing new was written)" : "";
      return text(
        `Added the milestone ${JSON.stringify(outcome.milestone.title)}${replay}.\n` +
          `${trainingBoardText(rows, household.timezone)}`,
      );
    },
  });

  return defineExtension({ name: "training", tools: [listMilestones, updateMilestoneTool, addMilestone] });
}
