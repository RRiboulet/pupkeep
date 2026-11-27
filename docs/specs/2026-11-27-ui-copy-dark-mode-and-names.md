# UI truth pass: stale copy, glued text, dark mode, caregiver names

## Objective

The household's daily UI still speaks the retired architecture. Since P6-08 the daily host is the Oracle box behind Caddy on one public HTTPS origin, yet Settings tells the partner to use "the daily Tailscale path" and Web Push hints at the deleted "quick tunnel"; Today and Settings carry build-phase placeholders ("arrive with their phases", "Backup is on its way."); two sentences render with glued words ("Boot capturedEurope/Paris", "·Owner") because htm drops whitespace across newlines; the phone app — used on dark evening walks — has no dark mode; and every log line says a human did it "by Owner" because no caregiver can set their real name. This spec captures the fixes so each can be implemented and verified independently.

## Current behavior

Evidence from the code and a live seeded instance (Chromium 390x844, accessibility snapshot + screenshots, 2026-11-27):

1. **Stale copy.** Settings ntfy paragraph recommends "the partner's iPhone on the daily Tailscale path" (web/views/settings.js:600-602); the Web Push hint says "HTTPS (the quick tunnel or localhost)" (web/views/settings.js:542) and its insecure-context branch says "the daily Tailscale path" again (web/views/settings.js:537-538). Today's placeholder says "Weight and the agent bar arrive with their phases" (web/views/today.js:838-841). Settings ends with an orphan hint "Backup is on its way." (web/views/settings.js:694). The invite screen says "The daily address is the one the host phone prints" (web/views/invite.js:111-113). The corrected vocabulary already exists in docs/access-and-notifications.md:9-12.
2. **Glued text.** The first-run wizard renders "Boot capturedEurope/Paris" (web/views/setup.js:405-407) and the Settings lead renders "· Europe/Paris ·Owner" (web/views/settings.js:679-681). Mechanism: htm drops whitespace between a text and an expression across a newline. The repo documents the same defect and fix twice: web/walks.js:70-71 ("Started at22:18" — compose in a pure function and pin it) and web/calendar.js:74-77 ("10:30–11:0030 min").
3. **No dark mode.** web/style.css defines 8 colour tokens in :root (lines 4-15), all light values; there is no prefers-color-scheme block and no color-scheme property anywhere in web/. 56 hardcoded colour literals live outside :root (hairline #e4e0ec, input border #cfc7dd, accent tint #f0e9fd, status hues, notice pairs, shadows). web/index.html:8 has a single theme-color meta; web/manifest.webmanifest:9-10 fixes background_color #ffffff and theme_color #6d37c7.
4. **Caregiver identity.** The first boot seeds the owner with displayName "Owner" (src/server/auth.ts:234-240, :297); every log line reads "Fed by Owner", "Owner is walking". The document layer already anticipates renames — the household profile is the display authority and config.json must not clobber it (docs/PLAN.md:884-889; src/server/config.ts:435-453 nameDrift) — but no rename route or UI exists: the only member-name write is the invite (POST /api/invites). web/profile-form.js is the puppy form only.
5. **Settings length.** Settings renders Invite, Notifications, Meal times, Model and budget, the orphan backup hint, then the complete embedded first-run wizard duplicating the Pup profile form (web/views/settings.js:673-695), all in one scroll.
6. **Withdrawn audit item.** The Agent screen's near-top "duplicate reply" is the designed visually-hidden aria-live region (web/views/agent.js:1177, liveAnnouncement at :860-869, hidden by web/style.css:681-690) required by docs/AGENT-UI-PROMPT.md:59-61. It is not a defect and stays.

## Required behavior

**Truthful copy (P6-08 fallout and placeholders)**

- R1 The Settings ntfy paragraph names the household origin (the server behind the household's HTTPS address), never Tailscale, and keeps the existing P0-10 no-delivery-claim hedge.
- R2 The Settings Web Push copy — both the HTTPS hint and the plain-HTTP branch — names the household HTTPS origin or localhost, never the quick tunnel or the daily Tailscale path. The phrase "cannot receive Web Push" is kept (pinned by test/client.test.js:1944) or the test is updated in the same change.
- R3 Today's placeholder describes what Today shows now (walks, meals, appointments shared live) or is removed; no build-phase language remains.
- R4 The orphan "Backup is on its way." hint is removed. A real backup-status card is future work; the honest state is silence, not a claim.
- R5 The invite screen's "the daily address is the one the host phone prints" is replaced with copy about the household server origin.

**Text renders as written**

- R6 The wizard's timezone sentence renders with a space: "Boot captured Europe/Paris; please check it." The sentence is composed by a pure function pinned by a copy test (prior art: web/walks.js startedText and test/walk-copy.test.js).
- R7 The Settings lead renders "· Europe/Paris · Owner and Sam" with spaces, composed the same way (or using the same-line expression form of web/views/pup.js:483).

**Dark mode**

- R8 Every hardcoded colour literal in web/style.css outside :root is replaced by a semantic token (hairline, input border, accent tint, status ok/warn/bad, notice fg/bg pairs, shadow), so a palette swap touches only tokens.
- R9 web/style.css declares color-scheme: light dark and a @media (prefers-color-scheme: dark) block that overrides the colour tokens with a dark palette meeting WCAG AA contrast for text/background pairs. Layout, the 48rem/30rem breakpoints and prefers-reduced-motion behavior are unchanged.
- R10 web/index.html gains a second theme-color meta with media="(prefers-color-scheme: dark)" for the dark accent; the manifest stays as-is (a manifest cannot be scheme-aware; noted, not a defect).
- R11 No new precached files: the shell still precaches exactly the files pinned by test/pwa.test.ts:773 (count 36). The dark palette lives in style.css and index.html only.

**Caregiver display names**

- R12 A caregiver can change their own display name from Settings: a new authenticated, rev-guarded write on the household member profile (config.json reconciliation already tolerates it and must not clobber it). The existing invite duplicate-name guard keeps working (test/auth.test.ts:416-417).
- R13 The updated name appears immediately everywhere member names render (Settings lead, Pup caregivers line, Today feed/walk lines, Agent attribution) over SSE, without a reload, for both caregivers.

**Settings trim**

- R14 When the household's setup is complete, Settings no longer embeds the full first-run wizard; at most a short summary line remains. The Pup profile and Meal times cards keep all edit capability.

## Non-goals

- No in-app theme toggle; the system scheme decides.
- The Agent screen's aria-live region stays exactly as designed (withdrawn audit item).
- No new Settings sections beyond the caregiver name affordance; no full IA redesign.
- No changes to notification titles (document-frozen catalog, docs/PLAN.md:3086-3088) or to invite/auth semantics beyond the new rename write.
- No delivery or device claims; every P0-10 hedge stays.
- No PLAN.md decision changes: the PLAN is silent on theme and on a rename UI; this spec adds scope rather than reversing a decision.
- No backup-status UI: R4 removes the stale hint; building the real card is future work.

## Constraints

- No build step: plain ES modules, one stylesheet, vendored Preact/htm; node:sqlite only; no native modules.
- Copy conventions in force: state arithmetic and at most one action per screen (docs/PLAN.md:3679); unproven claims stay hedged (web/views/settings.js:15-18); the agent's voice rules are untouched.
- Existing test pins: browser-render h1 headings and nav labels do not change; test/client.test.js vnode assertions updated in the same change as any copy they pin; test/pwa.test.ts:773 precache count must stay 36.
- Any new server write follows the house rules: one process owns the SQLite file, rev-guarded, idempotency-keyed care writes, serialized atomic JSON for config writes; provider keys never in git or logs.
- Dark palette must keep AA contrast for body text, muted text and status hues on their backgrounds.

## Design decisions

- Copy is edited in place; only the two glued sentences move into pure functions, reusing the established compose-then-pin pattern rather than a new abstraction.
- Dark mode is token-first: a mechanical pass replaces literals with semantic tokens, then one media block swaps token values. Automatic scheme, no persisted preference, no JS. The browser-render test becomes the repo's first CSS seam by asserting computed colors under emulated dark scheme.
- The rename is self-service: a member edits their own name only; nobody renames the partner. The household document stays the display authority; config.json keeps reporting nameDrift instead of overwriting.
- Settings hides the completed wizard behind the existing setup-complete flag rather than introducing collapsible sections; if the wizard is ever needed again it still exists for incomplete households and on Today's first-run path.

## Test seams

1. **Vnode render seam** (test/client.test.js, vnodeText at :1468-1478): assert new copy present and stale copy absent for R1-R5, R7 and the R14 trim; assert the rename form and its wire for R12.
2. **Pure copy-function tests** (prior art: test/walk-copy.test.js, test/meal-copy.test.js): pin the composed sentences for R6 and R7 so they cannot re-glue.
3. **HTTP seam** (test/owner-ui.test.js mount; owner-ui asserts the wire, never copy): the rename route's method, body, rev guard and duplicate-name rejection for R12.
4. **Real browser** (test/browser-render.test.ts, pinned Chromium at 320/360/390/430 px): add a dark-scheme case (Playwright colorScheme emulation) asserting computed background/color for body and a surface element differ from the light case and no console errors fire — the only seam that can see CSS (R9); the existing light cases keep guarding nav geometry and headings.
5. **Static shell** (test/pwa.test.ts): precache count stays 36 (R11); no inline styles appear in index.html.

## Acceptance criteria

- [ ] R1 No "Tailscale" reference remains in any web/ string; the ntfy paragraph names the household origin and keeps the no-delivery-claim hedge. (R1)
- [ ] R2 No "quick tunnel" reference remains in any web/ string; both Web Push branches name the household origin or localhost; "cannot receive Web Push" or its updated test pins the new copy. (R2)
- [ ] R3 Today's placeholder carries no build-phase language; a vnode test pins the new sentence. (R3)
- [ ] R4 "Backup is on its way." is gone from web/ and from every test. (R4)
- [ ] R5 The invite copy names the household server origin. (R5)
- [ ] R6 The wizard renders "Boot captured Europe/Paris; please check it." with a space; a copy test pins the composed sentence. (R6)
- [ ] R7 The Settings lead renders with a space before the member name; a copy test pins it. (R7)
- [ ] R8 No hex or rgb literal appears in web/style.css outside the token definitions. (R8)
- [ ] R9 style.css declares color-scheme: light dark and a dark-scheme token override; the browser test asserts computed dark colors and zero console errors. (R9)
- [ ] R10 index.html carries light and dark theme-color metas. (R10)
- [ ] R11 test/pwa.test.ts:773 precache count is still 36 with no new shell files. (R11)
- [ ] R12 A caregiver can rename themselves via Settings; the write is rev-guarded; renaming to a duplicate of the other caregiver's name is rejected; config.json does not clobber the new name on reboot. (R12)
- [ ] R13 After a rename, both caregivers see the new name in Settings, Pup, Today and Agent without a reload (SSE). (R13)
- [ ] R14 With setup complete, Settings shows no embedded wizard and no duplicate puppy form; with setup incomplete the wizard still renders. (R14)

## Verification

- `npm run typecheck`
- `npm test` (includes the vnode, copy, owner-ui and browser-render seams; Chromium is installed in CI and the devcontainer)
- Manual, on a seeded dev instance: reload each of the six tabs at 390 px and confirm R1-R7 and R14 by reading the rendered copy; emulate the system dark scheme (Playwright browser_emulate_media or OS setting) and screenshot Today, Settings and Agent in both schemes; spot-check AA contrast for the dark text pairs.
- Grep the web/ tree for "Tailscale", "quick tunnel", "arrive with their phases", "Backup is on its way", "host phone prints" — zero hits expected.

## Open assumptions

1. Dark mode is automatic system preference only (low risk; a toggle can be added later behind a setting). The user can confirm.
2. Rename is self-service only: nobody renames the other caregiver (low risk). The user can confirm.
3. The "duplicate reply" audit item is withdrawn on evidence (the aria-live region is by design) — no code change.
4. Deleting the backup hint rather than building a status card is the honest state until that card is planned (P6-09 deploys the box's backup timer; a Settings status card remains future work).
5. The wizard trim loses no capability: profile and meal times stay editable on Pup and Settings.
6. All copy stays English, sentence-case, in the app's existing voice; the household origin is written generically ("the household's address") rather than hardcoding pupkeep.duckdns.org, so the copy stays correct on any deployment.
