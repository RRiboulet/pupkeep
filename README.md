# Pupkeep

A shared, agent-operated puppy care app for two caregivers, built on
[Pi Durable](https://github.com/earendil-works/pi).

> **Status: Phase 1 — the skeleton is being built.** Phase 0's spikes are
> complete and their go/no-go is recorded in
> [`docs/PLAN.md`](docs/PLAN.md) §2.3. There is still no app logic: `src/`, `web/`,
> `scripts/` and `test/` hold placeholders until their Phase 1 tasks land. The
> source of truth is [`docs/PLAN.md`](docs/PLAN.md);
> [`docs/TODO-GUIDE.md`](docs/TODO-GUIDE.md) says how to pick the next task.
>
> Three Phase 0 checks stay open because they need the partner's iPhone: the
> partner reach, PWA/Web Push and ntfy receipts carried by **P0-10**
> ([`docs/partner-ios-checklist.md`](docs/partner-ios-checklist.md)).

## What it is

Pupkeep is a household cockpit for raising a puppy:

- one puppy, one household, two caregivers;
- a shared agent thread that **operates the app** — logging feeds, starting and
  ending walks, recording weights, adding vet appointments, updating milestones;
- a live Today view, calendar, growth chart, milestone board and shower log;
- one source of truth, durable commits, and no double feeding;
- a browser/PWA client, hosted from a phone running Termux — no native app, no
  APK, no port to Android, iOS or Linux.

The agent is not a puppy-care chatbot. It has no shell, file, web or veterinary
knowledge tools. It can only read and change the app through Pupkeep tools. The
only “advice” in the product is deterministic growth-trend copy with a
non-veterinary disclaimer.

## Host stack

```text
Android phone (Termux)
  └─ Node 24 (pinned for development; the phone measured Node 26) + Pi Durable 1.4.0 + SQLite
      ├─ Pupkeep server (HTTP, SSE, PWA)
      ├─ one shared household agent conversation
      ├─ durable reminder tasks
      └─ in-app notifications + optional Web Push over HTTPS
           ▲
           │ host: localhost · partner: Tailscale (daily)
           │ testing: Cloudflare quick tunnel (HTTPS)
     Chrome on both caregivers' phones
```

The host stack follows the **Pi Pocket** pattern (TannerMidd/pi-pocket):
Termux, a launcher that chooses how devices connect, a browser UI, owner/invite
auth, in-app notifications, host local notifications, a recommended ntfy bridge
for the partner, and one process owning one SQLite file. PWA installation/Web
Push is available on localhost and over an HTTPS quick tunnel for testing; daily
partner access is Tailscale HTTP. The host infrastructure is
reused or adapted from Pi Pocket under MIT, with attribution.

No pidabl. No embedded Termux rootfs. No Android Gradle build. No targetSdk 28.

## Read the plan

- [`docs/PLAN.md`](docs/PLAN.md) — product, architecture, data model, shared
  thread, models and budget, host runbook, phases, task breakdown, risks. §4 is
  the repository layout, §2.3 the Phase 0 go/no-go.
- [`docs/TODO-GUIDE.md`](docs/TODO-GUIDE.md) — how to pick a task, branch/PR
  rules, definition of done, and the 59-task index.
- [`docs/partner-ios-checklist.md`](docs/partner-ios-checklist.md) — the Phase 0
  checks that need the partner's iPhone (P0-10).
- [`AGENTS.md`](AGENTS.md) — instructions for coding agents working in this repo.
- [`NOTICE.md`](NOTICE.md) — upstream projects and licences.

## Repository layout

[`docs/PLAN.md`](docs/PLAN.md) §4 is authoritative. In short: `src/` for the
server, launcher and shared code; `web/` for the no-build browser client;
`bin/` for the launcher entry point; `scripts/` for the Termux and backup
scripts; `test/` for `node --test`. Directories that Phase 1 has not filled yet
carry a `.gitkeep` and nothing else — no `android/`, no rootfs, no Gradle.

## Development tooling

Agents work in this repository through the shared package pinned in
[`.pi/settings.json`](.pi/settings.json):
`git:github.com/RRiboulet/my-agent-setup@v1.9.0`, which targets pi `1.4.0` — the
same pi version the plan pins for the runtime. Pi loads project packages only
after project trust is granted.

## Planned commands

These are the commands the finished repo will expose; they are listed now so the
plan is concrete, not because they run yet.

```bash
npm ci
node --test
npm start -- --access local
```

On the phone:

```bash
pkg install nodejs git termux-api sqlite rclone termux-services tmux
# cloudflared is NOT in the Termux package repo (P0-03). Use the arm64 release
# binary in ~/.pupkeep/bin, and run it only through the wrapper in PLAN §6.7.
git clone <repo> ~/pupkeep
cd ~/pupkeep && npm ci --omit=dev
termux-wake-lock
npm start -- --access tailscale --data ~/.pupkeep
# for HTTPS/PWA/push testing only:
# npm start -- --access cloudflare --data ~/.pupkeep
```
