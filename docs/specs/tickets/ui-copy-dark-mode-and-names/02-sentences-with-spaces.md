---
status: ready
blocked-by: []
---

# 02: Sentences render with their spaces

**Blocked by:** None (can start immediately)
**Status:** ready

## What to build

Read `docs/specs/2026-11-27-ui-copy-dark-mode-and-names.md` first; this ticket implements its behaviors R6-R7. The first-run wizard's timezone sentence and the Settings lead line render the words the template intends, with the spaces between them: "Boot captured Europe/Paris; please check it." and "· Europe/Paris · Owner and Sam". The gluing is an htm whitespace behavior this repo has met and fixed twice before (a card once read "Started at22:18"): the fix is to compose each sentence in a pure function and pin it with a copy test, following that established pattern rather than inventing a new mechanism.

## Scope

- The two composed sentences (the spec's Current behavior #2 locates them and names the prior-art pattern).
- New pure copy helpers and copy tests, in the style of the existing walk and meal copy tests.
- No other templates are touched; no new abstraction.

## Acceptance criteria

- [ ] The wizard renders "Boot captured Europe/Paris; please check it." with the space.
- [ ] The Settings lead renders the timezone and member names with spaces around the separators.
- [ ] A copy test pins each composed sentence so a regression that re-glues words fails the suite.

## Validation

`npm test` (the new copy tests plus the existing suite). Covers spec R6-R7.
