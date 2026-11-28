---
status: ready
blocked-by: ["01"]
---

# 02: Setup page — household-name card and provider-key card

**Blocked by:** 01
**Status:** ready

## What to build
The Setup component (wherever it is mounted today) renders five numbered cards with an "N of 5 ready" lead. Two cards are new: a household-name card with the confirm-if-unchanged semantics of the timezone card, and an owner-only provider-key card that reuses the Settings model-card pieces — key inputs for the known providers, the probe/model status visible, but a failed or skipped probe never blocks completion. A member sees a read-only card saying only the owner can add keys, and a key write attempt gets 403. Saving a key flips the step to done with no probe run required.

## Scope
The Setup component and its section-card structure, the shared form helpers it already uses, and its tests. Touches nothing in Settings (03) and no routing (04). Key values are never rendered or echoed — only presence booleans.

## Acceptance criteria
- [ ] AC5: saving one provider key flips the key step to done without any probe run.
- [ ] AC6: a member session sees the read-only key card and receives 403 on the key write.
- [ ] AC7 (component level): five numbered cards and the "N of 5 ready" lead render from the derived step list.
- [ ] Live SSE frames keep the existing dirty-draft/conflict behavior for the two new cards.

## Validation
The client suite plus `npm run typecheck` and `npm test`. Covers spec behaviors R5, R6.
