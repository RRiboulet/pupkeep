# Mandatory first-run setup

## Objective
When the household's server is launched for the first time, the owner signs in and must configure the household before anyone uses the app. Today the "setup" is a small wizard swapped into the Today tab's content (and duplicated at the bottom of Settings); every other tab stays reachable, the household name is never asked, and provider keys are a separate Settings chore — so a household can drift into daily use with a default name and a dead agent. We want a dedicated first-launch page that is mandatory and not skippable: the entire app is locked until the household is configured.

## Current behavior
- The shell renders Today by default; when the profile reports `setup.complete === false`, only the Today tab's content is swapped for the wizard. The bottom navigation and every other tab (Calendar, Pup, Agent, Alerts, Settings) remain fully usable.
- Setup completion is derived, never stored: timezone confirmed + puppy named + at least one meal slot. The wizard is deliberately "not a route" (the P1-14 decision in the plan); unknown hash routes fall back to Today.
- The same wizard is embedded at the bottom of Settings for both caregivers, forever.
- Provider keys are owner-only writes to a household-wide `secrets.json` (mode 0600, excluded from off-device backups, values never echoed back to clients). A key is necessary but not sufficient for the agent: a model must also be attached to the shared conversation, and boot attaches the default model only if its provider has a key. There is no keyless provider, so a fresh household with no key has a dead agent on day one (the plan's bring-up list says keys are re-entered on day one for exactly this reason).
- The household name defaults to "Our household"; no route or UI can change it.
- Signed-out browsers see a "Please sign in again" sentence; `/login` requires a token. (Unchanged, out of scope.)

## Required behavior
R1. While setup is incomplete, the whole app is the first-launch setup page: the hash route is forced to `#/setup`, the bottom navigation is not rendered, and no other view is reachable by URL or browser history.
R2. The page exists only for the first launch: once setup is complete, `#/setup` redirects to the Today view, and the page cannot be reached again while setup stays complete.
R3. Setup completeness is five derived steps: household name confirmed, timezone confirmed, puppy named, at least one meal slot, and at least one provider key saved.
R4. Household-name step: an editable name plus an explicit confirm action that stamps the household document even when the name is unchanged (the same confirm-if-unchanged semantics as the timezone step). The confirm is a single care commit through the existing household update route, revision- and idempotency-guarded like every other care write.
R5. Provider-key step: done when at least one provider key exists for the household. The card shows the current probe/model status (so the owner can see the agent come alive), but a failed or skipped probe never blocks completion. Only the owner can write keys; a non-owner sees a read-only card saying only the owner can add them.
R6. The setup page shows the five steps as numbered cards on one page with an "N of 5 ready" lead; drafts behave like today's wizard (held in the page's state; a hard reload loses them — the known carried limitation). No skip control exists.
R7. Settings stops embedding the setup wizard. It gains a Household section (name and timezone) editable at any time by either caregiver. Puppy editing stays on the Pup page; the meal-times editor and the model/budget card stay in Settings unchanged.
R8. Completeness is household-wide: a second caregiver invited after completion lands directly in the normal app.
R9. Existing households whose setup was complete under the old three-step rule become incomplete under the five-step rule; their caregivers see the setup page once, complete the new steps (an already-saved provider key counts), and return to the app. No stored "grandfather" flag exists.

## Non-goals
- A signed-out landing page (the owner-link and invite flows are unchanged).
- A budget-cap step in setup (the cap keeps its default in Settings).
- A skip, defer, or "later" affordance — setup is mandatory.
- Persisting setup drafts across a page reload.
- Automatic model failover or keyless providers.

## Constraints
- The client stays build-less: vendored Preact/htm ES modules served by the same Node server.
- Every setup write remains one care commit with the existing guards: session, origin check, request header, `Idempotency-Key`, and revision-conflict 409 semantics.
- Provider keys stay in `secrets.json` (mode 0600, excluded from off-device backups); key values are never sent to any client, including the setup page — only provider-presence booleans.
- Key writes remain owner-only, enforced by the server; UI hiding is courtesy.
- Both caregivers may run setup, exactly as today, except key writes.
- The completeness derivation must not require network access: first launch on the offline phone fallback must be able to complete.
- The plan's P1-14 "wizard is not a route" decision is reversed by this change and must be recorded in the plan in the same change (the repository rule: a change that alters a plan decision updates the plan with it).

## Design decisions
- A real `#/setup` hash route replaces the Today-tab gate (this reverses the P1-14 decision). The shell redirects to it while incomplete and away from it once complete. Rejected: a shell-level gate with no URL — the first-launch page should be a real page with an address.
- Setup completion stays derived, extended to five steps. The household document gains a name-confirmed stamp (a document migration, the same pattern the timezone stamp used); the derivation additionally reads "any provider key present" as a boolean from the secrets store — the domain sees presence, never values. Rejected: a stored "setup done" flag — derived truth cannot drift.
- Re-gate everyone once, no grandfathering. Rejected: a completion-version stamp — extra stored state to avoid one honest visit.
- Key presence, not probe success, completes the key step. Rejected: gating on a usable model — an offline first launch would lock the household out of its own app.
- Settings' embedded wizard is replaced by a Household section (name + timezone), reusing the wizard's per-section card components rather than new form code.

## Test seams
- The setup suite (domain + HTTP) — prior art for the derivation, the household-document migration, and the route guard battery; gains the name-confirmed step, the key-presence step, the household-name PATCH (both roles, revision conflicts), and the member 403 on key writes from the setup page.
- The client suite — prior art for the Today gate and wizard frame handling; now pins the shell-level route redirection (incomplete: any hash → setup, nav hidden; complete: `#/setup` → today).
- The browser-render suite — prior art for asserting the first painted screen at 320/360/390/430 px in a pinned real Chromium; the mandatory setup page is now the expected first screen for an unconfigured fixture in every viewport.
- The e2e suite — gains a first-launch leg: owner link → setup page only → five steps saved → Today renders; partner invited after completion never sees the setup page.
The highest seam is the browser-render suite (the real app in a real browser); domain derivations and guard semantics stay pinned at the HTTP/domain seam.

## Acceptance criteria
- [ ] AC1 (R1): with setup incomplete, loading any route (`#/today`, `#/settings`, …) renders the setup page and no bottom navigation.
- [ ] AC2 (R2): with setup complete, `#/setup` redirects to Today and the page is not reachable from the app.
- [ ] AC3 (R3): the API reports `setup.missing` entries for `name`, `timezone`, `puppy`, `meals`, `key`, and `complete: true` only when all five are satisfied.
- [ ] AC4 (R4): confirming the default name without editing it stamps the household document, writes an activity line, and bumps the household revision once (a single commit).
- [ ] AC5 (R5): saving one provider key flips the key step to done without any probe run; the key value never appears in any response or log.
- [ ] AC6 (R5): a member session on the setup page sees a read-only key card and receives 403 if the key write is attempted.
- [ ] AC7 (R6): the setup page renders five numbered cards with an "N of 5 ready" lead in all four phone viewports.
- [ ] AC8 (R7): Settings has a Household section (name + timezone) and no embedded wizard; Pup, the meal-times editor and the model/budget card are unchanged.
- [ ] AC9 (R8): a partner invited after completion goes straight to Today.
- [ ] AC10 (R9): a household complete under the old rule reports incomplete under the new rule and completes after the name confirm (with a key already present).
- [ ] AC11: the existing setup-time server writes keep their commit/revision/idempotency semantics (replays, stale 409s, refusals write nothing).

## Verification
- `npm run typecheck`
- `npm test` (setup, client, model-routes, owner-ui and e2e suites)
- The browser-render suite (pinned Chromium): the first screen is the setup page at 320/360/390/430 px.
- Manual walk: fresh data dir → owner link → only the setup page; complete it → the normal app; revisit `#/setup` → Today.

## Open assumptions
- A1 (R9): the deployed household already has a provider key in `secrets.json`; if not, its owner re-enters it once. The user accepted the re-gate; low risk.
- A2: the household-name confirm is writable by both caregivers, like the timezone confirm. Low risk; the plan's auth matrix decides, not this spec.
- A3: the setup page reuses the Settings model-card components for the key inputs; visual duplication beats new abstractions. Low risk.
- A4: losing drafts on a hard reload of the setup page stands (the known carried limitation). Accepted.
