// Shapes of the shared household thread (PLAN §9.1–§9.4). They live in
// `src/shared/` so the server and the browser client describe the same wire
// format; the server builds them, the client renders them.
//
// One decision this file fixes:
//   * an author of `null`/"" means the *household* fallback — the object never
//     carries `undefined`, so `JSON.parse` cannot lose it and the UI never has
//     to guess (PLAN §9.2).

/** The custom Pi Durable entry kind both caregivers submit through. */
export const CHAT_ENTRY_KIND = "app.chat";

/** Display name when no household profile matches the author. */
export const HOUSEHOLD_FALLBACK_LABEL = "Household";

/**
 * `data` of an `app.chat` entry: who spoke, in display text, what, and the
 * client id that dedupes double-sends server-side (`requestId`). `authorId`
 * is the config.json member id, or `null` for the household fallback.
 */
export type ChatEntryData = {
  authorId: string | null;
  authorName: string;
  text: string;
  clientMessageId: string;
};

/** Every transcript entry the PWA renders; `kind` discriminates. */
export type TranscriptEntry =
  | {
      kind: "chat";
      entryId: number;
      at?: string;
      authorId: string | null;
      authorName: string;
      text: string;
      clientMessageId: string;
    }
  | {
      kind: "assistant";
      entryId: number;
      at?: string;
      text: string;
      /** Present when the reply was produced for one accepted speaker (v1). */
      authorId: string | null;
      authorName: string;
    }
  | {
      kind: "tool";
      entryId: number;
      at?: string;
      toolCallId: string;
      toolName: string;
      status: "ok" | "error";
      text: string;
      /** Household attribution fence: never `undefined` (PLAN §9.2). */
      byUserId: string | null;
      byLabel: string;
    };

/** Where the thread is: `busy` while a run owns it; `queued` is pending work. */
export type ThreadStatus = {
  busy: boolean;
  queued: number;
};

export type ThreadSnapshot = {
  /** Pi Durable conversation id (`app.household.conversationId`). */
  conversationId: number;
  /**
   * Not a cursor into storage: the server's event counter. `/api/agent/thread`
   * reports it, the long-poll compares it, and SSE may add fields of its own.
   */
  seq: number;
  status: ThreadStatus;
  /** Oldest first, newest THREAD_TRANSCRIPT_LIMIT entries kept. */
  entries: TranscriptEntry[];
  /** The conversation's configured model, if any. */
  model?: string;
};

/**
 * The transcript tail a snapshot returns. The full thread stays in SQLite;
 * this bounds every snapshot and long-poll body on the phone.
 */
export const THREAD_TRANSCRIPT_LIMIT = 200;

/** Long-poll wait ceiling. Beyond this, clients re-issue with their seq. */
export const THREAD_POLL_MAX_MS = 30_000;

/** Concurrent event-style connections (SSE + long-poll) allowed per member. */
export const THREAD_CONNECTIONS_PER_USER = 4;

/** The `mimo` model the Phase 0 probes confirmed (PLAN §11.2). */
export const DEFAULT_MODEL_ID = "opencode-go/mimo-v2.6-flash";
