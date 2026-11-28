---
status: done
blocked-by: []
---

# 01: Five-step setup derivation on the server

**Blocked by:** None (can start immediately)
**Status:** done

## What to build
The server's setup contract becomes five derived steps. A household document migration adds a name-confirmed stamp (the same pattern the timezone stamp used). The existing household update route accepts a name field: one care commit, revision- and idempotency-guarded, with an activity line; confirming the unchanged default name counts and stamps. The setup derivation reports the steps `name`, `timezone`, `puppy`, `meals`, `key` — the key step is satisfied when at least one provider key exists for the household, and the derivation sees only a presence boolean, never key values. A household complete under the old three-step rule reports incomplete under the new rule; with a key already saved, a name confirm completes it.

## Scope
The household document and its migration, the household update route and its validation, the setup/profile derivation and its wiring into the care view, and every test fixture that reads setup completeness (the shared test app bootstrap, the setup/owner-ui/client suites). Leaves all UI to later tickets: the wizard's new cards (02), Settings (03), the route (04).

## Acceptance criteria
- [ ] AC3: the API's setup step list contains `name`, `timezone`, `puppy`, `meals`, `key`, and reports complete only when all five are satisfied.
- [ ] AC4: confirming the default name without editing it stamps the household document, writes an activity line, and bumps the household revision once (a single commit).
- [ ] AC10: a household complete under the old rule reports incomplete; after a name confirm with a key already present, it reports complete.
- [ ] Both caregiver roles may confirm the name; refusals (stale rev, replayed idempotency keys, bad payloads) write nothing, and existing write semantics (AC11) stay green.
- [ ] Key values never appear in any API response or log; only provider-presence booleans leave the server.

## Validation
The setup suite plus the full gate: `npm run typecheck` and `npm test`. Covers spec behaviors R3, R4 (server), R9.
