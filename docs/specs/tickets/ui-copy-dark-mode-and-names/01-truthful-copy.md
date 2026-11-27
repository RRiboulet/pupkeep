---
status: ready
blocked-by: []
---

# 01: The UI speaks the current hosting reality

**Blocked by:** None (can start immediately)
**Status:** ready

## What to build

Read `docs/specs/2026-11-27-ui-copy-dark-mode-and-names.md` first; this ticket implements its behaviors R1-R5. Every sentence a caregiver can read in the web client is true of the household as P6-08 left it: the daily host is the household's server behind one public HTTPS origin; Tailscale and the Cloudflare quick tunnel are gone; the backup feature exists but its Settings status card does not. A caregiver reading Settings (the ntfy paragraph, and both Web Push branches), Today (the placeholder paragraph) and the invite screen sees no reference to the retired paths, no build-phase language and no placeholder claims; copy names the household origin generically ("the household's address") so it stays correct on any deployment.

## Scope

- The five stale copy sites plus the plain-HTTP Web Push branch (the spec's Current behavior #1 lists them with file:line evidence).
- Update any vnode test that pins reworded copy: the phrase "cannot receive Web Push" is pinned by an existing test; either keep the phrase or update the test in the same change.
- The P0-10 no-delivery-claim hedge and the notification title catalog are untouched.

## Acceptance criteria

- [ ] Grep over the web client for "Tailscale", "quick tunnel", "arrive with their phases", "Backup is on its way" and "host phone prints" returns zero hits.
- [ ] The ntfy paragraph names the household origin and keeps the no-delivery-claim hedge.
- [ ] Today's placeholder describes what Today shows now, without build-phase language.
- [ ] Vnode tests pin the new sentences, and the full suite passes.

## Validation

`npm run typecheck` and `npm test`; then on a running dev instance, read Settings, Today and the invite screen at 390 px. Covers spec R1-R5.
