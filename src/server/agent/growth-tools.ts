// The growth extension: the agent's only way to read or log a weight (PLAN
// §10.1, §10.2, §10.3).
//
// The rules the plan sets, and what this file does about them:
//   * app tools only — nothing here touches shell, files, network or SQL;
//   * thin wrappers over the same domain functions HTTP uses
//     (`logMeasurement`, `readGrowthView`), never a second implementation, so
//     the route, the tool and the panel cannot disagree about a weight or a
//     trend;
//   * `log_measurement` is `replay: "safe"` because the domain write is
//     idempotent on `api.taskId`; a rerun after a restart must return the
//     recorded measurement instead of logging it twice;
//   * the actor is the caregiver who spoke (§9.2), resolved inside the write's
//     own `tx` with the tool task's memo as the crash-rerun short cut — never
//     taken from the model's arguments;
//   * free text the caregiver wrote (a note) is JSON-quoted in the answer, and
//     the trend copy is P3-02's, never the model's.
//
// The answer reports the committed truth: the weight, the household-local date
// and the label read back from the document, then the trend sentence a
// caregiver would read in the app.

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { formatWeightKg, HEIGHT_MAX_CM, MEASUREMENT_NOTE_LIMIT, WEIGHT_MAX_KG } from "../../shared/growth.ts";
import { DomainConflictError, UnavailableError } from "../domain/errors.ts";
import { logMeasurement, readGrowthView, type MeasurementOutcome } from "../domain/growth.ts";
import { growthReportText } from "./growth-text.ts";
import { refused, speakerSeam, text } from "./tool-kit.ts";

/** The growth tools, as one extension so a conversation selects them together. */
export function createGrowthTools(): Extension<ToolRegistration> {
  const getGrowth = defineTool({
    name: "get_growth",
    description:
      "Read the puppy's growth: the logged weight measurements (household-local dates, oldest first), the trend " +
      "sentence, the distance to the target weight and the non-veterinary disclaimer. Read this before quoting a " +
      "trend or a target; the copy is app-built, so repeat it rather than inventing advice.",
    parameters: Type.Object({}),
    execute: async (_args, api, context: Context) => {
      const now = new Date(api.now());
      let view;
      try {
        view = await readGrowthView(api, context, now);
      } catch (error) {
        // Not ready is a sentence, not a failed task (the feeding tools' rule).
        if (!(error instanceof UnavailableError)) throw error;
        return refused("Growth is not available yet; retry after boot.");
      }
      return text(growthReportText(view));
    },
  });

  const logWeight = defineTool({
    name: "log_measurement",
    description:
      "Log a weight measurement for the puppy. Weight is in kilograms (grams are fine, e.g. 4.237); height in " +
      "centimetres and a one-line note are optional. The household-local date and who logged it come from the " +
      "server, never from the arguments. Logging the same call again is a success, not a second measurement.",
    parameters: Type.Object({
      weightKg: Type.Number({
        minimum: 0.001,
        maximum: WEIGHT_MAX_KG,
        description: "Weight in kilograms, e.g. 4.25.",
      }),
      heightCm: Type.Optional(
        Type.Number({ minimum: 0.1, maximum: HEIGHT_MAX_CM, description: "Height at the withers in centimetres." }),
      ),
      note: Type.Optional(Type.String({ maxLength: MEASUREMENT_NOTE_LIMIT })),
    }),
    replay: "safe",
    execute: async (args, api, context: Context) => {
      const speaker = await speakerSeam(api, context);
      const now = new Date(api.now());
      let outcome: MeasurementOutcome;
      try {
        outcome = await logMeasurement(api, context, {
          actor: speaker.actor,
          // The task id is the durable identity of this call; the namespace
          // keeps a client-planted key from hijacking a later tool call (§7.3).
          actionId: `tool:${api.taskId}`,
          weightKg: args.weightKg,
          ...(args.heightCm !== undefined ? { heightCm: args.heightCm } : {}),
          ...(args.note !== undefined ? { note: args.note } : {}),
          source: "agent",
          now,
        });
      } catch (error) {
        // The domain's refusal is a sentence the model must repeat, not retry
        // blindly; anything else is a real failure and surfaces as one.
        if (!(error instanceof DomainConflictError)) throw error;
        await speaker.remember();
        return refused(`Not logged: ${error.message}. Nothing was written.`);
      }
      await speaker.remember();
      if (outcome.kind === "key-conflict") {
        return refused("Not logged: this call reused an idempotency key for a different measurement. Nothing was written.");
      }

      const view = await readGrowthView(api, context, now);
      const measurement = outcome.measurement;
      const replay = outcome.kind === "replayed" ? " (already logged; nothing new was written)" : "";
      return text(
        `Logged ${formatWeightKg(measurement.weightKg)} on ${measurement.localDate}, by ` +
          `${JSON.stringify(measurement.byLabel)}${replay}.\n${growthReportText(view)}`,
      );
    },
  });

  return defineExtension({ name: "growth", tools: [getGrowth, logWeight] });
}
