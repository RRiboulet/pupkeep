// The shower extension: the agent's only way to read or log a shower (PLAN
// §10.1, §10.2, §10.3, §16 P3-07).
//
// The rules the plan sets, and what this file does about them:
//   * app tools only — nothing here touches shell, files, network or SQL;
//   * thin wrappers over the same domain functions HTTP uses (`logShower`,
//     `readShowerView`), never a second implementation, so the card and the
//     model cannot disagree about a date or a due date;
//   * the names are §10.1/§10.2's — `list_showers` and `log_shower` — and the
//     read takes no date range: the server's clock decides the household-local
//     day (§8.4);
//   * `log_shower` is `replay: "safe"` because the domain write is idempotent on
//     `api.taskId`; a rerun after a restart must return the recorded shower
//     instead of logging a second one;
//   * the actor is the caregiver who spoke (§9.2), resolved inside the write's
//     own `tx` with the tool task's memo as the crash-rerun short cut — never
//     taken from the model's arguments;
//   * free text (shampoo, note) is JSON-quoted in the answer, and the due date is
//     app-built: the model reports state, it does not coach.
//
// The answer reports the committed truth: the shower's stored local date and the
// label read back from the document, then P3-06's derived status.

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { SHAMPOO_LIMIT, SHOWER_NOTES_LIMIT } from "../../shared/showers.ts";
import { DomainConflictError, UnavailableError } from "../domain/errors.ts";
import { readHousehold } from "../domain/household.ts";
import { logShower, readShowerView, readShowers, showerView, type ShowerOutcome } from "../domain/showers.ts";
import { showerReportText, showerStatusText } from "./shower-text.ts";
import { refused, speakerSeam, text } from "./tool-kit.ts";

/** The shower tools, as one extension so a conversation selects them together. */
export function createShowerTools(): Extension<ToolRegistration> {
  const listShowers = defineTool({
    name: "list_showers",
    description:
      "Read the shower history and the next due date: the recent showers (household-local dates, who logged each, " +
      "shampoo and note when recorded), the last shower, the next due date P3-06's interval derives and the " +
      "household's interval in days. The history is newest first and may be long, so the answer is bounded. It " +
      "reports state only — it carries no care advice.",
    parameters: Type.Object({}),
    execute: async (_args, api, context: Context) => {
      const now = new Date(api.now());
      let report;
      try {
        // One household read feeds both the derived status and the rendered
        // clock, so a timezone change cannot make one answer inconsistent.
        const household = await readHousehold(api, context);
        const view = showerView(household, await readShowers(api, context), now);
        report = showerReportText(view, household.timezone);
      } catch (error) {
        // Not ready is a sentence, not a failed task (the feeding tools' rule).
        if (!(error instanceof UnavailableError)) throw error;
        return refused("The shower history is not available yet; retry after boot.");
      }
      return text(report);
    },
  });

  const logShowerTool = defineTool({
    name: "log_shower",
    description:
      "Log a shower for the puppy, with an optional shampoo name and an optional one-line note. The " +
      "household-local date and who logged it come from the server, never from the arguments. Logging the same " +
      "call again is a success, not a second shower.",
    parameters: Type.Object({
      shampoo: Type.Optional(Type.String({ maxLength: SHAMPOO_LIMIT, description: "The shampoo used." })),
      notes: Type.Optional(Type.String({ maxLength: SHOWER_NOTES_LIMIT })),
    }),
    replay: "safe",
    execute: async (args, api, context: Context) => {
      const speaker = await speakerSeam(api, context);
      const now = new Date(api.now());
      let outcome: ShowerOutcome;
      try {
        outcome = await logShower(api, context, {
          actor: speaker.actor,
          // The task id is the durable identity of this call; the namespace
          // keeps a client-planted key from hijacking a later tool call (§7.3).
          actionId: `tool:${api.taskId}`,
          ...(args.shampoo !== undefined ? { shampoo: args.shampoo } : {}),
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
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
        return refused("Not logged: this call reused an idempotency key for a different shower. Nothing was written.");
      }

      // The write already committed; a failed read must not report it as a
      // failed log (a retry would be a new task key and a second shower).
      let status = "";
      try {
        status = `\n${showerStatusText(await readShowerView(api, context, now))}`;
      } catch (error) {
        if (!(error instanceof UnavailableError)) throw error;
      }
      const shower = outcome.shower;
      const replay = outcome.kind === "replayed" ? " (already logged; nothing new was written)" : "";
      return text(
        `Logged a shower on ${shower.localDate} by ${JSON.stringify(shower.byLabel)}${replay}.${status}`,
      );
    },
  });

  return defineExtension({ name: "showers", tools: [listShowers, logShowerTool] });
}
