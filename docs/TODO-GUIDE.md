# Todo guide — how to work the Pupkeep plan

**Status:** planning / Phase 0 ready. No app code yet.

**Source of truth:** [`docs/PLAN.md`](PLAN.md). The local todos in `.pi/todos/`
are the working view; they are not committed and are ignored by git. The
durable backlog is PLAN §16.

This guide exists so a new agent can pick one todo and work it without
re-reading the whole 1,700-line plan. Read the plan sections named in the todo,
this guide, and the task body.

## 1. Where the todos live

The task files are in `.pi/todos/` in this checkout (one markdown file per
task, with JSON front matter). If the pi todo extension is installed, open a pi
session in `/workspace/pupkeep` and use `/todos`; otherwise read the files
directly.

Each todo has:

- a plan ID (`P0-01`, `P1-06`, …) in its title;
- tags (`phase-0`, `spike`, `security`, …);
- dependencies;
- a goal, read-first list, work steps, done criteria and guardrails.

## 2. How to pick work

1. Start with the earliest open phase. Do not start P1 app code until G0 is
   recorded (PLAN §16 Phase 0 exit criteria).
2. Prefer tasks whose dependencies are closed. Within a phase, run independent
   tasks in parallel only if they touch different files/subsystems.
3. Claim the task in the todo manager before editing. If two agents would touch
   the same file, split the task or serialize.
4. If a task is larger than roughly one focused day, split it into sub-tasks and
   link them from the original. Do not silently expand scope.

Recommended first wave:

- **P0-01** Termux/Pi Durable runtime
- **P0-03** Tailscale daily + quick-tunnel test
- **P0-08** host local + ntfy notification path

These three answer the riskiest host questions. P0-02, P0-04, P0-05, P0-06 and
P0-07 can run in parallel where the phone/devcontainer permits.

## 3. Branch and PR workflow

- `main` is the integration branch; work on a short-lived feature branch.
- Branch from the current `main`; fetch first.
- Commit with a Conventional Commits-style subject; keep the plan ID in the body
  or subject where useful.
- Open a PR with what changed, what was verified, and which task IDs it closes.
- Do not commit `.pi/todos/`, `data/`, `.env`, secrets or SQLite files.

## 4. Shared rules

- **No app code in Phase 0.** Phase 0 is scratch scripts and measurements only.
- **Pi Durable `1.4.0`**, Pi AI `1.4.0`, Chord `1.4.0`; pin exact versions.
- **No native modules** in the phone runtime; `node:sqlite` only.
- **One process, one SQLite file.** Never run two servers against the same data
  directory.
- **One household, one puppy, one shared human-facing thread.** The hidden
  system conversation is task-owner only and has no model.
- **Care actions are one durable commit.** Auth/push config writes are
  serialized atomic JSON.
- **The product agent has app tools only.** No shell, files, web, SQL or
  arbitrary HTTP tools.
- **No secrets in git, logs, tool output, ntfy or push bodies.** The owner link,
  invite tokens, cookies, session tokens and provider keys are all sensitive.
- **No domain.** Tailscale is daily; the Cloudflare quick tunnel is testing-only;
  ntfy is the recommended partner notification path.
- **No Web Push claim on Tailscale HTTP.** Host localhost and the HTTPS test path
  only.
- **No general puppy/vet advice.** Deterministic trend copy only.
- **One puppy, no photos, no external calendar sync, no offline writes, no
  email/SMS, no multi-dog in v1.**

## 5. Definition of done

Every task is done only when:

- the named plan sections and task guardrails are satisfied;
- the smallest useful change is implemented, with tests for the invariant;
- `npm run typecheck` and `npm test` pass (once the scripts exist);
- the relevant phone/manual check is recorded;
- the PR body states what was verified and what was not;
- the plan/task is updated if a decision changed;
- no secret, ignored file or unrelated change is included.

If the task is a spike, “done” means a written evidence note, not app code.

## 6. Report template

```text
Task: P0-03
Base: <branch/commit>
Changed: <files or "no code — evidence note">
Verified: <commands, devices, outputs>
Not verified: <gaps>
Decision/risk: <what a reviewer should know>
Next: <task IDs>
```

## 7. Phase order and gates

| Phase | Gate | Meaning |
|---|---|---|
| P0 | G0 | Runtime, access, notifications, attribution, models, backup and Termux resilience measured; decision record written |
| P1 | G1 | Two caregivers, one household, profile, shared thread, restart-safe |
| P2 | G2 | One feed event under concurrency, durable walk, notification intent |
| P3 | G3 | Growth, milestones, showers correct and agent-accessible |
| P4 | G4 | Reminders survive restart, cancel works, host/ntfy notifications work, approvals safe |
| P5 | G5 | Restore, E2E, security review, release |

## 8. Task index

| Plan ID | Task | Depends | Tags |
|---|---|---|---|
| `P0-01` | Termux runtime and Pi Durable spike | none | phase-0, spike, runtime, host |
| `P0-02` | Review Pi Pocket host modules for reuse | none | phase-0, spike, host, license |
| `P0-03` | No-domain access: Tailscale daily, quick tunnel test | P0-01 | phase-0, spike, host, access, tunnel |
| `P0-04` | Shared-thread actor attribution spike | P0-01 | phase-0, spike, agent, concurrency |
| `P0-05` | Live model probes and budget simulation | none | phase-0, spike, models, budget |
| `P0-06` | Termux resilience and supervision | P0-01 | phase-0, spike, host, durability |
| `P0-07` | Encrypted backup and restore spike | P0-01 | phase-0, spike, durability, security |
| `P0-08` | No-domain notification path | P0-01, P0-03 | phase-0, spike, notifications, host |
| `P0-09` | Phase 0 decision record | P0-01..P0-08 | phase-0, decision, docs |
| `P1-01` | Scaffold the app repository | G0 / P0-09 | phase-1, repo |
| `P1-02` | Devcontainer with Node, pi and host tooling | P1-01 | phase-1, devcontainer, host |
| `P1-03` | Dependencies, scripts and no-build runtime | P1-01 | phase-1, runtime, web |
| `P1-04` | Launcher: access modes and supervision | P1-02, P1-03 | phase-1, host, access |
| `P1-05` | Data directory, config, secrets and log scrub | P1-03 | phase-1, security, runtime |
| `P1-06` | Auth, invites, sessions and authz | P1-05 | phase-1, security, auth |
| `P1-07` | Harness, SQLite and recovery | P1-03, P1-05 | phase-1, runtime, durability |
| `P1-08` | Session docs and bootstrap | P1-07 | phase-1, domain, runtime |
| `P1-09` | Shared conversation, SSE and snapshots | P1-07, P1-08 | phase-1, agent, api |
| `P1-10` | PWA shell and security headers | P1-04 | phase-1, web, security |
| `P1-11` | Puppy profile: domain, tools, UI | P1-08, P1-09, P1-10 | phase-1, domain, agent, web |
| `P1-12` | Phase 1 tests and CI | P1-06, P1-09, P1-11 | phase-1, tests |
| `P1-13` | Phone runbook draft | P1-04, P1-06 | phase-1, docs, host |
| `P1-14` | First-run puppy and meal-slot wizard | P1-11 | phase-1, web, domain |
| `P2-01` | Feeding document and invariants | G1 | phase-2, domain |
| `P2-02` | Feed domain service and idempotency | P2-01 | phase-2, domain, durability |
| `P2-03` | Feed HTTP routes | P2-02 | phase-2, api |
| `P2-04` | Feed agent tools | P2-02, P1-09 | phase-2, agent |
| `P2-05` | Today meals UI | P2-03, P1-10 | phase-2, web |
| `P2-06` | Walks document and domain service | P2-01 | phase-2, domain, durability |
| `P2-07` | Walks HTTP, tools and UI | P2-06, P1-10 | phase-2, api, agent, web |
| `P2-08` | Feeding/walk durability and multiplayer tests | P2-05, P2-07 | phase-2, tests, durability |
| `P2-09` | Feed reminder task skeleton | P2-02, P4-03 | phase-2, notifications |
| `P3-01` | Growth document and service | G2 | phase-3, domain |
| `P3-02` | Growth trend and advice rules | P3-01 | phase-3, domain, tests |
| `P3-03` | Growth HTTP, tools and UI | P3-02, P1-10 | phase-3, api, agent, web |
| `P3-04` | Training document and milestone catalog | G2 | phase-3, domain |
| `P3-05` | Milestone HTTP, tools and UI | P3-04, P1-10 | phase-3, api, agent, web |
| `P3-06` | Shower document and service | G2 | phase-3, domain |
| `P3-07` | Shower HTTP, tools and UI | P3-06, P1-10 | phase-3, api, agent, web |
| `P3-08` | Phase 3 tests | P3-03, P3-05, P3-07 | phase-3, tests |
| `P4-01` | Calendar document and service | G3 | phase-4, domain |
| `P4-02` | Appointment HTTP, tools and Calendar UI | P4-01, P1-10 | phase-4, api, agent, web |
| `P4-03` | Appointment reminder tasks | P4-01, P1-07 | phase-4, notifications, durability |
| `P4-04` | Daily feed planner and reminder tasks | P2-02, P4-03 | phase-4, notifications, durability |
| `P4-05` | Notification outbox, Web Push and service worker | P4-03, P4-04, P1-05 | phase-4, notifications, security |
| `P4-06` | Notification centre, prefs, host local and ntfy | P4-05, P1-10 | phase-4, notifications, web |
| `P4-07` | Approvals and one-commit confirmation | P1-06, P1-09 | phase-4, agent, security |
| `P4-08` | Budget ledger, model picker and provider keys | P1-06, P4-05 | phase-4, models, security, web |
| `P4-09` | Daily access and notification runbook | P4-05, P1-13 | phase-4, docs, host, access |
| `P4-10` | Phase 4 tests | P4-03..P4-07 | phase-4, tests |
| `P5-01` | Kill/restart matrix on the phone | G4 | phase-5, durability, host |
| `P5-02` | Backup/restore drill | P0-07, G4 | phase-5, durability, security |
| `P5-03` | Two-client E2E | G4 | phase-5, tests, web |
| `P5-04` | Termux scripts and runbook polish | P1-13, P4-09 | phase-5, docs, host |
| `P5-05` | Daily-phone battery/heat/phantom checks | P0-06 | phase-5, host, docs |
| `P5-06` | Security review | P5-03 | phase-5, security, tests |
| `P5-07` | Performance and data growth | G4 | phase-5, runtime, durability |
| `P5-08` | Release | G5 | phase-5, release, docs |
| `P5-09` | Final docs and limitations | P5-08 | phase-5, docs |

## 9. Stop rules

- Pi Durable cannot run on Termux → move the server to Docker/VPS; keep the same
  code and restore the backup.
- Tailscale binding fails → LAN or quick tunnel explicitly; never bind `0.0.0.0`
  silently.
- ntfy is rejected → in-app only or buy a domain; do not pretend Tailscale HTTP
  has Web Push.
- Termux is killed too often → move to the VPS; the phone becomes a client.
- Default model unavailable → use the live probe’s cheapest paid fallback; the
  $10 cap stands.
