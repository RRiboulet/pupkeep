---
status: ready
blocked-by: []
---

# 06: Settings drops the completed first-run wizard

**Blocked by:** None (can start immediately)
**Status:** ready

## What to build

Read `docs/specs/2026-11-27-ui-copy-dark-mode-and-names.md` first; this ticket implements its behavior R14. Once the household's setup is complete, the Settings screen no longer embeds the full first-run wizard — at most a short summary line remains — so the puppy profile form is not duplicated and Settings gets shorter. Households that are not set up still get the wizard, exactly as today, both on Settings and on Today's first-run path; no edit capability is lost (the profile and meal-times cards remain the editing surface).

## Scope

- The embedded wizard's render condition behind the existing setup-complete flag.
- Vnode tests for both states: complete shows no wizard and no duplicate puppy form; incomplete still shows it.
- The wizard itself is not modified, and Today's first-run behavior is untouched.

## Acceptance criteria

- [ ] With setup complete, Settings shows no embedded wizard and no second copy of the puppy profile form.
- [ ] With setup incomplete, the wizard still renders on Settings and Today.
- [ ] The profile and meal-times cards still save.
- [ ] The full suite passes.

## Validation

`npm test`; on a running dev instance, inspect Settings before and after completing setup. Covers spec R14.
