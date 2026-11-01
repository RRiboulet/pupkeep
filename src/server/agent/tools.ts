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
// household, the puppy profile and the activity feed; the rest of §10.1's
// sections arrive with their phases, and `Not tracked` in the answer says so
// explicitly so the model cannot report "no meals logged" from an empty result.

import { Type } from "@earendil-works/pi-ai";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { CHAT_ENTRY_KIND, HOUSEHOLD_FALLBACK_LABEL } from "../../shared/chat.ts";
import type { ActivityEntry, Household } from "../../shared/domain.ts";
import {
  PROFILE_TEXT_LIMIT,
  TARGET_WEIGHT_MAX_KG,
  parsePuppyPatch,
  type PuppyFields,
} from "../../shared/profile.ts";
import { recentActivity } from "../domain/activity.ts";
import { ActivityDoc, parseActivity } from "../domain/docs.ts";
import { readProfile, updatePuppyProfile, type ProfileActor, type ProfileStore } from "../domain/profile.ts";
import { localTimeAt } from "../domain/time.ts";
import { chatDataOf, labelFor } from "./thread.ts";

/** §10.1 sections this build does not track yet. Remove one per phase. */
const NOT_TRACKED = ["meals", "walks", "growth", "milestones", "appointments", "showers"] as const;

/** How far back a tool scans for the caregiver who started the run. */
const SPEAKER_SCAN_LIMIT = 200;

/**
 * §9.2 rule 2, at the tool side: the latest `app.chat` entry before this record
 * is its author. A tool task is always started by a human message in the shared
 * thread, so the scan finds it; a transcript richer than the scan window falls
 * back to the household instead of inventing a name.
 */
async function speakerIn(tx: Tx, conversationId: ConversationId, household: Household): Promise<ProfileActor> {
  const page = await tx.scanEntries({ conversationId, order: "descending" }, SPEAKER_SCAN_LIMIT);
  for (const entry of page.items) {
    if (entry.kind !== CHAT_ENTRY_KIND) continue;
    const chat = chatDataOf(entry);
    if (!chat) continue;
    return { id: chat.authorId, label: labelFor(household, chat.authorId) };
  }
  return { id: null, label: HOUSEHOLD_FALLBACK_LABEL };
}

function profileText(fields: PuppyFields, age: string | null, today: string): string {
  const parts = [`name "${fields.name}"`];
  if (fields.birthday) parts.push(`born ${fields.birthday}`);
  if (age) parts.push(age);
  if (fields.breed) parts.push(`breed ${fields.breed}`);
  if (fields.sex) parts.push(fields.sex);
  if (fields.targetWeightKg !== null) parts.push(`target ${fields.targetWeightKg} kg`);
  return `${parts.join(", ")} (today is ${today})`;
}

function activityText(entries: readonly ActivityEntry[]): string {
  if (entries.length === 0) return "nothing yet";
  return entries.map((entry) => `${entry.at} ${entry.summary}`).join("\n");
}

function text(value: string): { output: { type: "text"; text: string }[] } {
  return { output: [{ type: "text", text: value }] };
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
      "and recent activity. Sections this build does not track are listed in the answer; say so instead of guessing.",
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      const now = new Date(api.now());
      const profile = await readProfile(api, context, now);
      const activity = await api.snapshot(ActivityDoc, context);
      const parsed = activity === undefined ? undefined : parseActivity(activity);
      const caregivers = profile.household.members.map((member) => member.name).join(", ");
      return text(
        [
          `Now: ${now.toISOString()} — ${profile.today} ${localTimeAt(now, profile.household.timezone)} (${profile.household.timezone})`,
          `Household: "${profile.household.name}", caregivers: ${caregivers || "none yet"}`,
          `Puppy: ${profileText(profile.puppy, profile.age?.label ?? null, profile.today)}`,
          `Revision: ${profile.rev}`,
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
        return { ...text("No valid profile fields to change; send name, birthday, breed, sex or targetWeightKg."), isError: true };
      }
      const store: ProfileStore = api;
      const outcome = await updatePuppyProfile(store, context, {
        actor: (tx, household) => speakerIn(tx, api.conversationId, household),
        // The task id is the durable identity of this call: one call, one action.
        actionId: String(api.taskId),
        rev,
        patch,
        now: new Date(api.now()),
      });

      if (outcome.kind === "key-conflict") {
        return {
          ...text("This call reused an idempotency key for a different change; nothing was written."),
          isError: true,
        };
      }
      if (outcome.kind === "stale") {
        const current = outcome.profile;
        return {
          ...text(
            `Not saved: the profile changed since revision ${rev} (now ${current.rev}). ` +
              `Current profile: ${profileText(current.puppy, current.age?.label ?? null, current.today)}. ` +
              "Call get_puppy and try again with the new revision.",
          ),
          isError: true,
        };
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
