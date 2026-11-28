---
status: ready
blocked-by: ["01"]
---

# 03: Settings Household section

**Blocked by:** 01
**Status:** ready

## What to build
Settings gains a Household section: the household name and timezone, editable at any time by either caregiver, with the same revision-conflict and idempotency behavior as today's wizard cards. This gives the post-completion home for these two settings before the embedded wizard is removed. The embedded wizard itself stays untouched in this ticket (a later ticket removes it).

## Scope
The Settings view and its tests. Reuses the wizard's per-section card components (extracting them if needed) rather than new form code. Does not touch the Setup component's mounting, navigation, or any route.

## Acceptance criteria
- [ ] A caregiver can change the household name and timezone from Settings after setup is complete, and both writes are single care commits with stale-conflict surfacing.
- [ ] The section renders for both roles; nothing owner-only is introduced.
- [ ] The embedded wizard is still present and untouched after this ticket.

## Validation
The owner-ui and client suites plus `npm run typecheck` and `npm test`. Covers the Settings half of spec behavior R7.
