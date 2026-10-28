# Agent notes

## First

Read [`docs/PLAN.md`](docs/PLAN.md) and [`docs/TODO-GUIDE.md`](docs/TODO-GUIDE.md).
The plan is the source of truth for product and architecture; the guide explains
how to pick a task, branch, verify and report. Do not build app code beyond the
current approved phase.

## Shape

- **Host:** Android phone → Termux → Node 24 → Pupkeep server → browser/PWA.
  No APK, no Android SDK, no pidabl, no embedded rootfs.
- **Access:** Tailscale is the daily path (HTTP, no PWA/Web Push); a Cloudflare
  quick tunnel is for HTTPS/PWA/Web Push testing only; a named tunnel waits for
  a domain. Daily notifications: in-app, host Termux:API, and a recommended
  per-user ntfy topic for the partner.
- **Runtime:** Pi Durable `1.4.0` for conversations, tasks, tools, documents and
  SQLite storage. Pin exact versions.
- **Client:** no build step; plain ES modules + Preact/htm, served by the same
  Node server.
- **Agent:** one shared household conversation. The agent has app tools only —
  no shell, file, web or SQL tools. Low-risk writes are direct; destructive or
  schedule-changing writes require a human confirmation.
- **Durability:** every acknowledged **care action** is one Pi Durable commit.
  Auth/push config writes use serialized atomic JSON. One process owns one
  SQLite file. Run `harness.resume()` on every start.
- **Multiplayer:** one household, two caregivers, live state over SSE, and an
  explicit conflict instead of a silent overwrite.

## Safety

- Never put provider keys, owner tokens, owner links, invite codes or VAPID
  private keys in git or in `server.log`. The launcher writes the owner link to
  `~/.pupkeep/owner-link.txt` (0600) only when a token is minted or reissued;
  ordinary boots log only its path.
- The data directory is `~/.pupkeep` (mode 0700); secrets are mode 0600 and are
  excluded from off-device database backups.
- The agent must not receive shell, filesystem, browser or network tools.
- Do not add native modules to the phone runtime. `node:sqlite` only.
- Do not run SQLite on the Windows/9p workspace mount. Use `/tmp` or a volume in
  development, and the phone's internal storage in production.
- Keep Pi Pocket, Pi Durable and other upstream notices in `NOTICE.md` and
  beside copied files.

## Branches

`main` is the integration branch. Work on a short-lived feature branch and merge
back through a pull request. Tag releases; the phone deploys a tag or a commit
from `main`.

## Commands (planned)

```bash
npm ci
node --test
npm start -- --access local
```

On the phone:

```bash
pkg install nodejs git cloudflared termux-api
termux-wake-lock
npm start -- --access cloudflare --data ~/.pupkeep
```

## When in doubt

Prefer the plan’s task IDs (`P0-01`, `P1-03`, …) in commit messages and PR
descriptions. If a change alters a decision in the plan, update the plan in the
same change.
