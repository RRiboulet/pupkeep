---
status: done
blocked-by: ["04"]
---

# 05: First-launch e2e leg and the record

**Blocked by:** 04
**Status:** done

## What to build
The e2e suite gains the first-launch leg: the owner opens the owner link and sees only the setup page; completing the five steps lands on Today; a partner invited after completion goes straight into the app and never sees the setup page. A changelog entry is added under `## Unreleased`, and the whole feature passes the full quality gate.

## Scope
The e2e suite, the changelog, and a final verification pass over every ticket's acceptance criteria. No new behavior.

## Acceptance criteria
- [ ] AC9: a partner invited after completion goes straight to Today.
- [ ] The e2e leg proves the first-launch lock end to end (owner link → setup only → five steps → Today).
- [ ] CHANGELOG has an Unreleased entry for the mandatory first-run setup.
- [ ] Full gate green: `npm run typecheck`, `npm test`, browser-render suite.

## Validation
The e2e suite and the full gate. Covers spec behavior R8 and the remaining acceptance sweep.
