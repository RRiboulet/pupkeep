// The profile extension: the agent's only way to read or change the puppy
// profile (PLAN §10.1, §10.2, §10.3).
//
// The rules the plan sets for tools, and what this file does about them:
//   * app tools only — nothing here touches shell, files, network or SQL;
//   * a thin wrapper over the same domain functions HTTP uses
//     (`src/server/domain/profile.ts`), never a second implementation;
//   * `update_puppy_profile` is `replay: "safe"` because the domain write is
//     idempotent on `api.taskId`, and a rerun after a restart must return the
//     recorded success instead of writing twice;
//   * the actor is the caregiver who spoke (§9.2): resolved from the newest
//     `app.chat` entry inside the same commit as the write, never guessed by
//     the model.
//
// `get_context` is the plan's one context tool. This build tracks the
// household, the puppy profile, today's meals (P2-04's `feedingDayText`), the
// open walk, the latest weight, the milestone summary, the shower status and the
// activity feed; the rest of §10.1's sections arrive with their phases, and
// `Not tracked` in the answer says so explicitly so the model cannot report an
// empty result as "nothing happened".

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ActivityEntry } from "../../shared/domain.ts";
import { feedingDay } from "../../shared/feeding.ts";
import {
  PROFILE_TEXT_LIMIT,
  TARGET_WEIGHT_MAX_KG,
  parsePuppyPatch,
  type PuppyFields,
} from "../../shared/profile.ts";
import { recentActivity } from "../domain/activity.ts";
import { ActivityDoc, parseActivity, type DocStore } from "../domain/docs.ts";
import { readFeeding } from "../domain/feeding.ts";
import { WalksUnavailableError, readWalks } from "../domain/walks.ts";
import { openWalk } from "../../shared/walks.ts";
import { readProfile, updatePuppyProfile } from "../domain/profile.ts";
import { growthSeries } from "../../shared/growth.ts";
import { growthSummary } from "../../shared/growth-trend.ts";
import { localTimeAt } from "../domain/time.ts";
import { feedingDayText } from "./feed-text.ts";
import { latestWeightText } from "./growth-text.ts";
import { milestoneSummaryText } from "./training-text.ts";
import { TrainingUnavailableError, readTrainingView } from "../domain/training.ts";
import { GrowthUnavailableError, readGrowth } from "../domain/growth.ts";
import { ShowersUnavailableError, readShowerView } from "../domain/showers.ts";
import { showerSummaryText } from "./shower-text.ts";
import { openWalkText } from "./walk-text.ts";
import { refused, speakerSeam, text } from "./tool-kit.ts";


/** §10.1 sections this build does not track yet. Remove one per phase. */
const NOT_TRACKED = ["appointments"] as const;

/**
 * The name and breed are caregiver free text, so they are rendered as JSON
 * strings: a stored value that reads like an instruction stays visibly *data*
 * in the model's context (§9.5), instead of blending into the sentence.
 */
function profileText(fields: PuppyFields, age: string | null, today: string): string {
  const parts = [`name ${JSON.stringify(fields.name)}`];
  if (fields.birthday) parts.push(`born ${fields.birthday}`);
  if (age) parts.push(age);
  if (fields.breed) parts.push(`breed ${JSON.stringify(fields.breed)}`);
  if (fields.sex) parts.push(fields.sex);
  if (fields.targetWeightKg !== null) parts.push(`target ${fields.targetWeightKg} kg`);
  return `${parts.join(", ")} (today is ${today})`;
}

function activityText(entries: readonly ActivityEntry[]): string {
  if (entries.length === 0) return "nothing yet";
  // Domain-built summaries still carry caregiver free text; JSON-quote them so
  // one line cannot masquerade as a second instruction.
  return entries.map((entry) => `${entry.at} ${JSON.stringify(entry.summary)}`).join("\n");
}

/** The profile tools, as one extension so a conversation selects them together. */
export function createProfileTools(): Extension<ToolRegistration> {
  const getPuppy = defineTool({
    name: "get_puppy",
    description:
      "Read the puppy's profile: name, birthday, computed age, breed, sex and target weight. " +
      "Returns the revision that update_puppy_profile needs.",
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      const profile = await readProfile(api, context, new Date(api.now()));
      return text(
        `Puppy: ${profileText(profile.puppy, profile.age?.label ?? null, profile.today)}\n` +
          `Revision: ${profile.rev}`,
      );
    },
  });

  const getContext = defineTool({
    name: "get_context",
    description:
      "Read the current household state: now, the household-local date, the caregivers, the puppy profile and age, " +
      "today's meals and who fed each, the open walk, the latest weight, the milestone summary, the shower " +
      "status, and recent activity. Sections this build does not track are listed in the answer; say so instead " +
      "of guessing.",
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      const now = new Date(api.now());
      const profile = await readProfile(api, context, now);
      const feeding = await readFeeding(api, context);
      let walkLine = "Walk: unavailable (retry after boot)";
      try {
        walkLine = openWalkText(openWalk((await readWalks(api, context)).walks), now, profile.household.timezone);
      } catch (error) {
        // One unreadable document must not cost the model every other section.
        if (!(error instanceof WalksUnavailableError)) throw error;
      }
      // §10.1's latest weight, from the committed series; the trend state says
      // whether "latest" is also "current".
      // One unreadable document must not cost the model every other section —
      // and it must not become a false "none logged yet" either.
      let latestWeight = "Latest weight: unavailable (retry after boot)";
      try {
        const growthPoints = growthSeries(await readGrowth(api, context));
        latestWeight = latestWeightText(
          growthPoints,
          growthSummary({
            points: growthPoints,
            today: profile.today,
            targetWeightKg: profile.puppy.targetWeightKg,
          }).state,
        );
      } catch (error) {
        if (!(error instanceof GrowthUnavailableError)) throw error;
      }
      let milestones = "Milestones: unavailable (retry after boot)";
      try {
        milestones = milestoneSummaryText(await readTrainingView(api, context));
      } catch (error) {
        if (!(error instanceof TrainingUnavailableError)) throw error;
      }
      // §10.1's shower status: the last shower and the next due date. One
      // unreadable document must not cost the model every other section.
      let showers = "Showers: unavailable (retry after boot)";
      try {
        showers = showerSummaryText(await readShowerView(api, context, now));
      } catch (error) {
        if (!(error instanceof ShowersUnavailableError)) throw error;
      }
      const activity = await api.snapshot(ActivityDoc, context);
      const parsed = activity === undefined ? undefined : parseActivity(activity);
      // Names are free text too (an invite's display name), so they get the
      // same inert JSON framing as the puppy's fields.
      const caregivers = profile.household.members
        .map((member) => JSON.stringify(member.name))
        .join(", ");
      return text(
        [
          `Now: ${now.toISOString()} — ${profile.today} ${localTimeAt(now, profile.household.timezone)} (${profile.household.timezone})`,
          `Household: ${JSON.stringify(profile.household.name)}, caregivers: ${caregivers || "none yet"}`,
          `Puppy: ${profileText(profile.puppy, profile.age?.label ?? null, profile.today)}`,
          `Revision: ${profile.rev}`,
          // The day's meals are a section the model must be able to quote: a slot
          // with no feed is "not fed", never "no meals logged" (§10.1).
          `Meals today: ${feedingDayText(
            feedingDay(feeding, profile.today),
            profile.today,
            profile.household.timezone,
          )}`,
          // §10.1's open walk, with the server clock so "running for" is not a
          // device-clock guess.
          walkLine,
          // §10.1's latest weight; P3-02's state rides along so "latest" is
          // never reported as "current" when the series is stale.
          latestWeight,
          // §10.1's milestone summary: counts and what is being practised.
          milestones,
          // §10.1's shower status: the last shower and the next due date.
          showers,
          `Recent activity:\n${activityText(parsed ? recentActivity(parsed, 10) : [])}`,
          `Not tracked by this build yet: ${NOT_TRACKED.join(", ")}`,
        ].join("\n"),
      );
    },
  });

  const update = defineTool({
    name: "update_puppy_profile",
    description:
      "Change the puppy profile. Read the current profile with get_puppy first and pass its revision as `rev`; " +
      "a stale revision is refused rather than overwriting another caregiver's change. " +
      "Send only the fields that change; send null to clear breed, sex, birthday or target weight.",
    parameters: Type.Object({
      rev: Type.Integer({ minimum: 0, description: "The revision from get_puppy or a previous update." }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: PROFILE_TEXT_LIMIT })),
      birthday: Type.Optional(
        Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()], {
          description: "Local date YYYY-MM-DD in the household timezone.",
        }),
      ),
      breed: Type.Optional(Type.Union([Type.String({ maxLength: PROFILE_TEXT_LIMIT }), Type.Null()])),
      sex: Type.Optional(Type.Union([Type.Literal("male"), Type.Literal("female"), Type.Null()])),
      targetWeightKg: Type.Optional(
        Type.Union([Type.Number({ exclusiveMinimum: 0, maximum: TARGET_WEIGHT_MAX_KG }), Type.Null()]),
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const { rev, ...fields } = args;
      const patch = parsePuppyPatch(fields);
      if (!patch) {
        return refused("No valid profile fields to change; send name, birthday, breed, sex or targetWeightKg.");
      }
      const store: DocStore = api;
      const speaker = await speakerSeam(api, context);
      const outcome = await updatePuppyProfile(store, context, {
        actor: speaker.actor,
        // The task id is the durable identity of this call: one call, one
        // action. Namespaced so an HTTP client cannot plant a record under a
        // predictable task id and hijack (or wedge) a later tool call.
        actionId: `tool:${api.taskId}`,
        rev,
        patch,
        now: new Date(api.now()),
      });
      // After the domain commit, never inside it (§9.2).
      await speaker.remember();

      if (outcome.kind === "key-conflict") {
        return refused("This call reused an idempotency key for a different change; nothing was written.");
      }
      if (outcome.kind === "stale") {
        const current = outcome.profile;
        return refused(
          `Not saved: the profile changed since revision ${rev} (now ${current.rev}). ` +
            `Current profile: ${profileText(current.puppy, current.age?.label ?? null, current.today)}. ` +
            "Call get_puppy and try again with the new revision.",
        );
      }

      const profile = outcome.profile;
      return text(
        `${outcome.kind === "replayed" ? "Already saved" : "Saved"}: ` +
          `${profileText(profile.puppy, profile.age?.label ?? null, profile.today)}. Revision ${profile.rev}.`,
      );
    },
  });

  return defineExtension({ name: "puppy-profile", tools: [getPuppy, getContext, update] });
}
