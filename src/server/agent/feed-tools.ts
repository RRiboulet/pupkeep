// The feeding extension: the agent's only way to read or log a meal (PLAN
// §10.1, §10.2, §10.3).
//
// The rules the plan sets, and what this file does about them:
//   * app tools only — nothing here touches shell, files, network or SQL;
//   * thin wrappers over the same domain functions HTTP uses
//     (`logFeed`, `feedingDay`), never a second implementation, so the route and
//     the tool cannot disagree about a day or a conflict;
//   * `log_feeding` and `log_extra_feeding` are `replay: "safe"` because the
//     domain write is idempotent on `api.taskId`; a rerun after a restart must
//     return the recorded meal instead of logging it twice;
//   * the actor is the caregiver who spoke (§9.2), resolved inside the write's
//     own `tx` with the tool task's memo as the crash-rerun short cut — never
//     taken from the model's arguments;
//   * free text the caregiver wrote (a slot label, an amount, a note) is
//     JSON-quoted in the answer, so a crafted value stays visibly data.
//
// A log tool reports the committed truth: the slot, the household-local date and
// time, and who fed it, read back from the document rather than built from the
// arguments.

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  FEED_AMOUNT_LIMIT,
  FEED_NOTE_LIMIT,
  SLOT_ID_LIMIT,
  feedingDay,
} from "../../shared/feeding.ts";
import { isLocalDate } from "../../shared/profile.ts";
import type { DocStore } from "../domain/docs.ts";
import { DomainConflictError, UnavailableError } from "../domain/errors.ts";
import { FeedConflictError, logFeed, readFeeding, type FeedOutcome } from "../domain/feeding.ts";
import { readHousehold } from "../domain/household.ts";
import { localDateAt, localTimeAt } from "../domain/time.ts";
import { feedWriteText, feedingDayText } from "./feed-text.ts";
import { refused, speakerSeam, text } from "./tool-kit.ts";

/** The household (for the zone) and the committed schedule, read once each. */
async function readDay(store: DocStore, context: Context) {
  const [household, feeding] = await Promise.all([readHousehold(store, context), readFeeding(store, context)]);
  return { household, feeding };
}

/** The feeding tools, as one extension so a conversation selects them together. */
export function createFeedTools(): Extension<ToolRegistration> {
  const getFeedingDay = defineTool({
    name: "get_feeding_day",
    description:
      "Read one day of meals: the active meal slots with the feed that claimed each (who and when), plus extra " +
      "feedings. Defaults to the household-local today; pass `date` as YYYY-MM-DD for another day. A slot with no " +
      "feed is reported as not fed — never as missing data.",
    parameters: Type.Object({
      date: Type.Optional(
        Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Local date YYYY-MM-DD; today by default." }),
      ),
    }),
    execute: async (args, api, context) => {
      if (args.date !== undefined && !isLocalDate(args.date)) {
        return refused(`${JSON.stringify(args.date)} is not a real date; use YYYY-MM-DD.`);
      }
      const now = new Date(api.now());
      let day: Awaited<ReturnType<typeof readDay>>;
      try {
        day = await readDay(api, context);
      } catch (error) {
        // Not ready is a sentence, not a failed task: the model can tell the
        // caregiver to retry after boot instead of reporting a broken tool.
        if (!(error instanceof UnavailableError)) throw error;
        return refused(error.message);
      }
      const today = localDateAt(now, day.household.timezone);
      const localDate = args.date ?? today;
      return text(
        `${localDate}: ${feedingDayText(feedingDay(day.feeding, localDate), today, day.household.timezone)}`,
      );
    },
  });

  async function logMeal(
    slotId: string | null,
    amount: string | undefined,
    note: string | undefined,
    api: ToolExecutionApi,
    context: Context,
  ) {
    const now = new Date(api.now());
    const speaker = await speakerSeam(api, context);
    let outcome: FeedOutcome;
    try {
      outcome = await logFeed(api, context, {
        actor: speaker.actor,
        // The task id is the durable identity of this call, and the namespace
        // keeps a client-planted key from hijacking a later tool call (§7.3).
        actionId: `tool:${api.taskId}`,
        // Opaque ids are exact; trimming is the model echoing whitespace, not a
        // different slot (the HTTP route normalises the same way).
        slotId: slotId === null ? null : slotId.trim(),
        amount,
        note,
        source: "agent",
        now,
      });
    } catch (error) {
      // The domain's typed refusals: a fed slot reports who fed it and when, and
      // every other 409 (an unknown or inactive slot, a value the parser would
      // refuse) is a sentence the model must repeat, not retry blindly. Anything
      // else is a real failure and surfaces as one.
      if (!(error instanceof DomainConflictError)) throw error;
      await speaker.remember();
      if (error instanceof FeedConflictError) {
        // Rebuilt here, not taken from the domain sentence: `byLabel` is a
        // caregiver's uncapped free text, and this is the one string the model
        // is told to repeat — it stays JSON-quoted data (§9.5).
        const household = await readHousehold(api, context);
        const existing = error.existing;
        const when = localTimeAt(new Date(existing.at), household.timezone);
        return refused(
          `Not logged: ${JSON.stringify(existing.byLabel)} already logged this meal at ${when} on ` +
            `${existing.localDate}. Nothing was written. Call get_feeding_day to re-read the day.`,
        );
      }
      return refused(`Not logged: ${error.message}. Nothing was written.`);
    }
    await speaker.remember();
    if (outcome.kind === "key-conflict") {
      return refused("Not logged: this call reused an idempotency key for a different meal. Nothing was written.");
    }

    const { household, feeding } = await readDay(api, context);
    const day = feedingDay(feeding, outcome.event.localDate);
    return text(feedWriteText(outcome.event, outcome.kind === "replayed", day, household.timezone));
  }

  const logFeeding = defineTool({
    name: "log_feeding",
    description:
      "Claim one scheduled meal slot for today. Call get_feeding_day first and pass the slot's id. " +
      "A slot the other caregiver already fed is refused with who fed it and when; logging the same call again " +
      "is a success, not a second meal. Optional amount and note are the caregiver's words.",
    parameters: Type.Object({
      slotId: Type.String({ minLength: 1, maxLength: SLOT_ID_LIMIT, description: "The slot id from get_feeding_day." }),
      amount: Type.Optional(Type.String({ maxLength: FEED_AMOUNT_LIMIT })),
      note: Type.Optional(Type.String({ maxLength: FEED_NOTE_LIMIT })),
    }),
    replay: "safe",
    execute: async (args, api, context) => logMeal(args.slotId, args.amount, args.note, api, context),
  });

  const logExtraFeeding = defineTool({
    name: "log_extra_feeding",
    description:
      "Log an ad-hoc feeding that belongs to no scheduled slot (a snack, a training treat). It never marks a " +
      "slot fed. Use log_feeding when the caregiver is claiming a meal time.",
    parameters: Type.Object({
      amount: Type.Optional(Type.String({ maxLength: FEED_AMOUNT_LIMIT })),
      note: Type.Optional(Type.String({ maxLength: FEED_NOTE_LIMIT })),
    }),
    replay: "safe",
    execute: async (args, api, context) => logMeal(null, args.amount, args.note, api, context),
  });

  return defineExtension({ name: "feeding", tools: [getFeedingDay, logFeeding, logExtraFeeding] });
}
