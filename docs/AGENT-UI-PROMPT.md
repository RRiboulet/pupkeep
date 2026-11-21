# Prompt: implement the Pupkeep Agent screen (shared thread UI)

You are working in the Pupkeep repository (`/workspace`). The backend for the
shared household agent thread is complete and tested; only the browser UI is a
placeholder (`web/views/agent.js`). Your job is to replace that placeholder with a
working Agent screen, including live updates over the existing SSE stream,
tool cards, approval cards, and model/budget status. Multiplayer (two caregivers
seeing the same thread and updates) must work. Automated tests for this can be
delayed; focus on a correct, robust implementation and a manual smoke test.

## 0. Read first

- `AGENTS.md` (current phase, safety rules, commands)
- `docs/PLAN.md` §9 (agent), §9.3 (approvals), §9.4 (live), §11 (models/budget),
  §14 (auth/origins), §15 (testing)
- `web/app.js`, `web/store.js`, `web/live.js`, `web/client.js`,
  `web/views/today.js`, `web/views/calendar.js`, `web/views/notifications.js`,
  `web/views/settings.js` (patterns to mirror)
- `src/server/http.ts` route handlers and `src/shared/chat.ts`,
  `src/shared/calendar.ts` (approval/appointment shapes)
- `test/dual-path.test.ts`, `test/approvals.test.ts` (behavioural contract)

## 1. Scope

In scope:
- `web/views/agent.js` full implementation.
- Small additions to `web/store.js` (thread snapshot state, busy flag, selected
  model/budget if not already), `web/live.js` (subscribe to thread SSE events
  and refresh on reconnect), and `web/style.css` as needed.
- Reuse `requestJson` from `web/client.js` for all HTTP.

Out of scope (do not touch):
- Backend routes/handlers (already complete).
- Service worker, push, notifications centre (already done).
- New dependencies or a build step.

## 2. Backend contract you must use

Base path `/api`. Session cookie is set by `/login?token=`. All mutations need
`Origin`, `Content-Type: application/json`, and `X-Pupkeep-Request: 1`
(`requestJson` adds the last two for non-GET).

Thread:
- `GET /api/agent/thread` → `{ conversationId, seq, status: { busy, queued },
  entries: [...] }`. Full snapshot.
- `POST /api/agent/messages` body `{ text, clientMessageId }` → 202
  `{ accepted, submissionId, status }` or 409 `{ error }` (busy / bad body).
  `clientMessageId` dedupes retries (namespaced per author server-side).
- `GET /api/agent/events` (SSE) → first event `snapshot` with the thread
  snapshot; then deltas: `entry` (new entry), `status` (busy/queued change),
  `reconnect` (reattach). Same per-member connection cap as care stream.
- `GET /api/agent/events/poll` → full snapshot (long-poll fallback).

Approvals:
- `GET /api/approvals` → `{ approvals: [...] }` (newest first). Each has
  `id`, `kind`, `status` (pending/confirmed/cancelled/expired derived),
  `createdAt`, `expiresAt`, `requestedBy`, `summary`, `payload`, `rev`, etc.
- `POST /api/approvals/confirm` body `{ id, rev }` + `Idempotency-Key` →
  200 `{ approval, replayed }` or 409 (stale/expired/declined/already_confirmed/
  target_changed) carrying the current approval.
- `POST /api/approvals/cancel` body `{ id, rev }` + `Idempotency-Key`.

Models/budget:
- `GET /api/models` → `{ householdRev, role, current, providers, allowlist,
  probe, candidates }`.
- `GET /api/budget` → `{ budget: { month, spentUsd, capUsd, ratio, state,
  paidAllowed } }`.
- `PATCH /api/models/current` body `{ model }` (owner; needs allowlisted model).
- `PUT /api/models/keys`, `POST /api/models/probe` (owner).

Session:
- `GET /api/session` → `{ memberId, role, label, authorId }`.

## 3. Entry shapes (render these)

From `src/shared/chat.ts` and tool cards. An entry has `kind`:
- `chat`: `{ entryId, at, authorId, authorName, text, clientMessageId }`
- `tool`: `{ entryId, at, authorId, authorName, toolName, args, result, ... }`
- `system`/`approval`: approval entries use kind `approval` with
  `APPROVAL_ENTRY_KIND` (rendered by `readThreadSnapshot`); treat as a card
  referencing an approval id, with status from `/api/approvals`.

Render each entry with author label + timestamp. The current user's messages on
one side, others on the other (chat bubbles). Tool cards collapsed by default,
expandable to show args/result. Approval cards show summary, status badge,
expiry, and Confirm/Cancel buttons when `status === "pending"` and not expired.

## 4. Required behaviour

1. On mount: fetch `/api/agent/thread` and render the snapshot (entries in
   order). Show busy indicator from `status.busy`.
2. Composer: textarea + send button. On submit:
   - generate `clientMessageId` via `newIdempotencyKey()` (from client.js).
   - disable while busy or while request in flight; optimistic append is
     optional but must be reconciled with the server snapshot/SSE.
   - on 409 busy: show "assistant is busy" and keep text; do not duplicate.
   - on 202: clear composer; the entry arrives via SSE.
3. Live updates:
   - Use the existing EventSource on `/api/agent/events`. On `snapshot`, replace
     the whole thread (by `seq`, never backwards). On `entry`, append if not
     already present (dedupe by `entryId`). On `status`, update busy/queued.
   - Reconnect: close/reopen or rely on browser auto-reconnect; on `open`,
     re-fetch `/api/agent/thread` to catch up (the server's snapshot is
     authoritative). On `reconnect` event, close and reopen after ~1s.
   - If EventSource unavailable, fall back to polling `/api/agent/events/poll`
     every few seconds.
4. Approval cards:
   - Poll/refresh `/api/approvals` on mount and after any mutation; also
     refresh when a new `entry` of kind `approval` arrives.
   - Confirm/Cancel buttons disabled unless `status === "pending"` and not
     expired. Use `Idempotency-Key` per click.
   - Handle 409s: show the server's message (stale/expired/declined/etc.) and
     refresh the list.
5. Model/budget panel (compact, at top or in a collapsible):
   - Show current model id (or "No model selected — configure in Settings") and
     paid/free badge, plus spend vs cap and state from `/api/budget`.
   - If a message fails because no model/allowlist, link to Settings.
   - "Retry with fallback model" error state: if the thread reports a model
     error, show a retry button that re-reads models and re-submits? At minimum
     surface the error text.
6. Multiplayer:
   - Both caregivers share one thread; SSE delivers the other's messages and
     tool cards. Do not key anything off `session.displayName` alone; use
     `authorId`/`authorName` from entries.
   - Busy state is global: if the other caregiver's submission is running, show
     busy and disable composer.
   - Connection cap: if evicted, show a polite "reconnecting" state and retry.
7. Accessibility/UX:
   - Semantic list (`<ol>`/`<ul>`), `aria-live="polite"` for new messages,
     keyboard submit (Enter to send, Shift+Enter newline), focus management.
   - Timestamps in a readable form (local time).
   - Mobile-friendly (bottom nav already exists).
8. Security:
   - Never inject entry text as HTML; use Preact text children (htm escapes).
   - Do not log tokens; only use session cookie.

## 5. Patterns to follow

- Views are functions returning `html\`...\``; use `useState`/`useEffect` from
  Preact hooks (`import { useState, useEffect, useRef } from "../vendor/preact.mjs"`).
  Check existing views for hook usage (e.g. `notifications.js`).
- State updates via `setState`/`subscribe` in `store.js` if shared; otherwise
  local component state.
- SSE: mirror `live.js` (EventSource, reconnect, `open` refresh, `reconnect`
  handling). The thread stream is separate from the care stream; you may open a
  second EventSource on `/api/agent/events` only while the Agent view is mounted,
  or keep one global. Prefer mounting-scoped to respect the per-member cap, but
  ensure reconnect works.
- Mutations: `requestJson(path, { method, body, idempotencyKey })`.
- Idempotency keys for composer retries: reuse the same `clientMessageId` on
  retry of the same intended message; new message = new key.

## 6. Files

Primary: `web/views/agent.js`.
Likely: `web/live.js` (if adding thread events to the global stream — but the
server has a separate `/api/agent/events`; keep separate), `web/store.js`
(optional thread slice), `web/style.css`.

## 7. Acceptance criteria (manual smoke is acceptable)

- Opening Agent shows the current thread snapshot.
- Sending a message adds it to the list and, when a model is configured, the
  assistant reply appears via SSE without a reload.
- Two tabs/devices: a message sent in one appears in the other.
- Busy state disables the composer and shows who/what is running.
- An approval proposal (created via HTTP/agent) renders as a card; Confirm and
  Cancel work and update status; expired proposals show expired.
- No console errors; no inline scripts/styles; CSP intact.
- `npm run typecheck` and `npm test` still pass (backend unchanged).

## 8. Testing note

Automated UI tests can be delayed. At minimum, verify manually against a running
instance with a configured provider key. Do not block on device-gated checks.

## 9. Deliverable

Replace `web/views/agent.js` (and supporting client files) so the Agent route
is functional. Keep the placeholder removal explicit. Document any new manual
steps in `docs/PHONE-RUNBOOK.md` if needed.
