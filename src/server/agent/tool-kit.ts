// Shared machinery for the app's tools (PLAN §9.2, §10.3).
//
// Two things every tool needs and neither should copy:
//   * the speaker (§9.2): the caregiver who issued this call, found by scanning
//     back from the assistant entry that issued it, inside the same `tx` read
//     as the write — never taken from the model's arguments;
//   * the one result shape: concise text for the model, `isError` for a refusal
//     it must report rather than retry blindly.
//
// The memo discipline is the subtle part. The memo *read* happens before the
// domain commit (it is a Session call, and a Session call made inside a commit
// callback queues on the line the commit holds); the *write* happens after it,
// so a failed memo costs one rescan on a crash-rerun and never fails the change.

import type { Context } from "@earendil-works/chord";
import type {
  ConversationId,
  Cursor,
  EntryId,
  TaskId,
  ToolExecutionApi,
  Tx,
} from "@earendil-works/pi-durable";
import { CHAT_ENTRY_KIND, HOUSEHOLD_FALLBACK_LABEL } from "../../shared/chat.ts";
import type { Household } from "../../shared/domain.ts";
import type { ActorRef, ActorResolver } from "../domain/actor.ts";
import { chatDataOf, labelFor } from "./thread.ts";

/** The tool task's memo, so a rerun after a crash does not rescan (§9.2). */
export const ACTOR_MEMO = "actor";

/**
 * §9.2's pairing rule in one place: an author the household still carries is a
 * real member; a missing *or unknown* id is the household actor, so a removed
 * member's stale transcript entry can never write a dangling id beside the
 * household label. The scan and the memo short cut must not disagree about it.
 */
function actorFrom(household: Household, authorId: unknown): ActorRef {
  const known =
    typeof authorId === "string" && household.members.some((member) => member.id === authorId);
  return known
    ? { id: authorId as string, label: labelFor(household, authorId as string) }
    : { id: null, label: HOUSEHOLD_FALLBACK_LABEL };
}

/** One page of the backwards scan for the speaker. */
const SPEAKER_PAGE_SIZE = 100;

/** The one model-facing result shape; a refusal carries `isError`. */
export function text(value: string): { output: { type: "text"; text: string }[]; isError?: true } {
  return { output: [{ type: "text", text: value }] };
}

/** A refusal the model should read and report, not retry as if it were transient. */
export function refused(value: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { ...text(value), isError: true };
}

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
export async function speakerIn(
  tx: Tx,
  taskId: TaskId,
  conversationId: ConversationId,
  household: Household,
): Promise<ActorRef> {
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
      if (chat) return actorFrom(household, chat.authorId);
    }
    if (page.next === undefined) return { id: null, label: HOUSEHOLD_FALLBACK_LABEL };
    cursor = page.next;
  }
}

/** The attribution a write tool hands its domain call, plus the post-commit memo. */
export interface SpeakerSeam {
  /** Pass as the domain call's `actor`; resolved inside the commit's `tx`. */
  readonly actor: ActorResolver;
  /** After the commit (success or refusal): cache the speaker for a rerun. */
  remember(): Promise<void>;
}

/**
 * Read the memo once, then resolve lazily inside the write's own `tx` so the
 * label comes from the household the transaction reads. A nested or model-less
 * call answers the household fallback, which is the pairing §9.2 requires.
 */
export async function speakerSeam(api: ToolExecutionApi, context: Context): Promise<SpeakerSeam> {
  const cached = await api.memo<ActorRef>(ACTOR_MEMO, context);
  let resolved: ActorRef | undefined;
  const actor: ActorResolver = async (tx, household) => {
    // The memo stores who spoke, not what they were called: a household rename
    // between the call and a crash-rerun must not write the old name into the
    // record. The same pairing rule as the scan applies to the id.
    if (cached) return actorFrom(household, cached.id);
    const found = await speakerIn(tx, api.taskId, api.conversationId, household);
    resolved = found;
    return found;
  };
  return {
    actor,
    remember: async () => {
      if (!resolved) return;
      // Never inside the commit, and never fatal: a lost memo costs one rescan.
      await api.memo(ACTOR_MEMO, resolved, context).catch(() => undefined);
    },
  };
}
