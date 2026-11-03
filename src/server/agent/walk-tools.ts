// The walk extension: the agent's only way to start or end a walk (PLAN §10.2,
// §10.3, §9.2, §8.5).
//
// The rules the plan sets, and what this file does about them:
//   * app tools only — nothing here touches shell, files, network or SQL;
//   * thin wrappers over the same service HTTP uses (`startWalk`, `endWalk`),
//     never a second implementation, so the route and the tool cannot disagree
//     about the open walk or a conflict;
//   * both writes are `replay: "safe"`: the task id is the action id, so a rerun
//     after a restart replays the recorded outcome instead of starting or ending
//     a second time;
//   * the actor is the caregiver who spoke (§9.2), resolved inside the write's
//     `tx` with the tool task's memo after the commit — never model arguments;
//   * `start_walk` on an already-open walk answers with that walk instead of
//     starting another (the plan's "returns existing if already open"), and a
//     walk open past eight hours is reported as stale: the caregiver must end or
//     discard it before another starts.
//
// `end_walk` deliberately omits `walkId`: the agent's "end the walk" means the
// open one. The HTTP form passes the id it rendered, so a stale form cannot
// attach itself to a walk started since.

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  WALK_COUNT_LIMIT,
  WALK_DOGS_MET_LIMIT,
  WALK_MOOD_LIMIT,
  WALK_NOTES_LIMIT,
} from "../../shared/walks.ts";
import { DomainConflictError } from "../domain/errors.ts";
import { endWalk, startWalk } from "../domain/walks.ts";
import { readHousehold } from "../domain/household.ts";
import { refused, speakerSeam, text } from "./tool-kit.ts";
import { walkCloseText, walkStartText } from "./walk-text.ts";

const OBSERVATIONS = {
  pee: Type.Optional(Type.Integer({ minimum: 0, maximum: WALK_COUNT_LIMIT })),
  poop: Type.Optional(Type.Integer({ minimum: 0, maximum: WALK_COUNT_LIMIT })),
  dogsMet: Type.Optional(Type.String({ maxLength: WALK_DOGS_MET_LIMIT })),
  mood: Type.Optional(Type.String({ maxLength: WALK_MOOD_LIMIT })),
  notes: Type.Optional(Type.String({ maxLength: WALK_NOTES_LIMIT })),
} as const;

/** The walk tools, as one extension so a conversation selects them together. */
export function createWalkTools(): Extension<ToolRegistration> {
  const start = defineTool({
    name: "start_walk",
    description:
      "Start a walk for the household now. If a walk is already open, nothing is started and the open walk is " +
      "reported instead — end it first. A walk left open over 8 hours is stale and must be ended or discarded.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const now = new Date(api.now());
      const speaker = await speakerSeam(api, context);
      let outcome;
      try {
        outcome = await startWalk(api, context, {
          actor: speaker.actor,
          actionId: `tool:${api.taskId}`,
          now,
        });
      } catch (error) {
        if (!(error instanceof DomainConflictError)) throw error;
        await speaker.remember();
        return refused(`Not started: ${error.message}. Nothing was written.`);
      }
      await speaker.remember();
      if (outcome.kind === "key-conflict") {
        return refused("Not started: this call reused an idempotency key for a different action. Nothing was written.");
      }
      if (outcome.kind === "open" || outcome.kind === "stale") {
        return refused(`Not started: ${outcome.message}. Nothing was written.`);
      }
      const household = await readHousehold(api, context);
      const line = walkStartText(outcome.walk, household.timezone);
      return text(outcome.kind === "replayed" ? `Already started. ${line}` : line);
    },
  });

  const end = defineTool({
    name: "end_walk",
    description:
      "End the walk that is open now and record what was noticed: pee/poop counts, dogs met, mood, notes (all " +
      "optional, one line each). Ending an already-ended walk is refused; a stale walk can be ended too, but " +
      "discarding it is the truthful choice when the real end was hours ago.",
    parameters: Type.Object(OBSERVATIONS),
    replay: "safe",
    execute: async (args, api, context) => {
      const now = new Date(api.now());
      const speaker = await speakerSeam(api, context);
      let outcome;
      try {
        outcome = await endWalk(api, context, {
          actor: speaker.actor,
          actionId: `tool:${api.taskId}`,
          observations: args,
          now,
        });
      } catch (error) {
        if (!(error instanceof DomainConflictError)) throw error;
        await speaker.remember();
        return refused(`Not ended: ${error.message}. Nothing was written.`);
      }
      await speaker.remember();
      if (outcome.kind === "key-conflict") {
        return refused("Not ended: this call reused an idempotency key for a different action. Nothing was written.");
      }
      if (outcome.kind === "ended-already" || outcome.kind === "no-open") {
        return refused(`Not ended: ${outcome.message}. Nothing was written.`);
      }
      const household = await readHousehold(api, context);
      const line = walkCloseText(outcome.walk, household.timezone);
      return text(outcome.kind === "replayed" ? `Already ended. ${line}` : line);
    },
  });

  return defineExtension({ name: "walks", tools: [start, end] });
}
