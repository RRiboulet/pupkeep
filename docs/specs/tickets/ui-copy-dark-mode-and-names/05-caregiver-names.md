---
status: ready
blocked-by: []
---

# 05: Caregivers can use their own names

**Blocked by:** None (can start immediately)
**Status:** ready

## What to build

Read `docs/specs/2026-11-27-ui-copy-dark-mode-and-names.md` first; this ticket implements its behaviors R12-R13. A caregiver sets or changes their own display name from Settings — the person themselves, not the other caregiver — and both caregivers immediately see the new name everywhere it renders (Settings lead, Pup caregivers line, Today feed and walk lines, Agent attribution) without a reload, over the existing live stream. The write is authenticated, rev-guarded and idempotent like the app's other writes; the household document stays the display authority so the boot-time config seed never clobbers a chosen name (the document layer already anticipates this and reports drift instead of overwriting); renaming to the other caregiver's name is rejected; the invite duplicate-name guard keeps working.

## Scope

- One new server write for the signed-in member's own name, with its HTTP seam tests (wire-level: method, body, rev guard, duplicate rejection).
- The Settings affordance (form, save, feedback) with vnode tests.
- The boot-time owner row is still seeded "Owner" until renamed — the default seed and its tests are untouched.
- The other caregiver's name is not editable here.

## Acceptance criteria

- [ ] A caregiver renames themselves and sees the new name in Settings immediately.
- [ ] The second caregiver's client shows the new name without a reload (live stream).
- [ ] The write rejects a stale revision and a duplicate of the other caregiver's name.
- [ ] After a server restart, the chosen name survives; boot reconciliation does not reset it.
- [ ] The existing invite duplicate-name behavior still passes.

## Validation

`npm test`; then on a running dev instance with two sessions, rename in one and watch the other update live; restart the server and confirm the name survives. Covers spec R12-R13.
