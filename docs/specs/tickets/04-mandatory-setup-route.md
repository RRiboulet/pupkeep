---
status: done
blocked-by: ["02", "03"]
---

# 04: The mandatory #/setup route

**Blocked by:** 02, 03
**Status:** done

## What to build
Setup becomes a real `#/setup` route and the whole app locks behind it: while setup is incomplete, every hash route redirects to `#/setup` and the bottom navigation is not rendered; once setup is complete, `#/setup` redirects to Today and the page is unreachable. The Today-tab gate and the Settings embedded wizard are removed (Settings' Household section from ticket 03 is now the only post-completion home for name and timezone). The plan's P1-14 "wizard is not a route" decision is reversed and recorded in the plan in this same change.

## Scope
The app shell (route table, hash fallback, nav rendering), removal of the two old mount points, the plan document, and the browser-render screen expectations. Client tests pin the redirection in both directions.

## Acceptance criteria
- [ ] AC1: with setup incomplete, loading any route renders the setup page and no bottom navigation.
- [ ] AC2: with setup complete, `#/setup` redirects to Today.
- [ ] AC8: Settings has a Household section and no embedded wizard; Pup, meal-times editor and model/budget card unchanged.
- [ ] The browser-render suite's first screen for an unconfigured fixture is the setup page at 320/360/390/430 px.
- [ ] The plan records the P1-14 reversal in this change.

## Validation
The client suite, the browser-render suite (pinned Chromium), plus `npm run typecheck` and `npm test`. Covers spec behaviors R1, R2, R7 (completion).
