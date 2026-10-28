# P0-04 — Shared-thread attribution

**Task:** P0-04. **Date:** 2026-10-28. **Status:** complete for the P0-04 spike;
integration belongs to P1-09/P1-12.

**Verdict:** v1’s rule works **only if the server enforces one-at-a-time chat
input with `whenBusy: "reject"`**. The actor resolves from the latest placed
`app.chat` entry before the tool’s assistant entry; a second input while the
thread is busy is rejected and adds no entry; sequential authors resolve
correctly; a missing author falls back to the household; and a tool rerun after
SIGKILL reads the durable actor memo.

## What was tested

Scratch harness in `/tmp/p0-04` (throwaway; not committed):

- Pi Durable `1.4.0`, `MemoryStorage` for the basic/sequential/fallback cases
  and SQLite for the SIGKILL/reopen case.
- Faux provider returns `actor_probe` as a tool call.
- `actor_probe` reads its own task input (`api.getTask(api.taskId)`), scans
  `tx.scanEntries({ conversationId, maxEntryId: assistant, order: "descending" })`
  for the latest `app.chat`, and stores an **actor object** with
  `api.memo("actor", …)`:
  `{ authorId: string | null, authorName: string }`.
- The tool is `replay: "safe"`. In the crash test the first run blocks after the
  memo commit; the parent SIGKILLs the child, reopens the same SQLite file and
  waits for the submission.

## Results

| Check | Result |
|---|---|
| First author | `{ authorId: "alex", authorName: "Alex" }` |
| Second message while the tool is running, `whenBusy: "reject"` | `ConversationBusy: Conversation 1 is busy` |
| Transcript scan after the busy rejection | **exactly 1** `app.chat` entry |
| Two sequential accepted authors | `Alex`, then `Sam` |
| Fresh conversation with no `app.chat` input | `{ authorId: null, authorName: "Household" }` |
| Post-kill rerun | `rerunActor: { authorId: "alex", authorName: "Alex" }` |
| Submission after rerun | `done` |
| Tool result entry | `rerun actor={"authorId":"alex","authorName":"Alex"}` |

The SIGKILL test shows the same `pi.tool` task reran and read the memo: the
actor did not come from a fresh resolution in that script. The transcript was
unchanged between runs, so it does **not** prove precedence over a conflicting
transcript. That negative control is not meaningful for this tool: the scan is
bounded by the tool’s own assistant entry, and a later `app.chat` entry (for
example a passive write) falls after that bound. A true conflict would require
an input placed **before** the assistant entry, which is the queueing/steering
case v1 disables. If queueing is ever enabled, resolve from the run’s input
submissions, not from recency.

## Rules for P1-09

1. **Enforce the busy rule server-side.** Caregiver chat must always be an input
   with `whenBusy: "reject"`, never a passive `write` or a `steer`; the HTTP
   layer maps `ConversationBusy` to a friendly 409 and keeps the draft. An
   omitted `whenBusy` defaults to follow-up, so the server must set it
   explicitly.
2. **Resolve inside a `tx` read.** Read the tool task input, scan backwards from
   the assistant entry to the latest `app.chat`, then memo an **actor object**
   (use `prior !== undefined`, not `if (prior)`, so the household/null case is
   not treated as absent).
3. **Memo scope is the tool task, not the assistant entry.** The assistant entry
   is provenance. Memos disappear when the task becomes terminal, so persist the
   resolved actor on the domain record (`byUserId`/`byLabel`) as the durable
   audit.
4. **Never accept an actor from model arguments.** Derive it from the session’s
   member identity and the placed input.
5. **Fail closed for nested tools.** A `kind: "nested"` tool input has no
   assistant entry; either walk the parent task chain or return the household
   fallback. Do not throw or silently attribute to the model.
6. **Fallback is visible.** `byUserId: null`, `byLabel: "Household"` in the UI
   and approval cards; high-impact actions still require a human tap.
7. **Do not enable queueing until** the run-input mapping and a changed-input
   test exist. “Latest visible entry” is not safe once inputs can be placed
   mid-run.

## Not covered here — P1-09/P1-12

- HTTP-layer busy → 409, draft preservation, retry after idle, and
  `requestId` double-send dedupe.
- Simultaneous first submits (source serializes admission; needs a test).
- Passive writes/steer and omitted `whenBusy` trying to shift attribution.
- Nested tools and a parent-chain actor lookup.
- Persisting the actor on a real domain record and replaying the domain write
  with the same `api.taskId`.
- SQLite with the production `synchronous=FULL` (P0-01).
- A changed-transcript rerun; see the bound above.

## Caveats

- The basic case used `MemoryStorage`; the crash case used SQLite.
- The crash test used SIGKILL, not power loss.
- The tool returned the actor but did not create a care record; the mapping to
  `byUserId`/`byLabel` is P1-11/P2.
