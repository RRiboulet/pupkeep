---
status: ready
blocked-by: []
---

# 03: Every colour in the stylesheet is a token

**Blocked by:** None (can start immediately)
**Status:** ready

## What to build

Read `docs/specs/2026-11-27-ui-copy-dark-mode-and-names.md` first; this ticket implements its behavior R8. The stylesheet keeps exactly its current light appearance, but every hardcoded colour literal outside the root token block — around 56 hex/rgb values covering hairline borders, input borders, the accent tint, status hues, notice foreground/background pairs and shadows — becomes a semantic token, so a later palette swap touches only token values. This is the prefactor that makes dark mode easy; no dark values are introduced here.

## Scope

- The single stylesheet's rules; values are unchanged, only names are introduced.
- The token set is named by role (hairline, input border, tint, status ok/warn/bad, notice pairs, shadow), not by value.
- No markup, module or test-behavior changes are expected.

## Acceptance criteria

- [ ] No hex or rgb literal appears in the stylesheet outside the root token definitions.
- [ ] The rendered app is visually identical: screenshots at the phone viewports match pre-change captures.
- [ ] The full suite passes.

## Validation

`npm test`, plus before/after screenshots of Today and Settings at 390 px compared side by side. Covers spec R8.
