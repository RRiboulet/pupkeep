# Phone runbook — the host phone

**Status: draft (P1-13).** Written from PLAN §6.1–§6.7 and the Phase 0 evidence
that actually runs (P0-01, P0-03, P0-06, P0-07, P0-08), against the launcher and
server as they exist on `main`. It has **not** been walked end to end on a phone
in one sitting: the first full pass, plus the kill/restart matrix that changes
it, is **P5-01/P5-04**. Where a claim below rests on a measurement, the spike is
named; where it rests on upstream documentation, it says so.

Two related documents, on purpose: **P4-09** restates the Tailscale/ntfy/tunnel
instructions for the *users* (you and your partner), and **P5-04** polishes the
install and boot scripts. This file is the operator's copy.

---

## 0. What the phone is

The phone **is** the server. It runs Node, the Pupkeep server, the durable
harness and the agent. There is no Android app, no APK, no embedded Linux: the
browser on the same phone, and your partner's browser over Tailscale, are the
clients.

- One household, one puppy, two caregivers, one shared conversation.
- The data directory is `~/.pupkeep` (mode `0700`). It holds the SQLite file,
  `config.json`, `secrets.json`, `push.json`, `server.log` and the pinned
  `bin/cloudflared`.
- **The data outlives the process.** Android may kill Termux; the care log is
  on disk, and the service returns on the next start (PLAN §6.8).

## 1. Before you start

| What | Why |
|---|---|
| A phone you can keep on the charger | The host is a daily phone, charging 24/7 (PLAN §6.4) |
| **Termux from F-Droid** | The Play Store build is stale and unsupported |
| **Termux:Boot** (companion app) | `~/.termux/boot/` is run at reboot — the package alone does nothing there |
| **Termux:API** (companion app) | `termux-notification`/`termux-wake-lock` are proxies into it; the package alone does not post notifications |
| **Tailscale** (Android app) | The daily access path, and the private address the app binds |
| Your partner on the same tailnet | Daily partner access is `http://100.x.y.z:8787` (PLAN §6.6) |

Do **not** install the pi coding agent on the phone. It is a development tool;
the phone runs the server, the harness and the model client only.

## 2. Install

Get the repo onto the phone (`git clone` into `~/pupkeep`), then:

```bash
cd ~/pupkeep
./scripts/termux-install.sh
```

It is idempotent and it does five things, in this order:

1. `pkg install nodejs git curl termux-api sqlite rclone age expect tar termux-services tmux openssh`.
   **`cloudflared` is not in the Termux repository** (P0-03) — nothing installs it
   from `pkg`, and nothing should try.
2. Refuses a Node line other than the 24/26 the plan measured (P0-01).
3. Downloads Cloudflare's **arm64 `cloudflared` 2026.10.5** into
   `~/.pupkeep/bin/cloudflared`, verified against a pinned SHA-256.
4. `npm ci --omit=dev` — no build step, no native modules; `node:sqlite` only.
5. Installs `~/.termux/boot/pupkeep.sh`, a one-line hop into the tracked
   `scripts/termux-boot.sh`, so the repo stays the source of truth.

`pkg upgrade` on Termux occasionally moves Node across majors. If the server
refuses to start after an upgrade, check `node --version` first.

### Android settings that make the host survivable

These are UI settings; Android does not let Termux read them back (P0-06), so
they are a checklist, not something a script can verify.

- Termux → Battery → **Unrestricted**.
- Developer options → **Disable child process restrictions** (the Android 12+
  phantom-process killer kills Node children).
- Tailscale → Android **"Always-on VPN"**. Tailscale does **not** reconnect by
  itself after a reboot (P0-06): without this, the phone is off the tailnet until
  somebody opens the app.
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
├── bin/cloudflared         the pinned arm64 tunnel binary
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
npm start -- --access tailscale --data ~/.pupkeep
```

The launcher resolves the bind address, takes the lock, mints the owner token,
writes the link to `~/.pupkeep/owner-link.txt`, and starts the server plus the
harness. Then:

1. Open the owner link **on the host phone**. The link already points at the
   tailnet origin (`http://100.x.y.z:8787`), because that is what `tailscale`
   mode binds; `127.0.0.1:8787` only answers in `local` and `cloudflare` mode.
   The link signs the owner in and sets a session cookie — the token behind it
   stays valid until it is rotated, which is why it lives in a `0600` file and
   never in a log.
2. Complete **first-run setup** — it replaces Today until it is done. Three
   steps: confirm the household timezone, name the puppy, and set the meal
   times. A wrong zone corrupts every `localDate` from that point on, so check
   it against the clock on your phone. Both caregivers see the same checklist,
   and either can finish it; everything stays editable in **Settings**.
3. Settings → People → create a **one-time invite** for your partner.
4. Your partner joins the same tailnet, opens `http://100.x.y.z:8787`, and signs
   in with the invite. That URL is private to the tailnet: no DNS, no domain, no
   public exposure.

### Access modes

| Mode | Bind | Use it for |
|---|---|---|
| `local` | `127.0.0.1` | The host phone only. PWA/Web Push works on localhost. |
| `lan` | `0.0.0.0` | Explicit same-Wi-Fi opt-in; plain HTTP on the whole network, and the launcher says so |
| `tailscale` | the tailnet address | **Daily.** Private. HTTP, so no service worker and no Web Push |
| `cloudflare` | `127.0.0.1` + quick tunnel | **Testing only** — HTTPS, PWA install, Web Push |

Modes **fail closed**: if `tailscale` cannot find an address, the launcher
refuses to start and prints why. It never falls back to `0.0.0.0` (P0-03). Only
an explicit `--access lan` opens every interface.

### Losing the owner session

```bash
cd ~/pupkeep
npm start -- --reissue-owner --access tailscale
```

This rotates the owner token and prints a fresh link (and rewrites
`~/.pupkeep/owner-link.txt`). It needs physical access to Termux; that is the
point. Restarting the app **without** `--reissue-owner` will not print an
existing link — only the hash is stored.

## 5. Boot, wake lock, supervision

Termux:Boot runs every file in `~/.termux/boot/` at **reboot**. Ours is
`~/.termux/boot/pupkeep.sh`, installed by `scripts/termux-install.sh`, and it
execs `scripts/termux-boot.sh`, which:

- appends a boot line to `~/.pupkeep/server.log` (with the kernel `boot_id`, so a
  reboot is distinguishable from an app restart);
- takes the wake lock;
- starts operator `sshd` **if** Tailscale already has an address (§6);
- `exec`s the launcher: `npm start -- --access tailscale --boot --data ~/.pupkeep`,
  everything appended to `server.log`.

`--boot` is belt and braces: a non-TTY stdout never prints the owner token
anyway, and the boot path must never put the link in `server.log`.

**What survives what** (P0-06):

| Event | Result |
|---|---|
| Server child crashes | The launcher restarts it with capped backoff |
| Launcher crashes | Nothing restarts it — use the optional `sv` unit below |
| Termux app killed (`am force-stop`) | Data survives; nothing restarts until you reopen Termux. `sshd` does **not** come back by itself. |
| Phone reboot | Termux:Boot starts the launcher again. Tailscale needs "Always-on VPN" or a manual start. |
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

## 7. Daily access: Tailscale

1. Both phones are signed into the same tailnet.
2. `npm start -- --access tailscale --data ~/.pupkeep` (or the boot script).
3. The launcher binds the phone's tailnet address, e.g. `http://100.x.y.z:8787`.
4. Your partner bookmarks that URL. It is HTTP inside the tailnet.

**Limits, stated once:** Tailscale gives HTTP, not HTTPS. Without a secure
context there is **no service worker, no PWA install and no Web Push**. On iOS
"Add to Home Screen" over HTTP is a bookmark with its own cookie jar — a second
sign-in, no push. That is why notifications have their own path (§8) and why the
quick tunnel exists for testing only.

**No Serve/Funnel:** no such control was found in the Android app 1.104.2
(P0-03 — a feature-label scan, not an exhaustive test), so Tailscale cannot
provide the HTTPS origin here.

## 8. Notifications without a domain

Three paths, in order of authority (PLAN §6.6, §12.5):

1. **In-app notification centre — the source of truth.** Everything else is a
   best-effort mirror.
2. **Host phone: `termux-notification`** (Termux:API) for reminders due on the
   host. Category-only text, e.g. `Pupkeep` / `A meal is overdue`.
3. **Partner: ntfy** — recommended, not optional. The partner installs the ntfy
   app and subscribes to **their own** long-random topic (at least 128 bits of
   entropy — it is generated, never typed); the server publishes only what is
   meant for that caregiver.

Rules that do not bend (P0-08):

- **Category-only text**: "Someone logged a feed", "A meal is overdue", "An
  appointment reminder", "The agent needs your confirmation". Never the dog's
  name, the vet's name, an appointment title, a weight or a health remark —
  ntfy.sh is a third party and stores the message for 12 hours.
- **The topic name is the whole authentication.** Publishing to any topic is
  unauthenticated; a leaked topic is both a read and a write capability. It lives
  in `~/.pupkeep` at `0600`, and logs may record a prefix and length only.
- **The tap target is the private tailnet URL**, so the notification travels over
  a public relay while the app stays private.
- **Design for tap-through only.** ntfy `Actions` buttons are Android-only, so no
  flow may require a decision from the notification. Approvals stay in-app.
- An **invalid channel id is dropped with exit 0** on `termux-notification`; a
  zero exit means "the API was reachable", not "the user saw it". Verify with
  `termux-notification-list` (filter `packageName: "com.termux.api"`).

If your partner rejects ntfy: in-app only, or buy a domain and use Web Push over
HTTPS. Do not pretend Tailscale HTTP has Web Push (PLAN §6.10).

## 9. HTTPS, PWA and Web Push testing (quick tunnel)

**Testing only.** The daily path is §7. Start by stopping the daily launcher:
one server owns the SQLite file, so two instances is not an option.

```bash
# in the existing Termux session, Ctrl-C the launcher first
cd ~/pupkeep
npm start -- --access cloudflare --data ~/.pupkeep
```

The launcher binds `127.0.0.1` and supervises the tunnel **through the Termux
wrapper** — it never spawns the raw binary, because the raw binary has no
`/etc/resolv.conf` there and its TLS verification fails without Termux's CA
bundle (P0-03, PLAN §6.7). For reference, that is:

```bash
SSL_CERT_FILE=/etc/tls/cert.pem termux-chroot ~/.pupkeep/bin/cloudflared \
  tunnel --no-autoupdate --url http://127.0.0.1:8787
```

`termux-chroot` supplies `/etc/resolv.conf`; `SSL_CERT_FILE` resolves *inside*
the chroot to `$PREFIX/etc/tls/cert.pem`. Do not set the host path.

The URL is ephemeral, so the launcher prints it when cloudflared registers it:

```text
pupkeep: quick tunnel at https://<random>.trycloudflare.com
```

That line is not a secret and is safe in `server.log`; the owner link is not.

Then:

1. **Sign in on the tunnel origin as the owner.** The quick tunnel cannot mint its
   own owner link: the token is minted before the tunnel exists, so on a
   `cloudflare` start the launcher logs that the URL is not known yet and prints
   nothing. Read the link from `~/.pupkeep/owner-link.txt` and open it on the
   tunnel origin with the same path and token — `https://<random>.trycloudflare.com/login?token=…`
   — on the host phone, then create a **separate test invite** there.
2. On the **test device**, open the tunnel URL and sign in with that test invite.
   Never use the daily tailnet invite on a test origin: sessions are per-origin.
3. Install the PWA, allow notifications, subscribe to Web Push.
4. **The URL changes every time the tunnel restarts**, and a push subscription is
   bound to the origin — after a restart, open the new URL and re-subscribe. That
   is the whole reason a named tunnel (and a domain) is the upgrade path.

Do not put ntfy behind the quick tunnel: the URL changes on restart and the
partner's client would lose its server.

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
- Retention is 14 days and the newest archive is always kept; `--verify` decrypts
  the newest local archive and checks it.
- A restore **requires the server to be stopped** and refuses a live lock:

```bash
npm run restore -- --data ~/.pupkeep --archive ~/.pupkeep/backups/<name>.age
```

A restore is not a merge: against a data directory that still has a database,
config or `push.json`, it refuses unless you pass `--force`, and with `--force`
it first moves the existing files into `restore-backup-<timestamp>/`, so a
mistaken restore is itself recoverable. After a restore, re-enter provider keys
in Settings (they are not in the bundle). Keep the backup passphrase off the
phone-host's backup destination.

## 11. Upgrade

```bash
cd ~/pupkeep
git fetch --tags
git checkout <tag-or-commit-on-main>
npm ci --omit=dev
# stop the running launcher (Ctrl-C, or: sv down pupkeep), then:
npm start -- --access tailscale --data ~/.pupkeep
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
npm start -- --access tailscale --data ~/.pupkeep --retry-parked
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
| `refusing to start: Tailscale is not connected` | No tailnet address. Open the Tailscale app (or set Always-on VPN) and retry. The launcher will not fall back to `0.0.0.0`. |
| `another instance already owns ~/.pupkeep` | A launcher holds `~/.pupkeep/launcher.pid`. Stop that pid, or use the `sv` unit, then retry. |
| `a server already owns ~/.pupkeep (pid …)` | The launcher lock is free but `server.pid` is held: the previous launcher was SIGKILLed and its detached server is still alive. Stop that pid (it is printed) and start again. |
| The app is up but your partner cannot reach it | Check the tailnet address the launcher printed, that both devices are on the tailnet, and that Tailscale is connected on the host. |
| `owner link` lost | `npm start -- --reissue-owner --access tailscale` from physical Termux, then read `~/.pupkeep/owner-link.txt`. |
| `a task was parked before this process started` | A task crashed the process five times and the harness parked it; a restart does not clear it. Stop the launcher and start with `--retry-parked` for one attempt (§11). |
| `termux-sshd: Tailscale is not connected` | Tailscale is down, so there is no address to bind. Open the Tailscale app and run `scripts/termux-sshd.sh` again — it re-resolves and never listens on all interfaces. |
| Empty Today / wrong dates | The household timezone is wrong. First-run setup confirms it, and Settings shows the same three steps; fix the zone there and re-check the meal times. |
| Push stopped after a tunnel restart | Expected: the origin changed. Reopen the new URL and re-subscribe. |
| Notifications stopped arriving on the partner's phone | ntfy app backgrounded/killed, topic rotated, or the host is offline. The in-app centre is still authoritative. |
| Everything is slow / the phone is hot | Charging 24/7 plus the server. Use the phone's charge limit/bypass mode; keep it out of the sun (P5-05 measures this). |

## 13. Known limits and what is not yet verified

- **No domain.** Tailscale is HTTP; the quick tunnel is testing-only; ntfy is the
  partner's daily out-of-app signal.
- **The service is best-effort, the data is not.** Android may kill Termux and
  the app is offline until something restarts it. A VPS/Docker fallback exists
  and is the same server (PLAN §6.9).
- **Wake lock effect is unverified**: the command runs, but `dumpsys` is blocked
  to Termux, so battery/heat and the day-long survival are P5-05.
- **The partner device is an iPhone.** Web Push needs HTTPS + Add to Home Screen
  + iOS 16.4+; over Tailscale HTTP there is none. ntfy on iOS is documented as
  push-through-ntfy.sh, not measured here. Every iOS row in P0-08 is upstream
  documentation until **P0-10** observes it.
- **Not walked end to end from this file yet** — P5-01 (kill/restart matrix) and
  P5-04 (polish) are what turn this draft into a verified procedure.
