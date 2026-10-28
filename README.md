# Pupkeep

A shared, agent-operated puppy care app for two caregivers, built on
[Pi Durable](https://github.com/earendil-works/pi).

> **Status: planning.** There is no app code yet. The source of truth is
> [`docs/PLAN.md`](docs/PLAN.md). The plan is written so it can be turned into
> todo tasks phase by phase.

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
  └─ Node 24 + Pi Durable 1.4.0 + SQLite
      ├─ Pupkeep server (HTTP, SSE, PWA)
      ├─ one shared household agent conversation
      ├─ durable reminder tasks
      └─ Web Push
           ▲
           │ localhost / Cloudflare Tunnel
     Chrome PWA on both caregivers' phones
```

The host stack follows the **Pi Pocket** pattern (TannerMidd/pi-pocket):
Termux, a launcher that chooses how devices connect, a browser UI, PWA push,
owner/invite auth, and one process owning one SQLite file. The Puppy domain is
new; the host infrastructure is reused or adapted from Pi Pocket under MIT,
with attribution.

No pidabl. No embedded Termux rootfs. No Android Gradle build. No targetSdk 28.

## Read the plan

- [`docs/PLAN.md`](docs/PLAN.md) — product, architecture, data model, shared
  thread, models and budget, host runbook, phases, task breakdown, risks.
- [`AGENTS.md`](AGENTS.md) — instructions for coding agents working in this repo.
- [`NOTICE.md`](NOTICE.md) — upstream projects and licences.

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
pkg install nodejs git cloudflared termux-api
git clone <repo> ~/pupkeep
cd ~/pupkeep && npm ci --omit=dev
termux-wake-lock
npm start -- --access cloudflare --data ~/.pupkeep
```
