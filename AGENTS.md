# Agent notes

## First

Read [`docs/PLAN.md`](docs/PLAN.md) and [`docs/TODO-GUIDE.md`](docs/TODO-GUIDE.md).
The plan is the source of truth for product and architecture; the guide explains
how to pick a task, branch, verify and report. Do not build app code beyond the
current approved phase.

**Current state: v0.1.0 is released** (annotated tag on a commit whose CI passed,
GitHub release notes taken from `CHANGELOG.md`). Phases 0–4 are complete. Phase 5
is complete except the device legs, which are listed below and in the README's
**Known limitations** — that list, not this paragraph, is the honest statement of
what is unproven.

What Phase 5 landed, and where the record is:

- **P5-01a/P5-01b — the kill/restart matrix.** `test/kill-matrix.test.ts` covers a
  real `SIGKILL` mid-turn and right after four write acks, plus `--retry-parked`
  (the operator's only way out of a task parked at the harness's restart limit).
  The phone walk is [`docs/kill-restart-matrix.md`](docs/kill-restart-matrix.md):
  server-kill, launcher-kill, Termux-kill and the operator tunnel pass; the reboot
  cell has its boot line but still needs one reboot with Android **Always-on VPN**
  on, and the tunnel cell's cloudflared/DNS half is unproven.
- **P5-02 — the backup/restore drill**, [`docs/backup-drill.md`](docs/backup-drill.md):
  a real bundle restored on a different machine and booted without `secrets.json`,
  auth and VAPID survived, an off-device copy went over a real rclone sftp remote,
  a truncated archive was refused, and rotation did not orphan the oldest. It
  caught a real defect: the archive used to be encrypted to its **final** name, so
  a killed run left a truncated file that `--verify` and a default restore would
  pick. The cipher now writes `<name>.partial` and renames after verification. A
  clean-host restore, the Docker/VPS leg and a schedule are still open.
- **P5-04 — the phone scripts.** `scripts/termux-install.sh` upgrades the index
  before installing, refuses a `node` that cannot link, installs the package
  allowlist and writes the boot wrapper and the optional supervised tunnel;
  `termux-boot.sh` writes the boot line, takes a wake lock and starts the
  launcher; `termux-sshd.sh` binds the tailnet address and loopback only;
  `termux-tunnel.sh` refuses an alias that would starve it and prints the exit
  status of a dead tunnel. **Revised by P6-08:** the installer no longer fetches
  `cloudflared`, and the boot script starts `--access lan` and no longer waits
  for the tailnet (see Phase 6 below).
- **P5-06 — the security review**, [`docs/security-review.md`](docs/security-review.md)
  and `test/security.test.ts` (thirteen adversarial attempts, plus the
  agent-escape allowlist over tools and named imports).
- **P5-07 — performance and growth**, [`docs/data-growth.md`](docs/data-growth.md):
  `CHECKPOINT_DELTAS` is 1, feeding and closed walks archive by month, a care
  commit is flat in the household's age, and the phone's numbers exist (62.7 ms
  median commit, 8 ms cold read, WAL 4.2 MiB, 110 KiB backup).
- **P5-08 — the release**: `CHANGELOG.md`, [`docs/DEPLOY.md`](docs/DEPLOY.md), the
  root `Dockerfile`/`docker-compose.yml` (unbuilt), and the `v0.1.0` tag.
- **P5-09 — this documentation pass** (README, this file, the plan).
- **P5-10 — real-browser render checks.** `test/browser-render.test.ts` lays the
  real app out in a pinned Chromium at 320/360/390/430 px. Its first run found the
  bottom nav 459 px wide inside every phone viewport, so the sixth tab could not be
  reached; the notification tab now shows as "Alerts" (accessible name "Alerts,
  notifications, N unread", so WCAG Label-in-Name still holds) and the row shrinks
  with a scaled font instead of pushing a tab off the edge. `playwright` is a
  devDependency only, never part of the phone runtime. The **device** half (a real
  phone's fonts and font-size slider) is still open, as is the partner's iPhone
  (P0-10).

What is open is device-gated (P5-03's second client, P5-05's day-long run,
P5-10's phone leg, P0-10's partner checks, the fallback's boot path since
`P6-08`) or blocked on a host we do not have (P6-09's box, the clean-host restore
and `P6-10`'s 7-day run).

**Phase 6 moved the host off the phone, and `P6-08` finished the retirement.**
The household's daily server is the Oracle arm64 box behind Caddy on
`https://pupkeep.duckdns.org` (PLAN §2.1, §6; the operator's sequence is
`deploy/README.md`); the phone is a browser and an offline fallback that starts
`--access lan` on the household LAN. `ACCESS_MODES` is `local | lan | public`:
`tailscale` and `cloudflare` are refused as unknown modes, `src/launcher/tunnel.ts`
is deleted, the boot-time tailnet wait and the installer's `cloudflared` fetch are
gone, and the Termux:API notification transport is deleted — notifications are
in-app (authoritative) + Web Push + optional per-user ntfy. What P6-08 deliberately
left: `test/devcontainer.test.ts` and `.devcontainer/*` still pin `cloudflared`
for the dev container's own HTTPS testing, and `scripts/termux-sshd.sh` /
`scripts/termux-tunnel.sh` remain operator tooling that still needs Tailscale —
they no longer share a rule with the launcher, which has no tailnet code left.
The box has **not** been built, deployed or reached through Caddy; that is `P6-09`
and `P6-10`, and nothing here claims otherwise.

The agent can only *propose* an appointment or meal-schedule change; a
caregiver's confirmation route executes the stored action in one commit. The
**Agent** screen is now the shared thread: it renders the transcript, collapsed
tool cards, the **Waiting for your confirmation** proposal cards (Confirm /
Decline with the revision they read), the busy state both caregivers share, and
the model/monthly-spend card. `harness.usage()`
is the spend ledger: a paid model's message is refused at the monthly cap while a
free one still runs.
The partner-delivery claim is gated on P0-10 and is unproven. G1's host-side criteria are covered by
`test/e2e.test.ts` and `test/setup.test.ts`.
The devcontainer is `.devcontainer/` (Node 24, pi `1.5.0`,
sqlite3/cloudflared/rclone/tmux/gh, plus the host tools); `postCreate.sh` runs
`npm ci`, typecheck and the tests. Its `cloudflared` is the dev container's own
HTTPS-testing tool (`P6-08` left it there deliberately), never part of the phone
runtime. The image bakes `my-agent-setup` at the tag
in `.devcontainer/pi-agent-setup.version`, and `postCreate.sh` declares that
baked path in the container's personal settings — never in this repo's
`.pi/settings.json`.
Phase 0 is closed by the go/no-go in PLAN §2.3, except three device-gated checks
on the partner's iPhone — P0-03's access ones, P0-08's notification ones — which
are carried by **P0-10** and do not block Phase 2. App code goes under `src/`,
`web/`, `bin/` and `scripts/` exactly as PLAN §4 lays out.

No pi package is declared in this repo. The devcontainer gets it from the image
and records it in the container's own agent settings; declaring it here as well
would load every extension twice — the first attempt did exactly that and
subagents launched in this directory died with a duplicate-flag error at startup.

To bump the package: change `.devcontainer/pi-agent-setup.version`, change the
`ARG PI_AGENT_SETUP_TAG=` line in the Dockerfile, run
`sh .devcontainer/check-pi-agent-setup.sh`, then `devc rebuild pupkeep`. The
build and `postCreate` fail if the two disagree, and `postCreate` also fails if
the running image carries a different tag than the checkout pins.

## Shape

- **Host:** the Oracle arm64 box (Docker Compose: `pupkeep` + `caddy`) runs the
  household's server behind Caddy on `https://pupkeep.duckdns.org`. The phone is
  a browser client and an offline fallback (`--access lan` on the household LAN).
  No APK, no Android SDK, no pidabl, no embedded rootfs.
- **Access:** one configured public HTTPS origin (`public` mode); `local` for the
  devcontainer and drills; `lan` for the fallback. The old Tailscale daily path
  and Cloudflare quick tunnel were deleted with their modes (`P6-08`).
  Notifications: in-app (authoritative) + Web Push (daily) + optional per-user
  ntfy; the Termux:API transport is deleted.
- **Runtime:** Pi Durable `1.4.0` for conversations, tasks, tools, documents and
  SQLite storage. Pin exact versions.
- **Client:** no build step; plain ES modules + Preact/htm, served by the same
  Node server.
- **Agent:** one shared household conversation. The agent has app tools only —
  no shell, file, web or SQL tools. Low-risk writes are direct; destructive or
  schedule-changing writes require a human confirmation.
- **Durability:** every acknowledged **care action** is one Pi Durable commit.
  Auth/push config writes use serialized atomic JSON. One process owns one
  SQLite file: the launcher holds `launcher.pid` and the server takes
  `server.pid` itself at open, because a SIGKILLed launcher can leave its
  detached server alive. Run `harness.resume()` on every start.
- **Multiplayer:** one household, two caregivers, live state over SSE, and an
  explicit conflict instead of a silent overwrite.

## Safety

- Never put provider keys, owner tokens, owner links, invite codes or VAPID
  private keys in git or in `server.log`. The launcher writes the owner link to
  `~/.pupkeep/owner-link.txt` (0600) only when a token is minted or reissued;
  ordinary boots log only its path.
- The data directory is `~/.pupkeep` (mode 0700); secrets are mode 0600 and are
  excluded from off-device database backups. **VAPID private keys are the
  deliberate exception:** they live in `push.json` and ride inside the encrypted
  backup so push subscriptions survive a restore. The backup passphrase stays
  off the backup host; provider keys stay in `secrets.json` and are excluded.
- The agent must not receive shell, filesystem, browser or network tools.
- Do not add native modules to the phone runtime. `node:sqlite` only.
- Do not run SQLite on the Windows/9p workspace mount. Use `/tmp` or a volume in
  development, and the box's data directory in production (the phone's internal
  storage, if it runs the fallback).
- A backup archive carries its real name only **after** it has been decrypted and
  seq-checked: the job writes `<name>.partial` and renames. A killed run may leave
  a `.partial` and a `.staging-*` directory holding the **plaintext** bundle
  (including the VAPID private keys) until the next run sweeps it — which is one
  reason the box runs the job on a timer (`deploy/systemd/`, `P6-09`), and why
  that staging directory is 0700 inside a 0700 parent.
- Keep Pi Pocket, Pi Durable and other upstream notices in `NOTICE.md` and
  beside copied files.

## Branches and releases

`main` is the integration branch. Work on a short-lived feature branch and merge
back through a pull request (`gh pr merge <n> --squash --delete-branch`). There is
no `dev`: unlike the vendored skills' assumption, this repo merged to `main` from
its first release and the history says so.

A release is: set the version in `package.json`, turn `CHANGELOG.md`'s
`## Unreleased` into `## vX.Y.Z — <date>` with a fresh empty `## Unreleased`
above it, merge through a PR, let CI on `main` pass, then create an **annotated**
tag on that commit and a GitHub release whose notes are the changelog section
(`gh release create --notes-file`, never inline — inline markdown's backticks get
executed by the shell). Deploy the **tag** to the box (`docs/DEPLOY.md` and
`deploy/README.md`) and, if the household runs the fallback, to the phone, never
a branch. A tag goes on a commit whose typecheck, suite and devcontainer build
passed; `v0.1.0` did.

## Commands

```bash
npm ci
npm run typecheck      # tsc --noEmit; only erasable syntax, so node strips it
npm test               # node --test runs the TypeScript directly
npx playwright install --with-deps chromium
                       # once per container: the browser-render checks skip
                       # without it (CI and postCreate install it themselves)
npm start              # launcher -> server; add --access/--port/--data
npm run measure:growth -- --days 500   # P5-07's numbers, on a temp data dir
npm run backup -- ...  # encrypted SQLite + config + push archive (P1-07)
npm run restore -- ... # restore one archive; the server must be stopped
```

`npm start` starts the launcher and the server, which serves the API, the SSE
stream and the PWA shell. The client needs no build step: `web/vendor/` holds
pinned Preact/htm ES modules that `test/vendor.test.ts` verifies against
`NOTICE.md`. `scripts/termux-install.sh` and `scripts/termux-boot.sh` are the
phone's entry points; `docs/DEPLOY.md` is how a tag gets to the box and the
fallback.

The development pi agent (the one reading this file) has shell and file tools.
The **product** agent must never: it gets app tools only — no shell, filesystem,
browser, network or SQL. Adding a general-purpose tool to it is a security defect.

On the phone (the offline fallback):

```bash
git clone <repo> ~/pupkeep && cd ~/pupkeep
./scripts/termux-install.sh          # packages, npm ci, boot wrapper
~/pupkeep-start.sh --access lan --port 8791
```

The boot script starts `--access lan` and does not wait for a tailnet. Tailscale
on the phone is operator tooling only (`scripts/termux-sshd.sh`,
`scripts/termux-tunnel.sh`), not an access mode. Deploying a release is
`git checkout v0.1.0` + restart, not the installer (the installer upgrades the
whole device); `docs/DEPLOY.md` has the exact sequence, including why the
fallback port is 8791 and not 8787.

## When in doubt

Prefer the plan’s task IDs (`P0-01`, `P1-03`, …) in commit messages and PR
descriptions. If a change alters a decision in the plan, update the plan in the
same change.
