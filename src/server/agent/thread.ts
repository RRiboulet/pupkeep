// The one shared household thread: submit, snapshot, configure (P1-09).
//
// PLAN §9.1 fixes the shape: one human-facing Pi Durable conversation per
// household (`app.household.conversationId`); every user message is a custom
// `app.chat` entry whose data carries the author and whose model content is
// `"Name: text"`. v1 is one-at-a-time: a busy conversation rejects the input
// with `ConversationBusy` (there is no mid-run placement and no queue), and a
// failed run leaves nothing stranded (`settings.afterFailedRun: "continue"`).
//
// Attribution follows §9.2: labels resolve through `app.household` profiles,
// never `session.displayName`; a missing or unknown author normalizes to
// `byUserId: null` / `Household`, never `undefined`.

import type { Context } from "@earendil-works/chord";
import {
  AssistantEntry,
  ConversationBusy,
  ToolResultEntry,
  UserEntry,
  type ConversationId,
  type EntryRecord,
  type Harness,
  type Submission,
} from "@earendil-works/pi-durable";
import type { Household } from "../../shared/domain.ts";
import {
  CHAT_ENTRY_KIND,
  HOUSEHOLD_FALLBACK_LABEL,
  THREAD_TRANSCRIPT_LIMIT,
  type ChatEntryData,
  type ThreadSnapshot,
  type TranscriptEntry,
} from "../../shared/chat.ts";
import { HouseholdDoc, parseHousehold } from "../domain/docs.ts";

export type ThreadRef = {
  readonly harness: Harness;
  readonly context: Context;
};

/** The thread routes cannot run without the bootstrapped household document. */
export class ThreadUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = "ThreadUnavailableError";
  }
}

export type SubmitRequest = ChatEntryData;

export type SubmitOutcome =
  | { kind: "placed"; submission: Submission; status: string }
  | { kind: "busy" };

/**
 * Ensure the entry's data is a `ChatEntryData` shape. Anything else is a shape
 * this build does not understand — the entry is skipped rather than shown as a
 * hand-typed spoof of someone's message.
 */
export function chatDataOf(entry: EntryRecord): ChatEntryData | undefined {
  if (entry.kind !== CHAT_ENTRY_KIND) return undefined;
  const data = entry.data as ChatEntryData | undefined;
  if (typeof data !== "object" || data === null) return undefined;
  const { authorId, authorName, text, clientMessageId } = data;
  if (typeof authorName !== "string" || authorName.trim() === "") return undefined;
  if (typeof text !== "string") return undefined;
  if (typeof clientMessageId !== "string" || clientMessageId === "") return undefined;
  if (authorId !== null && typeof authorId !== "string") return undefined;
  return { authorId, authorName, text, clientMessageId };
}

/** Household profile of a member id — the only label source (§9.2). */
export function labelFor(household: Household, authorId: string | null | undefined): string {
  if (!authorId) return HOUSEHOLD_FALLBACK_LABEL;
  return household.members.find((member) => member.id === authorId)?.name ?? HOUSEHOLD_FALLBACK_LABEL;
}

/** Does the household document exist and parse? Boot keeps it true. */
export async function readHousehold(thread: ThreadRef): Promise<Household> {
  const snapshot = await thread.harness.snapshot(HouseholdDoc, thread.context);
  const household = snapshot === undefined ? undefined : parseHousehold(snapshot);
  if (!household) throw new ThreadUnavailableError("the household document is not available; retry after boot");
  return household;
}

async function sharedConversation(thread: ThreadRef, household: Household, what: string) {
  const id = household.conversationId as ConversationId;
  const conversation = await thread.harness.conversation(id, thread.context);
  if (!conversation) {
    throw new ThreadUnavailableError(`the shared conversation is missing ("${what}")`);
  }
  return conversation;
}

/**
 * Submit one caregiver message. `whenBusy: "reject"` keeps one-at-a-time real:
 * a busy thread throws `ConversationBusy`, nothing is written, and the client
 * keeps its draft. `requestId: authorId:clientMessageId` dedupes a double-send
 * per author, so two caregivers may reuse the same client id; a known id from
 * the same author returns its existing submission without writing.
 */
export async function submitChatMessage(
  thread: ThreadRef,
  request: SubmitRequest,
): Promise<SubmitOutcome> {
  const household = await readHousehold(thread);
  const conversation = await sharedConversation(thread, household, request.clientMessageId);
  // The model content names the speaker; the custom `data` carries the record.
  const content = `${request.authorName}: ${request.text}`;
  try {
    const submission = await conversation.submit(
      {
        type: "input",
        content,
        whenBusy: "reject",
        // Namespaced by author: the client id is only unique per browser, so a
        // bare id would silently swallow the other caregiver's message.
        requestId: `${request.authorId}:${request.clientMessageId}`,
        entry: {
          kind: CHAT_ENTRY_KIND,
          data: {
            authorId: request.authorId,
            authorName: request.authorName,
            text: request.text,
            clientMessageId: request.clientMessageId,
          },
        },
      },
      thread.context,
    );
    return { kind: "placed", submission, status: (await submission.status(thread.context)).status };
  } catch (error) {
    if (error instanceof ConversationBusy) return { kind: "busy" };
    throw error;
  }
}

function entryAt(entry: EntryRecord): string | undefined {
  const first = entry.model?.[0];
  const timestamp = first && "timestamp" in first ? first.timestamp : undefined;
  return typeof timestamp === "number" ? new Date(timestamp).toISOString() : undefined;
}

function textOf(content: unknown): string {
  // `UserMessage.content` may be a plain string; assistant/tool content is blocks.
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null
        ? (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"
        : false,
    )
    .map((block) => block.text)
    .join("");
}

interface Actor {
  byUserId: string | null;
  byLabel: string;
}

function actorFrom(chat: Actor | undefined): Actor {
  // The fence: an actor is a *value* or the household fallback, never `undefined`
  // (§9.2). An unknown/absent author normalizes to null/"Household".
  if (!chat) return { byUserId: null, byLabel: HOUSEHOLD_FALLBACK_LABEL };
  return { byUserId: chat.byUserId, byLabel: chat.byLabel };
}

/**
 * Read one snapshot of the thread. Everything visible comes from this one
 * conversation's entries; another conversation's transcript can never appear
 * here, which is also the "no cross-conversation leak" guarantee.
 */
export async function readThreadSnapshot(thread: ThreadRef, seq: number): Promise<ThreadSnapshot> {
  const household = await readHousehold(thread);
  const conversation = await sharedConversation(thread, household, "snapshot");

  // Newest first, then reversed, so the response body is the newest
  // THREAD_TRANSCRIPT_LIMIT entries in reading order without a growing window.
  const newest: EntryRecord[] = [];
  let cursor: Record<string, never> | undefined;
  while (newest.length < THREAD_TRANSCRIPT_LIMIT) {
    const page = await conversation.entries(
      { order: "descending" },
      THREAD_TRANSCRIPT_LIMIT - newest.length,
      cursor,
      thread.context,
    );
    newest.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next as Record<string, never>;
  }
  const entries = newest.reverse();

  const inspection = await thread.harness.inspect(thread.context);
  const busy =
    inspection.tasks.some(
      (task) =>
        task.record.conversationId === household.conversationId &&
        (task.state.kind === "running" || task.state.kind === "completing"),
    ) ||
    inspection.submissions.some(
      (submission) =>
        submission.conversationId === household.conversationId &&
        submission.type === "input" &&
        (submission.status === "queued" || submission.status === "placed"),
    );
  const queued = inspection.submissions.filter(
    (submission) =>
      submission.conversationId === household.conversationId &&
      submission.status === "queued",
  ).length;

  let model: string | undefined;
  try {
    const resolved = (await conversation.agent(thread.context)).model;
    model = resolved ? `${resolved.provider}/${resolved.modelId}` : undefined;
  } catch {
    model = undefined;
  }

  let actor: Actor | undefined;
  const transcript: TranscriptEntry[] = [];
  for (const entry of entries) {
    // Attribution: the latest placed `app.chat` before a record is its author (§9.2
    // rule 2, v1 with rejecting placements). Resolved through household profiles.
    const chat = chatDataOf(entry);
    if (chat) {
      actor = { byUserId: chat.authorId, byLabel: labelFor(household, chat.authorId) };
      transcript.push({
        kind: "chat",
        entryId: entry.id,
        at: entryAt(entry),
        authorId: chat.authorId,
        authorName: labelFor(household, chat.authorId),
        text: chat.text,
        clientMessageId: chat.clientMessageId,
      });
      continue;
    }
    if (UserEntry.is(entry)) {
      // A placed input that is not `app.chat` (e.g. only the PWA wrote through pi.user)
      // still shows as a household-attributed line.
      transcript.push({
        kind: "chat",
        entryId: entry.id,
        at: entryAt(entry),
        authorId: null,
        authorName: HOUSEHOLD_FALLBACK_LABEL,
        text: textOf(entry.model?.[0]?.content),
        clientMessageId: "",
      });
      continue;
    }
    if (AssistantEntry.is(entry)) {
      const text = textOf(entry.model?.[0]?.content);
      if (text === "") continue; // a tool-only round renders through its cards
      transcript.push({
        kind: "assistant",
        entryId: entry.id,
        at: entryAt(entry),
        text,
        authorId: actor?.byUserId ?? null,
        authorName: actor?.byLabel ?? HOUSEHOLD_FALLBACK_LABEL,
      });
      continue;
    }
    if (ToolResultEntry.is(entry)) {
      // The result's model message carries the call identity; `data.diagnostics`
      // is for tools with diagnostics and may be absent.
      const result = entry.model?.[0];
      if (typeof result !== "object" || result === null) continue;
      const record = result as {
        toolCallId?: unknown;
        toolName?: unknown;
        isError?: unknown;
        content?: unknown[];
      };
      transcript.push({
        kind: "tool",
        entryId: entry.id,
        at: entryAt(entry),
        toolCallId: String(record.toolCallId ?? ""),
        toolName: String(record.toolName ?? ""),
        status: record.isError === true ? "error" : "ok",
        text: textOf(record.content),
        byUserId: actor?.byUserId ?? null,
        byLabel: actor?.byLabel ?? HOUSEHOLD_FALLBACK_LABEL,
      });
    }
    // Other kinds (compaction summaries, resets, system markers) are internal.
  }

  return {
    conversationId: household.conversationId,
    seq,
    status: { busy, queued },
    entries: transcript,
    ...(model !== undefined ? { model } : {}),
  };
}

export type ThreadAgentConfig = {
  /** The §9.5 instructions, before this conversation is selectable in the UI. */
  readonly instructions: string;
  /** Model ref to attach to the shared conversation, when one is allowed. */
  readonly model?: { provider: string; modelId: string };
};

/**
 * Configure the shared conversation's agent in place, reusing an existing
 * identical configuration so an ordinary boot writes no commit. The hidden
 * system conversation is never touched here — P1-08 keeps it model-less and
 * `clearSystemModel` repairs it.
 */
export async function configureSharedThread(
  thread: ThreadRef,
  config: ThreadAgentConfig,
): Promise<{ changed: boolean; model: string | undefined }> {
  const household = await readHousehold(thread);
  const conversation = await sharedConversation(thread, household, "configure");
  const agent = await conversation.agent(thread.context);

  const wantedModel = config.model ? { provider: config.model.provider, modelId: config.model.modelId } : undefined;
  const hasModel =
    agent.model !== undefined &&
    agent.model.provider === wantedModel?.provider &&
    agent.model.modelId === wantedModel?.modelId;

  const change: { instructions?: string; model?: ThreadAgentConfig["model"] } = {};
  if (agent.instructions !== config.instructions) change.instructions = config.instructions;
  if (wantedModel && !hasModel) change.model = wantedModel;

  if (change.instructions === undefined && change.model === undefined) {
    return { changed: false, model: wantedModel ? `${wantedModel.provider}/${wantedModel.modelId}` : undefined };
  }
  await conversation.configure(change, thread.context);
  return { changed: true, model: wantedModel ? `${wantedModel.provider}/${wantedModel.modelId}` : undefined };
}
