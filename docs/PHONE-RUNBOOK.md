# Phone runbook — the offline fallback host

**Status: draft (P1-13), revised by `P6-08`.** Written from PLAN §6 and the
Phase 0 evidence that actually runs (P0-01, P0-03, P0-06, P0-07, P0-08), against
the launcher and server as they exist on `main`. It has **not** been walked end
to end on a phone in one sitting: the first full pass, plus the kill/restart
matrix that changes it, is **P5-01/P5-04**. Where a claim below rests on a
measurement, the spike is named; where it rests on upstream documentation, it
says so.

The phone is no longer the household's host: the Oracle box behind Caddy is
(PLAN §2.1, §6). This file is the operator's copy for the **fallback** — running
the same server on the household LAN when the box is unavailable — and for the
operator-only SSH tooling that exists on the phone.

Two related documents, on purpose: **P4-09** is the *caregivers'* copy (how to
reach the app and how notifications arrive,
[`access-and-notifications.md`](access-and-notifications.md)), and **P5-04**
polished the install and boot scripts.

---

## 0. What the phone is

The phone is the **offline fallback host, not the household's host.** The daily
server is the Oracle box behind Caddy on `https://pupkeep.duckdns.org` (PLAN §6,
`deploy/README.md`); this phone runs Termux, the same Node server, the durable
harness and the agent when that box is unavailable, and it is always a browser
client. There is no Android app, no APK, no embedded Linux.

- One household, one puppy, two caregivers, one shared conversation.
- The fallback serves the household LAN: it starts `--access lan`, plain HTTP,
  so both caregivers open the phone's LAN address from devices on the same
  Wi-Fi. It is offline by design — not a tailnet path and not a public origin.
- The data directory is `~/.pupkeep` (mode `0700`). It holds the SQLite file,
  `config.json`, `secrets.json`, `push.json`, `server.log`, the generated
  `sshd/` config and `backups/`.
- **The data outlives the process.** Android may kill Termux; the care log is
  on disk, and the service returns on the next start (PLAN §6.8).

## 1. Before you start

| What | Why |
|---|---|
| A phone you can keep on the charger | The fallback is a daily phone, charging while it serves (PLAN §6.4) |
| **Termux from F-Droid** | The Play Store build is stale and unsupported |
| **Termux:Boot** (companion app) | `~/.termux/boot/` is run at reboot — the package alone does nothing there |
| **Termux:API** (companion app) | `termux-wake-lock` is a proxy into it; the package alone does nothing. It no longer posts notifications (`P6-08` deleted that transport) |
| **Tailscale** (Android app) | **Operator only.** It is not an app access mode; `scripts/termux-sshd.sh` needs it to bind, and the boot script does not wait for it |
| Your partner on the same Wi-Fi | The fallback serves both caregivers on the household LAN; the household's daily path is the public origin (PLAN §6.6, `deploy/README.md`) |

Do **not** install the pi coding agent on the phone. It is a development tool;
the phone runs the server, the harness and the model client only.

## 2. Install

Get the repo onto the phone (`git clone` into `~/pupkeep`), then:

```bash
cd ~/pupkeep
./scripts/termux-install.sh
```

It is idempotent and it does five things, in this order:

1. `pkg update`, then `pkg upgrade -y` — non-interactively, and keeping local
   config files. The upgrade is not optional: on 2026-11-10 this phone's index had
   been moved by an earlier update, so a plain `pkg install nodejs` fetched 26.13.0
   without the matching `libicu` and `node` could not link at all (P5-01b
   finding 1). It takes a wake lock for this step, because Android killing Termux
   mid-upgrade leaves dpkg half-configured.
2. `pkg install nodejs git curl termux-api sqlite rclone age expect tar termux-services tmux openssh`.
   **`cloudflared` is not in the Termux repository** (P0-03) and the installer
   no longer fetches it (`P6-08` retired the mode that used it); nothing on the
   phone needs a tunnel binary.
3. Runs the `node` it just installed and prints the path, so a shim is visible. A
   binary that cannot link stops the script there, with the phone's own error and
   the three causes left after an upgrade (`dpkg --configure -a`, a held-back
   `nodejs`, a mirror that failed mid-run); a Node line outside the 24/26 the plan
   measured (P0-01) stops it too. Neither case writes anything else.
4. `npm ci --omit=dev` — no build step, no native modules; `node:sqlite` only.
5. Installs `~/.termux/boot/pupkeep.sh`, a one-line hop into the tracked
   `scripts/termux-boot.sh`, so the repo stays the source of truth.

**A re-run upgrades the whole system, Node included.** That is what makes it the
repair path (§12), and it is also its one cost: `pkg upgrade` occasionally moves
Node across majors (P0-01 measured `v26.12.1`, P5-01b `v26.13.0`). If the script
stops on "outside the 24/26", the upgrade has already happened and the app's
files are untouched — re-measure the phone's Node (P0-01) before deploying
rather than pinning it back on the spot. A link failure after a *later* upgrade
is the same trap one upgrade later.

### What the boot path does

Termux:Boot runs `~/.termux/boot/pupkeep.sh`, which hands over to
`scripts/termux-boot.sh`. That script writes the `boot:` line first (so a reboot
is always visible in `server.log`), takes a wake lock, attempts the operator
`sshd` once — logged, never fatal — and starts the launcher with `--access lan`.
It does **not** wait for a tailnet: `P6-08` deleted the 180 s wait and
`PUPKEEP_BOOT_TAILNET_WAIT` with the `tailscale` mode, because the fallback's
access no longer depends on Tailscale being connected. A phone with no VPN still
serves the household LAN at boot.

### Android settings that make the host survivable

These are UI settings; Android does not let Termux read them back (P0-06), so
they are a checklist, not something a script can verify.

- Termux → Battery → **Unrestricted**.
- Developer options → **Disable child process restrictions** (the Android 12+
  phantom-process killer kills Node children).
- Tailscale → Android **"Always-on VPN"** is **operator tooling only**: without
  it, SSH into a rebooted fallback phone waits for somebody to open the app. The
  app itself does not depend on the tailnet any more, so this is no longer a
  condition for the care app to boot.
- Keep Termux in recents; do not swipe it away.

## 3. Data directory and secrets

```text
~/.pupkeep/                 0700
├── pupkeep.sqlite (+ -wal, -shm)  the one SQLite file; one process owns it
├── config.json             household, members, invites (hashed)
├── models.json             the persisted startup model probe (prices, availability)
├── secrets.json            provider keys — 0600
├── push.json               VAPID keys + subscriptions — 0600
├── owner-link.txt          0600, written only when a token is minted or reissued
├── server.log              scrubbed: no owner link, invite code, cookie or key
├── sshd/                   generated sshd config, pid and current address
└── backups/                encrypted local archives
```

- **The owner link is the trust root.** It is written to
  `~/.pupkeep/owner-link.txt` and printed only by an interactive start. Losing it
  is recoverable locally (`--reissue-owner`, below); it is not recoverable from a
  log, because it is never logged.
- `secrets.json` is **excluded** from backups on purpose — provider keys are
  re-entered after a restore. `push.json` (VAPID) **is** included, so push
  subscriptions survive a restore.
- Never paste anything from `~/.pupkeep` into a chat, an issue, ntfy or a push
  body.

## 4. First run

```bash
cd ~/pupkeep
termux-wake-lock
npm start -- --access lan --data ~/.pupkeep
```

The launcher resolves the bind address, takes the lock, mints the owner token,
writes the link to `~/.pupkeep/owner-link.txt`, and starts the server plus the
harness. Then:

1. Open the owner link **on the phone itself**. The link names the phone's LAN
   address (`http://<lan-ip>:8787`), because that is what `lan` binds;
   `127.0.0.1:8787` only answers in `local` mode. The launcher logged the exact
   URL as `listening url=…` in `~/.pupkeep/server.log`. The link signs the owner
   in and sets a session cookie — the token behind it stays valid until it is
   rotated, which is why it lives in a `0600` file and never in a log.
2. Complete **first-run setup** — it replaces Today until it is done. Three
   steps: confirm the household timezone, name the puppy, and set the meal
   times. A wrong zone corrupts every `localDate` from that point on, so check
   it against the clock on your phone. Both caregivers see the same checklist,
   and either can finish it; everything stays editable in **Settings**.
3. Settings → People → create a **one-time invite** for your partner.
4. Your partner joins the same Wi-Fi, opens `http://<lan-ip>:8787`, and signs
   in with the invite. That URL is private to the household LAN: no DNS, no
   domain, no public exposure. It is the *fallback* path — the daily path is
   the box's public origin (PLAN §6.6).

### Access modes

| Mode | Bind | Use it for |
|---|---|---|
| `local` | `127.0.0.1` | The phone only, e.g. an interim check. PWA/Web Push works on localhost |
| `lan` | `0.0.0.0` | **The fallback's mode.** Both caregivers on the household LAN; plain HTTP on the whole network, and the launcher says so |
| `public` | every interface inside a container | The box, behind Caddy, with `PUPKEEP_PUBLIC_ORIGIN` set. Not a phone mode |

`tailscale` and `cloudflare` are **gone**, not disabled (`P6-08`): the launcher
refuses either as an unknown mode, and there is no compatibility alias. Modes
**fail closed**: an unknown mode is refused, `public` refuses to start without
an origin, and `lan` refuses to bind when any interface it would expose is
neither RFC1918 nor CGNAT — it never silently widens a public address. It never
falls back to `0.0.0.0` on your behalf.

### Losing the owner session

```bash
cd ~/pupkeep
npm start -- --reissue-owner --access lan
```

This rotates the owner token and prints a fresh link (and rewrites
`~/.pupkeep/owner-link.txt`). It needs physical access to Termux; that is the
point. Restarting the app **without** `--reissue-owner` will not print an
existing link — only the hash is stored.

### A partner who loses their session

v1 has no remove-member or re-invite screen, and there is no member recovery
route: a partner whose cookie is gone (a cleared browser, a replaced phone) would
be stuck at the sign-in screen. The operator's way out is a **hand edit while the
server is stopped** — one writer, and `config.json` is the auth authority:

```bash
# 1. stop the launcher (Ctrl-C, or: sv down pupkeep), then prove the server is
#    gone: a SIGKILLed launcher leaves its detached server alive, and editing
#    config.json under a live writer loses the edit.
pgrep -af 'bin/server.js' || echo "no server process"
# 2. back up the auth authority, then edit it
cd ~/.pupkeep
cp config.json config.json.bak          # 0600; keep it until the partner is back
# 3. in config.json: set "removedAt" on that member and empty their "sessions"
#    (the member id is under members[].id; a JSON editor or jq)
# 4. start again, then Settings → People → create a one-time invite
cd ~/pupkeep
npm start -- --access lan --data ~/.pupkeep
```

Setting `"removedAt"` is what ends the session: `authenticate` skips a removed
member and every session row attached to one. On the next boot the household
document drops their profile (the boot line reports `profilesRemoved=<n>`), and
the household slot is free for the new invite. `test/security.test.ts` proves the
edit itself: the lost token stops authenticating and the owner can invite a
replacement.

Their push subscription and ntfy topic stay in `push.json`, keyed by the old member
id. Nothing plans a **new** notification for a member the config no longer lists,
but an intent already committed for them before the edit — a `feed_overdue` owed
the night before, say — can still be delivered on the next outbox drain. The app's
own removal purges push first for exactly that reason. If that matters, let the
outbox drain before editing, or delete their rows from `push.json` while the
server is stopped and the file is backed up. The backlogged `--reset-member` CLI
will do both in one step.

## 5. Boot, wake lock, supervision

Termux:Boot runs every file in `~/.termux/boot/` at **reboot**. Ours is
`~/.termux/boot/pupkeep.sh`, installed by `scripts/termux-install.sh`, and it
execs `scripts/termux-boot.sh`, which:

- appends a boot line to `~/.pupkeep/server.log` (with the kernel `boot_id`, so a
  reboot is distinguishable from an app restart);
- takes the wake lock;
- attempts operator `sshd` **once** — it needs Tailscale, a failure is logged and
  never fatal, and nothing waits for the tailnet (§6);
- `exec`s the launcher: `node bin/pupkeep.js --access lan --boot --data ~/.pupkeep`,
  everything appended to `server.log`.

`--boot` is belt and braces: a non-TTY stdout never prints the owner token
anyway, and the boot path must never put the link in `server.log`.

The wrapper Termux:Boot runs passes the interpreter explicitly
(`exec "$PREFIX/bin/bash" "<repo>/scripts/termux-boot.sh"`) and the script sets
`PATH`, `PREFIX` and `HOME` itself, because Termux:Boot starts it with none of
them. Until P5-01b that was not true, and the result was a reboot with no boot
line and no app — see [`kill-restart-matrix.md`](kill-restart-matrix.md) cell 4.

**What survives what** (P0-06; re-measured on the real install in
[`kill-restart-matrix.md`](kill-restart-matrix.md)):

| Event | Result |
|---|---|
| Server child crashes | The launcher restarts it with capped backoff |
| Launcher crashes | Nothing restarts it — use the optional `sv` unit below |
| Termux app killed (Android **Settings → Apps → Termux → Force stop**) | Data survives; nothing restarts until you reopen Termux. `sshd` does **not** come back by itself. `am force-stop com.termux` from inside Termux is **denied** (`FORCE_STOP_PACKAGES`) and exits 0 anyway, so the UI is the only reliable way — see [`kill-restart-matrix.md`](kill-restart-matrix.md) Finding 7. |
| Phone reboot | Termux:Boot starts the launcher again on `--access lan`; the LAN app needs no VPN. Tailscale, for operator SSH, still needs "Always-on VPN" or a manual start. |
| Backoff gives up | The launcher exits non-zero, which is what lets `sv`/`runit` restart it |

### Optional: `termux-services`/`sv` for crash restart

Boot alone cannot restart a launcher that died. If you want that:

```bash
mkdir -p "$PREFIX/var/service/pupkeep"
cat >"$PREFIX/var/service/pupkeep/run" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
exec "$HOME/pupkeep/scripts/termux-boot.sh"
EOF
chmod 755 "$PREFIX/var/service/pupkeep/run"
export SVDIR="$PREFIX/var/service"
service-daemon start   # or: termux-services' runsvdir on boot
sv up pupkeep
```

Pick **one** supervisor. Do not also let Termux:Boot start the launcher directly:
two launchers on one data directory is exactly what the pid lock exists to
refuse. The `run` file must `exec` (it does above), because a run script that
returns instead of exec'ing makes runsv treat the exit as a service failure and
restart it in a loop — and because `exec` is what makes runsv's pid the launcher
itself, so `sv down` lands SIGTERM on the process that owns `launcher.pid`. That
is also why the boot script execs `node bin/pupkeep.js` rather than `npm start`:
npm and its `sh -c` in the middle would absorb the signal.

Watch it:

```bash
tail -n 50 ~/.pupkeep/server.log
sv status pupkeep
```

`server.log` is scrubbed by construction (P1-05/P1-12 tests): owner links, invite
codes, cookies and provider keys do not appear in it. Do not add `echo`es that
change that.

## 6. Operator SSH: on demand, tailnet only

SSH is **not** a product path and **not** how your partner reaches the app. It
exists so an operator can get a shell after a Termux kill, when Termux:Boot does
not re-run.

This is the one part of the phone that still needs Tailscale, and it is
**operator tooling**: the app's access modes no longer know what a tailnet is
(`P6-08` deleted the launcher's tailnet code), so the script's range check is its
own rule rather than a copy of the launcher's. `test/runbook.test.ts` pins it in
isolation for that reason.

```bash
~/pupkeep/scripts/termux-sshd.sh
```

What it does, and why it is a script rather than a static config (P0-06):

- **Re-resolves the tailnet address on every start.** A pinned `ListenAddress`
  silently stops working when the address changes, and sshd that starts before
  Tailscale has an address fails to bind and then looks "up". The phone was found
  in exactly that state during Phase 0.
- Writes `~/.pupkeep/sshd/sshd_config` with exactly two `ListenAddress` lines —
  the current tailnet address and `127.0.0.1`. **Never `0.0.0.0`**: SSH on the
  Wi-Fi network is not part of this design.
- **Refuses to start (exit 2) when Tailscale is not connected**, instead of
  falling back to a wildcard bind. Open the Tailscale app, then run it again.
- Is idempotent: a running instance is reused while the address and port are
  current, and restarted when either moved.
- Port `8022` (Termux's default sshd port; override with `PUPKEEP_SSH_PORT`).
  Password authentication is off: put the operator key in
  `~/.ssh/authorized_keys` (mode `0600`, directory `0700`).

From another tailnet device:

```bash
ssh -p 8022 <user>@100.x.y.z
```

If you inherited a phone from the Phase 0 spikes, there may be a leftover
`$PREFIX/etc/ssh/sshd_config.p0-review.bak` that binds every interface. It must
not be reinstated; delete it once this on-demand start is what you use.

### The supervised tunnel (optional, for a workstation that cannot reach the tailnet)

A devcontainer or a VPS that is not on the tailnet cannot open `ssh -p 8022
<user>@100.x.y.z`. The phone can carry the tunnel itself, supervised, so a dead
session cannot strand the port and a `pkill` of the app does not lock the
operator out:

```bash
# once, on the phone, with the VPS as a ~/.ssh/config alias (`oracle` here):
~/pupkeep/scripts/termux-install.sh --with-tunnel oracle
```

That writes `$PREFIX/var/service/pupkeep-tunnel/run`, which `termux-services`'
`runsvdir` starts and restarts, running:

```bash
~/pupkeep/scripts/termux-tunnel.sh oracle
```

The script checks two things **before** it binds, because both failures are
silent and both cost an hour on 2026-11-10:

- **Your `~/.ssh/config` must not already forward the remote port.** A
  `RemoteForward 0.0.0.0:8022 …` in the same Host block wins the bind, and then
  that interactive session *is* the tunnel — with whatever target it was written
  with. Delete that line; the supervised unit owns the port now.
- **…and the alias must not carry `LocalForward` lines either.** ssh applies them
  to every connection through the alias, and the tunnel sets `ExitOnForwardFailure`
  (because a stranded remote port has to be loud), so one busy local port on the
  phone kills the tunnel before it binds. `LocalForward 8787` is the one that
  bites here: the app owns 8787 on the phone. Give the tunnel its own Host block
  with `HostName`, `User` and `IdentityFile` and nothing else, and run
  `scripts/termux-tunnel.sh <that-alias>`.
- **sshd must be listening.** A reverse tunnel to a loopback sshd that is down
  accepts every connection and resets it, which reads as a network fault and is
  not one (`kex_exchange_identification: read: Connection reset by peer`).

Then, from the VPS (or anywhere that can reach it):

```bash
ssh -p 8022 <phone-user>@<vps-address>
```

`sv status pupkeep-tunnel` shows it; `sv down pupkeep-tunnel` stops it. The unit
restarts the tunnel with a 10 s backoff (`PUPKEEP_TUNNEL_BACKOFF`) and the
session carries keepalives, so an Android doze or a flaky link recovers by
itself instead of leaving a half-dead forward.

## 7. Daily access on the fallback: the household LAN

The household's daily path is the box's public origin (PLAN §6.6,
`deploy/README.md`). When the fallback is what is running:

1. `npm start -- --access lan --data ~/.pupkeep` (or the boot script).
2. The launcher binds every interface and prints the address, e.g.
   `http://192.168.x.y:8787`.
3. Both caregivers, on the same Wi-Fi, open that URL. Your partner bookmarks it.

**Limits, stated once:** the fallback is HTTP, not HTTPS. Without a secure
context there is **no service worker, no PWA install and no Web Push**. On iOS
"Add to Home Screen" over HTTP is a bookmark with its own cookie jar — a second
sign-in, no push. The fallback's notification record is the in-app centre (§8),
and Web Push is a property of the box's public origin, not of this host.

**No tailnet path:** the old `--access tailscale` daily mode was deleted
(`P6-08`), together with the boot-time wait for the tailnet. Tailscale on this
phone is for the operator's SSH (§6) and nothing else.

## 8. Notifications when the fallback is the host

Two paths, in order of authority (PLAN §6.4, §12.5):

1. **In-app notification centre — the source of truth.** Everything else is a
   best-effort mirror.
2. **ntfy** — optional and per-user. The partner installs the ntfy app and
   subscribes to **their own** long-random topic (at least 128 bits of entropy —
   it is generated, never typed); the server publishes only what is meant for
   that caregiver.

**There is no host-local Android notification any more.** `P6-08` deleted the
`termux-notification` transport with the phone host, so Termux:API's remaining
job on this phone is `termux-wake-lock` (§2). Web Push is not available on the
fallback either: it needs the HTTPS origin, which is the box's (PLAN §6.6), not
the LAN's.

Rules that do not bend (P0-08):

- **Category-only text**: "Someone logged a feed", "A meal is overdue", "An
  appointment reminder", "The agent needs your confirmation". Never the dog's
  name, the vet's name, an appointment title, a weight or a health remark —
  ntfy.sh is a third party and stores the message for 12 hours.
- **The topic name is the whole authentication.** Publishing to any topic is
  unauthenticated; a leaked topic is both a read and a write capability. It lives
  in `~/.pupkeep` at `0600`, and logs may record a prefix and length only.
- **Design for tap-through only.** ntfy `Actions` buttons are Android-only, so no
  flow may require a decision from the notification. Approvals stay in-app.

If your partner rejects ntfy: in-app only on the fallback, or use the box's
public origin where Web Push is the daily channel (PLAN §6.6).

## 9. The quick tunnel is gone

There is no `--access cloudflare` any more (`P6-08`): the mode, the launcher's
tunnel supervision, the URL wait and the installer's `cloudflared` fetch were all
deleted. A start with it exits as "unknown access mode":

```text
refusing to start: unknown access mode: cloudflare
```

Nothing on this phone replaces it. HTTPS, PWA install and Web Push belong to the
box's public origin (`deploy/README.md`); on the fallback they are simply absent,
and the in-app centre is the record (§8). The devcontainer keeps its own pinned
`cloudflared` for its own HTTPS testing — that binary is not part of the phone.

The old quick-tunnel procedure is in the Phase 5 record,
[`kill-restart-matrix.md`](kill-restart-matrix.md) cell 5, as history rather
than instructions.

## 10. Backup

Encrypted, local, and optionally off-device (PLAN §7.5):

```bash
cd ~/pupkeep
npm run backup -- --data ~/.pupkeep \
  --passphrase-file ~/keys/pupkeep-backup.pass \
  --remote <rclone-remote>:pupkeep --require-remote
```

- The passphrase is read from an environment variable
  (`PUPKEEP_BACKUP_PASSPHRASE`) or from a file **outside** the data and backup
  directories — `~/keys/` above, not `~/.pupkeep/`. It is never written to the
  archive, the log or a command line (the age prompt is answered over a PTY).
- There is deliberately no default source for it: an unattended nightly run needs
  a vault read or an operator, never a key filed beside the archive.
- The bundle is SQLite + `config.json` + `push.json`; `secrets.json` is excluded.
- **The rclone target must verify the host key.** rclone's sftp backend does no
  host-key validation unless you tell it to, and prints
  `NOTICE: No host key validation is being performed` while connecting:

  ```bash
  rclone config update <remote> known_hosts_file "$HOME/.ssh/known_hosts"
  ```

  A stolen archive is still encrypted, so this is about integrity rather than
  confidentiality - but a silent substitution fails a restore at the worst moment
  (P5-02's drill).
- Retention is 14 days and the newest archive is always kept; `--verify` decrypts
  the newest local archive and checks it. An archive only carries its real name
  once it has been decrypted and verified - a killed run leaves
  `<name>.partial` and a `.staging-*` directory behind, never something `--verify`
  or a restore would pick up. The staging directory holds the plaintext bundle
  (including the VAPID keys) until the **next** run sweeps it, which is one more
  reason the box runs this on a timer (`P6-09`); the phone has no schedule.
- A restore **requires the server to be stopped** and refuses a live lock:

```bash
npm run restore -- --data ~/.pupkeep --archive ~/.pupkeep/backups/<name>.age
```

A restore is not a merge: against a data directory that still has a database,
config or `push.json`, it refuses unless you pass `--force`, and with `--force`
it first moves the existing files into `restore-backup-<timestamp>-<pid>/`, so a
mistaken restore is itself recoverable; if the run fails after that move, the
error names the directory. After a restore, re-enter provider keys
in Settings (they are not in the bundle). Keep the backup passphrase off the
phone-host's backup destination.

## 11. Upgrade

```bash
cd ~/pupkeep
git fetch --tags
git checkout <tag-or-commit-on-main>
npm ci --omit=dev
# stop the running launcher (Ctrl-C, or: sv down pupkeep), then:
npm start -- --access lan --data ~/.pupkeep
```

The phone deploys a tag or a commit from `main`; `main` is the integration
branch. Before upgrading: take a backup (§10). After: check
`~/.pupkeep/server.log` for a clean start and `harness.resume()` reporting the
pending work. The JSON files (`config.json`, `secrets.json`, `push.json`,
`models.json`) carry a `schemaVersion`; the server migrates what it knows and
refuses a version it does not, rather than resetting. The session documents'
own migration is Pi Durable's, and a document that fails to load is a startup
failure, not a fresh household.

### A task that is parked (`restartLimit`)

A task that crashes the server process is retried by the supervisor, and once it
has been cut off five times Pi Durable **parks** it: it stays blocked, and a
restart does not unblock it. `server.log` says so, once per boot:

```
a task was parked before this process started; retryTask() runs it again  taskId=… kind=app.reminder
```

The operator's way out is one explicit attempt, in the process that owns the
database (never a second process: one writer, §3.2):

```bash
# stop the launcher first, then:
npm start -- --access lan --data ~/.pupkeep --retry-parked
```

It retries every parked task once and logs each one. The flag applies to the
**first** spawn only: if the task crashes the process again, the supervisor's
restart does not retry it, because a task parked for crashing is exactly the
crash loop the limit exists to stop. If it parks again, read the log lines
before the park — it is a deterministic failure, not a transient one — and fix
that rather than retrying in a loop.

## 12. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `refusing to start: unknown access mode: tailscale` (or `cloudflare`) | The mode was deleted (`P6-08`). The fallback starts `--access lan`; the only HTTPS path is the box's public origin. A boot script from an older checkout still passes `tailscale` — re-run `scripts/termux-install.sh` to regenerate the wrapper. |
| `refusing to start: lan would expose …` | The address the launcher would bind is not RFC1918/CGNAT (a public host, or a VPN interface). It fails closed instead of widening; check `ifconfig`, or run the fallback on the household LAN. |
| `another instance already owns ~/.pupkeep` | A launcher holds `~/.pupkeep/launcher.pid`. Stop that pid, or use the `sv` unit, then retry. |
| `could not bind the HTTP listener … EADDRINUSE` on 8787 | Something else on the phone owns the port. The common cause here is the operator's own `ssh` config: `LocalForward 8787 127.0.0.1:8787` binds it while that session is open. Close the session or start with `--port <n>`. |
| `a server already owns ~/.pupkeep (pid …)` | The launcher lock is free but `server.pid` is held: the previous launcher was SIGKILLed and its detached server is still alive. Stop that pid (it is printed) and start again. |
| The app is up but your partner cannot reach it | Check the LAN address the launcher printed (`listening url=…`), that both devices are on the same Wi-Fi, and that the phone's Wi-Fi is not a guest network that blocks peer traffic. A tailnet address no longer works: `--access tailscale` is deleted. |
| `healthz` fails on the LAN address while `pgrep -a node` shows the launcher and server running | The app binds its address **at start** and nothing rebinds it when Wi-Fi hands it a new one. Check the address (`ifconfig | grep -A2 '^wlan'`) and restart the launcher. Interim access on the phone itself: `~/pupkeep-start.sh --access local --port 8791`. |
| `owner link` lost | `npm start -- --reissue-owner --access lan` from physical Termux, then read `~/.pupkeep/owner-link.txt`. |
| `a task was parked before this process started` | A task crashed the process five times and the harness parked it; a restart does not clear it. Stop the launcher and start with `--retry-parked` for one attempt (§11). |
| `termux-install: pkg update failed: …` (exit **4**) | No network, a `dpkg` lock held by another Termux session, or a broken `curl` (the mirror probe needs it before `pkg` can install one). Stop the other session, or `pkg install curl`, then re-run. |
| `termux-install: pkg upgrade failed: …` (exit **4**) | Raw apt output stays for the same three causes plus a full disk. If an earlier run was interrupted, `dpkg --configure -a` first; if the mirror is the problem, `termux-change-repo`. Nothing below the upgrade ran, so the app's files are untouched. |
| `termux-install: /data/data/…/bin/node is installed but does not run:` | The package is installed and the binary cannot link (P5-01b finding 1: `CANNOT LINK EXECUTABLE … libicui18n.so.79 not found`). The index was already upgraded by that run, so try `dpkg --configure -a`, then `pkg install --reinstall nodejs`, then `termux-change-repo`. Nothing below the check ran. |
| `termux-install: Node v27… is outside the 24/26` | The upgrade moved Node past what the plan measured (P0-01/P5-01b disagree by a patch already). The upgrade has happened and the app's files were not touched: measure the new line before deploying (§2), or pin `nodejs` back. |
| `termux-tunnel: ~/.ssh/config forwards local ports for …` (exit **3**) | The alias has `LocalForward` lines, which ssh applies to the tunnel's own connection; with `ExitOnForwardFailure` set, a busy phone port (8787 is the app) kills it before it binds. Give the tunnel a Host block with no forwards (§6). |
| `bind [127.0.0.1]:8787: Address already in use` / `Could not request local forwarding` | The same lines seen from ssh's side rather than the preflight's. The phone's 8787 is the app, so that forward can never work from this phone — delete it from the Host block. |
| `termux-sshd: Tailscale is not connected` | Tailscale is down, so there is no address to bind. Open the Tailscale app and run `scripts/termux-sshd.sh` again — it re-resolves and never listens on all interfaces. |
| `kex_exchange_identification: read: Connection reset by peer` | Something accepted on the remote port and then failed to reach the phone. Two causes, both cheap: sshd is not listening (`pgrep -a sshd`; run `scripts/termux-sshd.sh`), or the `RemoteForward` target is `localhost` (= `::1`) while sshd listens on `127.0.0.1`. Use the supervised tunnel (§6). |
| `Warning: remote port forwarding failed for listen port 8022` | Another session already owns that remote port — usually an earlier tunnel whose phone side died, or your own `~/.ssh/config`. On the VPS: `sudo ss -ltnp | grep ':8022'` and kill that pid; on the phone, delete the `RemoteForward` line and use the supervised unit. |
| After a reboot the app is not running and `server.log` has no `boot:` line | Termux:Boot did not get through. Check that the Termux:Boot app has been opened once, then run `~/.termux/boot/pupkeep.sh` by hand: it must append the boot line. If it prints `bad interpreter`, the wrapper is older than P5-01b — re-run `scripts/termux-install.sh`. |
| After a reboot `server.log` **has** a `boot:` line, then `refusing to start: unknown access mode: tailscale` | The boot wrapper is from a checkout older than `P6-08`, before the mode was deleted and the boot script moved to `--access lan`. Re-run `scripts/termux-install.sh` to regenerate the wrapper, then reboot or run `~/.termux/boot/pupkeep.sh` by hand. |
| Empty Today / wrong dates | The household timezone is wrong. First-run setup confirms it, and Settings shows the same three steps; fix the zone there and re-check the meal times. |
| Push does not work on the fallback | Expected: the LAN origin is plain HTTP, not a secure context. Web Push is a property of the box's public origin (PLAN §6.6); on the fallback the in-app centre is authoritative. |
| Notifications stopped arriving on the partner's phone | ntfy app backgrounded/killed, topic rotated, or the host is offline. The in-app centre is still authoritative. |
| Everything is slow / the phone is hot | Charging 24/7 plus the server. Use the phone's charge limit/bypass mode; keep it out of the sun (P5-05 measures this). |

## 13. Known limits and what is not yet verified

- **No public origin from this host.** The fallback is HTTP on the LAN: no PWA
  install, no service worker, no Web Push, and no host-local Android
  notification (`P6-08` deleted the transport). The household's daily path is
  the box's public origin, whose own legs are `P6-09`'s and are not proven here.
- **The service is best-effort, the data is not.** Android may kill Termux and
  the app is offline until something restarts it. The box can be started again
  without the phone at all (PLAN §6.8).
- **Wake lock effect is unverified**: the command runs, but `dumpsys` is blocked
  to Termux, so battery/heat and the day-long survival are P5-05.
- **The partner device is an iPhone.** Web Push on the public origin needs
  HTTPS + Add to Home Screen + iOS 16.4+; over the fallback's HTTP there is none.
  ntfy on iOS is documented as push-through-ntfy.sh, not measured here. Every iOS
  row in P0-08 is upstream documentation until **P0-10** observes it.
- **Not walked on a phone since `P6-08`.** The install and boot scripts, the
  `--access lan` boot line and the rewritten sections above are host-side changes
  guarded by `test/runbook.test.ts`; no phone run exercised them. The kill/restart
  matrix keeps its own record:
  [`kill-restart-matrix.md`](kill-restart-matrix.md) (P5-01b), first walked on the
  daily phone on 2026-11-10.
