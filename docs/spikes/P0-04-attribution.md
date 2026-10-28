# P0-04 — Shared-thread attribution

**Task:** P0-04. **Date:** 2026-10-28. **Status:** complete.

**Verdict:** the v1 rule is safe **only because v1 rejects a second input while
the shared thread is busy**. Resolving the actor from the latest placed
`app.chat` entry before the tool's assistant entry works, the busy input never
enters the transcript, and a post-crash rerun finds the durable actor memo.

## What was tested

Scratch harness in `/tmp/p0-04` (throwaway; not committed):

- Pi Durable `1.4.0`, `MemoryStorage` for the basic case and SQLite for the
  kill/restart case.
- Faux provider returns `actor_probe` as a tool call.
- `actor_probe` reads its own task input (`api.getTask(api.taskId)`), scans
  `tx.scanEntries({ conversationId, maxEntryId: assistant, order: "descending" })`
  for the latest `app.chat`, and stores the actor with `api.memo("actor", …)`.
- The tool is `replay: "safe"`; the first run blocks after the memo commit, the
  parent SIGKILLs the child, then reopens the same SQLite file and waits for the
  submission.

## Results

| Check | Result |
|---|---|
| First author | `{ authorId: "alex", authorName: "Alex" }` |
| Second message while the tool is running, `whenBusy: "reject"` | `ConversationBusy: Conversation 1 is busy` |
| Transcript after the busy rejection | only the first `app.chat` entry |
| Post-kill rerun | `rerunActor: { authorId: "alex", authorName: "Alex" }` |
| Submission after rerun | `done` |
| Tool result entry | `rerun actor={"authorId":"alex","authorName":"Alex"}` |

The crash test proves the important part: the tool intent and memo were
committed before the kill; on reopen the tool reran, read the memo and did not
re-resolve a different actor from a changed transcript.

## Rules for P1-09

1. **v1 does not queue or steer.** A second input while the thread is busy
   returns a friendly 409/`ConversationBusy`; the client keeps the draft.
2. A tool resolves its actor **inside a `tx` read**: read its own task input,
   scan backwards from the assistant entry to the latest `app.chat`, then memo
   the actor. Read the memo first on a rerun.
3. Never accept an actor from model arguments.
4. If the resolution is ambiguous, use `byUserId: null` / `byLabel:
   "Household"`, show that in the UI, and require approval for high-impact
   actions.
5. Do not enable queueing until a run-input mapping is implemented and tested;
   “latest visible entry” is not safe once inputs can be placed mid-run.

## Caveats

- The scratch used `openNodeSqliteStorage` without the app's `synchronous=FULL`
  override; P0-01 covers the production pragma.
- The basic case used `MemoryStorage`; the crash case used SQLite. Both passed.
- The household fallback path was not forced in this run; it is a one-line
  branch and must be covered by P1-09/P1-12.
