# Pupkeep

A shared, agent-operated puppy care app for two caregivers, built on
[Pi Durable](https://github.com/earendil-works/pi).

> **Status: Phase 1 — the skeleton is being built.** Phase 0's spikes are
> complete and their go/no-go is recorded in
> [`docs/PLAN.md`](docs/PLAN.md) §2.3. The launcher, auth, data files, harness,
> storage, encrypted backup job and reproducible devcontainer are in place; the
> HTTP/UI layer and the first domain documents are still P1-08/P1-09/P1-10. The
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

**No pi package is declared here on purpose.** This repository usually lives
inside a workspace that already loads the shared `my-agent-setup` extensions, and
declaring the same package again makes every extension load twice — the first
version of this repo did, and subagents launched in this directory failed at
startup with `Flag "--attach-subagent" conflicts with …`. A standalone clone can
add the package to its own local settings; the repo does not force it. The pi
runtime the plan pins is `1.4.0`, enforced by the devcontainer (P1-02) rather
than by a file here.

**The development agent is not the product agent, and they must never be
confused.** The pi coding agent used to build this repo has shell, file and web
tools — that is how the code gets written. The agent *inside* Pupkeep has only
app tools (`get_context`, `update_puppy_profile`, feeding, walks, and so on): no
shell, no filesystem, no browser, no arbitrary HTTP, no SQL (PLAN §10, §14.3). A
change that hands the product agent a general-purpose tool is a security defect,
not a convenience.

Node: `engines.node` is `>=24`. The devcontainer and CI use Node 24; the phone
measured Node 26.12.1 in Phase 0. That difference is deliberate and recorded (the
runtime floor is 24, and P5-01 re-measures on the phone) rather than pinned to a
single major that would make one of the two environments non-conforming.

## Devcontainer

`.devcontainer/` builds from
`mcr.microsoft.com/devcontainers/javascript-node:24-bookworm` and installs Node
24, pi coding agent `1.4.0`, sqlite3, cloudflared, rclone, tmux, gh, jq, age,
expect and the rest of the host tooling. Open the repo with the Dev Containers
extension; `postCreate.sh` runs `npm ci`, `npm run typecheck` and `npm test`, and
seeds `.env` only when it is absent.

On a host with no editor — the phone-hosted or headless case — use `devc` from
`my-agent-setup` instead, which is the same `devcontainer up` plus an interactive
login shell in tmux:

```bash
devc pupkeep            # build if needed, then attach a shell in the container
devc pupkeep -- npm test
devc rebuild pupkeep    # recreate the container; named volumes are kept
devc doctor pupkeep     # docker, CLI, disk, uid and arch preflight
```

It publishes 8787 on the host's loopback, so `ssh -L 8787:127.0.0.1:8787 <host>`
from a phone reaches the dev server without opening a port to the internet.

- pi settings, sessions, model/provider auth and the gh token persist in the
  `pupkeep-pi-config` volume at `/home/vscode/.pi`; run `gh auth login` and pi's
  own login once per volume. gh is pinned to `2.103.2`.
- `npm start` reads `.env` with `--env-file-if-exists`; a real environment
  variable wins over the file. The container installs the cloudflared build for
  its own architecture (amd64 or arm64), each pinned by SHA-256; the phone uses
  the arm64 release.
- The development database is `/tmp/pupkeep-dev`, never the workspace mount.
- The shared `my-agent-setup` package is installed at `v1.10.0` into the
  container's personal pi settings; it is deliberately not declared in
  `.pi/settings.json`, which would duplicate the enclosing workspace's
  extensions.
- Port 8787 is published on the host's loopback (`127.0.0.1:8787:8787`), which is
  what makes the dev server reachable from outside the container; `forwardPorts`
  alone does nothing headless. Reach it from a phone with `ssh -L
  8787:127.0.0.1:8787 <host>` or `tailscale serve` on the host. Never publish it
  on `0.0.0.0`.
- CI builds this image on `.github/workflows/devcontainer.yml`; a devcontainer
  or package-manifest change cannot merge without a real build, a `postCreate`
  run and the test suite.

## Commands

```bash
npm ci                 # installs the pinned runtime deps (no native modules)
npm run typecheck      # tsc --noEmit; erasable-only syntax, so node can strip it
npm test               # node --test, TypeScript directly, no build step
npm start              # launcher -> server
npm run backup -- --data ~/.pupkeep --remote <rclone:path>
npm run restore -- --data ~/.pupkeep --archive <file.age> --force
```

`npm start` starts the launcher and the server. The server's listener is a
scaffold until P1-09/P1-10: `/healthz` answers and every other route is 503. The
backup passphrase comes from `PUPKEEP_BACKUP_PASSPHRASE` or a `--passphrase-file`
outside the data and backup directories; it is never stored beside the archive.
The browser client needs no build step either: `web/vendor/` holds the pinned
Preact/htm ES modules, checked against `NOTICE.md` by `test/vendor.test.ts`.

## On the phone

```bash
pkg install nodejs git termux-api sqlite rclone age expect tar termux-services tmux
# cloudflared is NOT in the Termux package repo (P0-03). Use the arm64 release
# binary in ~/.pupkeep/bin, and run it only through the wrapper in PLAN §6.7.
git clone <repo> ~/pupkeep
cd ~/pupkeep && npm ci --omit=dev
termux-wake-lock
npm start -- --access tailscale --data ~/.pupkeep
# for HTTPS/PWA/push testing only:
# npm start -- --access cloudflare --data ~/.pupkeep
```
