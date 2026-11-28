# Pupkeep

A shared, agent-operated puppy care app for two caregivers, built on
[Pi Durable](https://github.com/earendil-works/pi).

> **Status: v0.1.0 is released.** Phases 0–4 are complete and Phase 5's
> hardening has landed: the kill/restart matrix (`test/kill-matrix.test.ts` plus a
> recorded walk on the phone), the security review ([`docs/security-review.md`](docs/security-review.md)),
> the data-growth measurements and the monthly archive, the backup/restore drill
> ([`docs/backup-drill.md`](docs/backup-drill.md)), the release itself
> ([`CHANGELOG.md`](CHANGELOG.md), tag `v0.1.0`) and the real-browser render
> checks. Every pull request typechecks and runs the full suite
> (`.github/workflows/ci.yml`).
>
> **Phase 6 has moved the intended host off the phone.** The household's daily
> server is designed to be the Oracle arm64 box behind Caddy on
> `https://pupkeep.duckdns.org`; the phone is a browser and an offline fallback on
> the household LAN (`--access lan`).
> `P6-08` deleted the `tailscale` and `cloudflare` access modes and the
> Termux:API notification transport; `ACCESS_MODES` is `local | lan | public`, and
> notifications are in-app + Web Push + optional ntfy. The box has **not** been
> built, deployed or reached through Caddy yet — that is `P6-09`/`P6-10`.
>
> **What is still unproven is listed in [Known limitations](#known-limitations),
> not here.** The short version: the box's deployment legs, the partner's iPhone,
> a restore on a genuinely clean host, two real devices at once, a day-long phone
> run, and the fallback's boot path on a phone since `P6-08`.
>
> The source of truth is [`docs/PLAN.md`](docs/PLAN.md);
> [`docs/TODO-GUIDE.md`](docs/TODO-GUIDE.md) says how to pick the next task. Three
> guides, on purpose: [`docs/PHONE-RUNBOOK.md`](docs/PHONE-RUNBOOK.md) is the
> operator's copy for the offline fallback host,
> [`docs/access-and-notifications.md`](docs/access-and-notifications.md) is the
> caregivers' copy, and [`docs/DEPLOY.md`](docs/DEPLOY.md) is how a version gets
> onto the box and onto the fallback.

## What it is

Pupkeep is a household cockpit for raising a puppy:

- one puppy, one household, two caregivers;
- a shared agent thread that **operates the app** — logging feeds, starting and
  ending walks, recording weights, adding vet appointments, updating milestones;
- a live Today view, calendar, growth chart, milestone board and shower log;
- one source of truth, durable commits, and no double feeding;
- a browser/PWA client on the public HTTPS origin, and an offline fallback that
  runs the same server on a phone — no native app, no APK, no port to Android,
  iOS or Linux.

The agent is not a puppy-care chatbot. It has no shell, file, web or veterinary
knowledge tools. It can only read and change the app through Pupkeep tools. The
only “advice” in the product is deterministic growth-trend copy with a
non-veterinary disclaimer.

## Host stack

```text
Oracle A1 (arm64, Docker Compose)          the household's host
  caddy — publishes 80/443, ACME for pupkeep.duckdns.org
  pupkeep — Node 24+ · Pi Durable 1.4.0 · SQLite
      ├─ Pupkeep server (HTTP, SSE, PWA) on the configured origin
      ├─ one shared household agent conversation
      ├─ durable reminder tasks
      └─ in-app notifications + Web Push + optional ntfy
           ▲ https://pupkeep.duckdns.org
     caregiver browsers/PWAs on any network

Android phone (Termux)                     offline fallback + client
  └─ same launcher and server at --access lan on the household LAN
```

The host stack follows the **Pi Pocket** pattern (TannerMidd/pi-pocket):
Termux, a launcher that chooses how devices connect, a browser UI, owner/invite
auth, in-app notifications, Web Push and an optional per-user ntfy bridge, and
one process owning one SQLite file. `P6-08` retired the two tunnel-era access
modes; the phone's copy of the server survives as the offline fallback. The host
infrastructure is reused or adapted from Pi Pocket under MIT, with attribution.

No pidabl. No embedded Termux rootfs. No Android Gradle build. No targetSdk 28.

## Read the plan

- [`docs/PLAN.md`](docs/PLAN.md) — product, architecture, data model, shared
  thread, models and budget, host runbook, phases, task breakdown, risks. §4 is
  the repository layout, §2.3 the Phase 0 go/no-go.
- [`docs/PHONE-RUNBOOK.md`](docs/PHONE-RUNBOOK.md) — the offline fallback host:
  install, boot and supervision, the `--access lan` boot path, operator SSH,
  notifications, backup, troubleshooting.
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — deploying a tag to the box and to the
  phone fallback (the box is unbuilt; the note says so).
- [`docs/access-and-notifications.md`](docs/access-and-notifications.md) — the
  caregivers' copy: the public origin, the invite, Web Push, ntfy, the LAN
  fallback.
- [`CHANGELOG.md`](CHANGELOG.md) — what each release shipped, with its task IDs,
  and what that release does **not** prove.
- [`docs/backup-drill.md`](docs/backup-drill.md) — the P5-02 drill: what a real
  bundle survived, and the three things it caught.
- [`docs/kill-restart-matrix.md`](docs/kill-restart-matrix.md) — the phone's
  kill/reboot/tunnel matrix, a **historical** Phase 5 record with its
  observations and timestamps (the tunnel mode it walked was deleted by `P6-08`).
- [`docs/security-review.md`](docs/security-review.md) — the P5-06 record:
  thirteen attempts, each naming the test that produced its evidence.
- [`docs/data-growth.md`](docs/data-growth.md) — the P5-07 measurements (host and
  phone) and the checkpoint/archive decisions behind them.
- [`docs/TODO-GUIDE.md`](docs/TODO-GUIDE.md) — how to pick a task, branch/PR
  rules, definition of done.
- [`docs/partner-ios-checklist.md`](docs/partner-ios-checklist.md) — the Phase 0
  checks that need the partner's iPhone (P0-10).
- [`AGENTS.md`](AGENTS.md) — instructions for coding agents working in this repo.
- [`NOTICE.md`](NOTICE.md) — upstream projects and licences.

## Repository layout

[`docs/PLAN.md`](docs/PLAN.md) §4 is authoritative. In short: `src/` for the
server, launcher and shared code; `web/` for the no-build browser client;
`bin/` for the launcher entry point; `scripts/` for the Termux and backup
scripts; `test/` for `node --test`; `deploy/` and `Dockerfile` for the box, with
`docker-compose.yml` as its stack. No `android/`, no rootfs, no Gradle.

## Development tooling

**No pi package is declared in this repo on purpose.** The devcontainer image
bakes `my-agent-setup` at the release selected by
`.devcontainer/pi-agent-setup.version`
under `/opt/pi-packages/my-agent-setup`, and `postCreate.sh` declares that baked
path in the container's own agent settings. Declaring it in `.pi/settings.json`
as well would make every extension load twice — the first version of this repo
did, and subagents launched in this directory failed at startup with
`Flag "--attach-subagent" conflicts with …`. The pi runtime the plan pins is
`1.7.0`, enforced by the devcontainer (P1-02) rather than by a file here.

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
24, pi coding agent `1.7.0`, sqlite3, cloudflared, rclone, tmux, gh, jq, age,
expect and the rest of the host tooling. Open the repo with the Dev Containers
extension; `postCreate.sh` runs `npm ci`, installs the Chromium the render checks
drive, then `npm run typecheck` and `npm test`, and seeds `.env` only when it is
absent.

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

- pi settings, sessions, trust and gh config persist in the project's private
  `pupkeep-pi-config` volume at `/home/vscode/.pi`. Saved `auth.json`,
  `models-store.json` and `models.json` instead symlink to the host's
  `~/.pi/shared-agent-state` mount at `/shared-pi-state`, shared with every
  devcontainer; Pi locks the resolved files across containers. Provider keys and
  `GH_TOKEN` also arrive from the host environment through `${localEnv:...}`
  (`devc` sources `~/.config/devc/env`); no other container shares this volume. gh is pinned to
  `2.103.2`.
- `npm start` reads `.env` with `--env-file-if-exists`; a real environment
  variable wins over the file. The container installs the cloudflared build for
  its own architecture (amd64 or arm64), each pinned by SHA-256. That copy is for
  the **devcontainer's** HTTPS testing only — `P6-08` deleted the phone's
  `cloudflared` and the `cloudflare` mode, so it is not part of the product path.
- The development database is `/tmp/pupkeep-dev`, never the workspace mount.
- The `my-agent-setup` package tracks the latest stable release and is baked
  into the image before `postCreate` declares it in the container's personal pi
  settings; it is deliberately not declared in `.pi/settings.json`, which would
  load every extension twice. The host initialize step resolves the release and
  writes an ignored stamp, so a normal rebuild refreshes it without `--no-cache`.
  `sh .devcontainer/check-pi-agent-setup.sh` (also run by CI) fails when the
  policy, resolver, Dockerfile, resolution stamp and running image disagree.
- Port 8787 is published on the host's loopback (`127.0.0.1:8787:8787`), which is
  what makes the dev server reachable from outside the container; `forwardPorts`
  alone does nothing headless. Reach it from a phone with `ssh -L
  8787:127.0.0.1:8787 <host>` or `tailscale serve` on the host. Never publish it
  on `0.0.0.0`.
- The dev server runs with `--access lan` inside the container (Docker publishes
  to the container's interface, never its loopback), so the owner link it mints
  names the container's own address — `http://172.x.x.x:8787/login?token=…` —
  which a tunnel cannot open. Read the link and swap the authority before
  opening it: `sed -E 's#^http://[^/]+#http://127.0.0.1:8787#' ~/.pupkeep/owner-link.txt`
  (the dev database is `/tmp/pupkeep-dev`, so that path is
  `/tmp/pupkeep-dev/owner-link.txt` inside the container).
- CI builds this image on `.github/workflows/devcontainer.yml`; a devcontainer
  or package-manifest change cannot merge without a real build, a `postCreate`
  run and the test suite.

## Commands

```bash
npm ci                 # installs the pinned runtime deps (no native modules)
npm run typecheck      # tsc --noEmit; erasable-only syntax, so node can strip it
npm test               # node --test, TypeScript directly, no build step
npx playwright install --with-deps chromium
                       # once per container: the render checks skip without it
npm start              # launcher -> server (add --access and --port)
npm run measure:growth -- --days 500   # P5-07's measurements, on a temp dir
npm run backup -- --data ~/.pupkeep --remote <rclone:path>
npm run restore -- --data ~/.pupkeep --archive <file.age> --force
```

`npm start` starts the launcher and the server, and the server serves the whole
app: the API, the SSE stream and the PWA shell. The backup passphrase comes from
`PUPKEEP_BACKUP_PASSPHRASE` or a `--passphrase-file` outside the data and backup
directories; it is never stored beside the archive, and a killed run leaves a
`.partial` archive that nothing picks up (`docs/PHONE-RUNBOOK.md` §10).
The browser client needs no build step: `web/vendor/` holds the pinned
Preact/htm ES modules, checked against `NOTICE.md` by `test/vendor.test.ts`.

## On the phone

```bash
git clone <repo> ~/pupkeep && cd ~/pupkeep
./scripts/termux-install.sh          # packages, npm ci, boot wrapper
~/pupkeep-start.sh --access lan --port 8791
```

`scripts/termux-install.sh` upgrades the package index first, refuses a `node`
that cannot link and writes the Termux:Boot wrapper; it no longer fetches
`cloudflared` (`P6-08`). The boot script starts `--access lan` and does not wait
for a tailnet. Deploying a released version is different: `git checkout v0.1.0`
and restart — see [`docs/DEPLOY.md`](docs/DEPLOY.md). Port 8791 here because an
operator's own `ssh` forward lands on 8787.

## Known limitations

Every line here is something that was **not** verified, not something that "should
work". The guardrail is the same one P5-09 was given: honest about verification,
silent about intent.

**The host and the device legs**

- **The box is unbuilt and undeployed (P6-06/P6-09).** `Dockerfile`,
  `docker-compose.yml` and `deploy/` parse and their tests pass; no daemon here
  built them, no certificate was issued, no timer fired, and no page was served
  through Caddy. R0's preflight, the image, the certificate, the timers, the
  restore drill on the box and the partner's browser sign-in are all `P6-09`'s
  operator legs, and the 7-day resource run is `P6-10`'s.
- **The partner's iPhone (P0-10).** Reach on the public origin, PWA install, Web
  Push subscribe and re-subscribe after a browser-data clear, and ntfy receipts
  were never run on the partner's device. The web client and the push path are
  covered by tests and by the host-side suite; the *second device* is not.
- **The fallback's boot path since `P6-08`.** The boot wrapper and the boot line
  were verified on the device, but the script now starts `--access lan` and no
  longer waits for a tailnet, and that version has not been walked on a phone.
- **Two real clients at once (P5-03).** The two-caregiver paths are covered by
  tests with two sessions (feed races, 409s, the shared thread, approvals). Two
  actual devices in one session were never part of a run.
- **A day-long phone run (P5-05).** Battery, heat and the wake-lock effect are
  unmeasured, and they now matter only for the fallback. A five-minute seeded run
  is not that.
- **The phone's browser layout (P5-10's device half).** The render suite lays the
  app out in a pinned Chromium at 320/360/390/430 px, including Android text
  scale. A real panel with real fonts and Android's own font-size slider was not
  the thing that passed.

**Restore and the fallback**

- **A restore on a genuinely clean host (P5-02).** A real household bundle was
  restored on a *different* machine (this devcontainer, Node 24 against the
  phone's 26) and on a fresh directory on the phone, and it booted with
  `secrets.json` absent. Neither was a clean install.
- **The Docker/VPS image has never been run.** `Dockerfile`, `docker-compose.yml`
  and `deploy/` exist for the box (PLAN §6.1–§6.9); no daemon here has built
  them, and `docs/DEPLOY.md` says so. Treat the phone fallback as the only host
  path this repository has exercised, and the box as `P6-09`'s to prove.
- **An interrupted restore is unproven.** The window between moving the old state
  aside and installing the new one is milliseconds; twelve `SIGKILL` attempts
  never landed in it. The error path names the leftover directory and the code is
  read, but the drill did not observe it.
- **No schedule runs the backup job from this repository.** The host's timer is
  in `deploy/systemd/` and is one of the `P6-09` legs; the phone has no `crontab`
  and no `sv` unit, so the job there only runs when somebody runs it. An
  unattended run also needs a passphrase source that is *not* beside the archive,
  which is an operator decision, not a default this repo can pick for you.

**Product limits, by decision**

- **No purchased domain.** The free DuckDNS name is the origin; a purchased
  domain would be a rename, not a code change. The old Tailscale daily path and
  the quick tunnel were deleted with their modes (`P6-08`), not hidden.
- **The LAN fallback has no push.** Plain HTTP on a household LAN is not a secure
  context: no service worker, no PWA install and no Web Push there, and the
  in-app centre is its notification record. The client still falls back to polling
  every 4 s and probes the stream again every 60 s if the live stream dies
  (`web/live.js`), which is a resilience path rather than a daily limitation.
- **Member recovery is an operator procedure.** There is no self-service reset;
  the procedure is documented and tested, and a `--reset-member` CLI is backlog.
- **Agent proposals are limited to what it has tools for.** An appointment or meal
  schedule change is propose-only and needs a caregiver's confirmation; a history
  correction is not implemented at all.
- **One household, two caregivers, one process.** No replicas, no multi-instance
  deployment. A stale-lock takeover is read → unlink → exclusive create rather
  than compare-and-swap, so two *simultaneous manual* starts on one stale lock can
  in principle both clear it — the accepted Phase 1 residual (PLAN §3.2), since
  `flock` would need a native module the phone runtime forbids.
- **The partner's out-of-app notifications are best-effort.** Web Push is the
  daily channel on the public origin, and it still awaits P0-10's device receipt;
  ntfy is an optional per-user topic, not a guaranteed delivery channel. The
  in-app centre is authoritative.
