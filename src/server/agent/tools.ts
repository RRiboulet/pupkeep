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
import type { ConversationId, Cursor, EntryId, TaskId, Tx } from "@earendil-works/pi-durable";
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
import { ActivityDoc, parseActivity, type DocStore } from "../domain/docs.ts";
import { readProfile, updatePuppyProfile, type ProfileActor } from "../domain/profile.ts";
import { localTimeAt } from "../domain/time.ts";
import { chatDataOf, labelFor } from "./thread.ts";

/** §10.1 sections this build does not track yet. Remove one per phase. */
const NOT_TRACKED = ["meals", "walks", "growth", "milestones", "appointments", "showers"] as const;

/** One page of the backwards scan for the speaker. */
const SPEAKER_PAGE_SIZE = 100;
/** The tool task's memo, so a rerun after a crash does not rescan (§9.2). */
const ACTOR_MEMO = "actor";

/**
 * §9.2 rule 1, at the tool side: read this task's input, take the `assistant`
 * entry that issued the call, and scan backwards from it to the latest
 * `app.chat` entry inside the `tx` read. The scan is anchored at the call, not
 * at the transcript tail, so entries appended after the call (its own result,
 * later turns) can never change who is attributed.
 *
 * A nested call has no assistant entry of its own; §9.2 says fail closed, so it
 * answers the household fallback instead of guessing from the parent.
 */
async function speakerIn(
  tx: Tx,
  taskId: TaskId,
  conversationId: ConversationId,
  household: Household,
): Promise<ProfileActor> {
  const task = await tx.task(taskId);
  const input = task?.input as { readonly kind?: unknown; readonly assistant?: unknown } | undefined;
  if (input?.kind !== "model" || typeof input.assistant !== "number") {
    return { id: null, label: HOUSEHOLD_FALLBACK_LABEL };
  }

  let cursor: Cursor | undefined;
  for (;;) {
    const page = await tx.scanEntries(
      { conversationId, maxEntryId: input.assistant as EntryId, order: "descending" },
      SPEAKER_PAGE_SIZE,
      cursor,
    );
    for (const entry of page.items) {
      if (entry.kind !== CHAT_ENTRY_KIND) continue;
      const chat = chatDataOf(entry);
      if (chat) return { id: chat.authorId, label: labelFor(household, chat.authorId) };
    }
    if (page.next === undefined) return { id: null, label: HOUSEHOLD_FALLBACK_LABEL };
    cursor = page.next;
  }
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
      const store: DocStore = api;
      // Read the memo before the commit: the memo API is a Session write, and a
      // Session call made inside a commit callback queues on the line it holds.
      const cached = await api.memo<ProfileActor>(ACTOR_MEMO, context);
      let resolved: ProfileActor | undefined;
      const outcome = await updatePuppyProfile(store, context, {
        actor: (tx, household) => {
          if (cached) return Promise.resolve(cached);
          return speakerIn(tx, api.taskId, api.conversationId, household).then((actor) => {
            resolved = actor;
            return actor;
          });
        },
        // The task id is the durable identity of this call: one call, one
        // action. Namespaced so an HTTP client cannot plant a record under a
        // predictable task id and hijack (or wedge) a later tool call.
        actionId: `tool:${api.taskId}`,
        rev,
        patch,
        now: new Date(api.now()),
      });
      if (resolved) {
        // After the domain commit, never inside it. A failed memo costs one
        // rescan on a rerun and nothing else, so it must not fail the change.
        await api.memo(ACTOR_MEMO, resolved, context).catch(() => undefined);
      }

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
