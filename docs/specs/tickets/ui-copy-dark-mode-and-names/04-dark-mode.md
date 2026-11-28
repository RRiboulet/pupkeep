---
status: ready
blocked-by: ["03"]
---

# 04: Dark mode follows the system scheme

**Blocked by:** 03 (Every colour in the stylesheet is a token)
**Status:** ready

## What to build

Read `docs/specs/2026-11-27-ui-copy-dark-mode-and-names.md` first; this ticket implements its behaviors R9-R11. When the phone is in its system dark scheme, the whole app renders a dark palette that meets WCAG AA contrast for its text pairs; when it is light, nothing changes. The stylesheet declares color-scheme and one dark-scheme override of the token values; the document gains a second theme-color meta bound to the dark scheme; nothing is added to the shell's precache. The repo gains its first CSS test seam: the pinned-Chromium browser suite learns to emulate the dark scheme and assert computed colors in both schemes, alongside its existing light-only checks.

## Scope

- The stylesheet's token overrides and the document's theme-color metas; the manifest is deliberately left as-is (a manifest cannot be scheme-aware).
- The browser-render suite's new dark-scheme case; the existing light cases keep guarding nav geometry and headings.
- No in-app toggle, no persisted preference, no new files in the shell precache.

## Acceptance criteria

- [ ] With the dark scheme emulated, the app's surfaces, ink and accents render the dark palette, with zero console errors, at all four checked phone widths.
- [ ] The browser suite asserts computed background and color values differ between the schemes on a surface element.
- [ ] The shell still precaches exactly the pinned set (the precache-count test passes unchanged).
- [ ] Dark text pairs pass an AA contrast spot check.

## Validation

`npm test` (the browser suite now covers both schemes). Manual: screenshots of Today, Settings and Agent in both schemes at 390 px. Covers spec R9-R11.
