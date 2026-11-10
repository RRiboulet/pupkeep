# Kill/restart matrix — the host phone (P5-01b)

**Status: first pass walked 2026-11-10 on the daily phone.** Two cells passed, one
failed with two defects recorded, two are still to run (they need the owner's
hands), and the agent-mid-turn cell could not be observed on this host. Every row
below says what was seen, when, and on which device — nothing is inferred from a
devcontainer run.

**Owner of the device:** the household owner. **Owner of the host-side claims:**
[`../test/kill-matrix.test.ts`](../test/kill-matrix.test.ts) (P5-01a).

Companions: [`PHONE-RUNBOOK.md`](PHONE-RUNBOOK.md) §5 (what survives what, from
P0-06), §11 (a parked task and `--retry-parked`), §12 (troubleshooting);
[`../docs/spikes/P0-06-termux-resilience.md`](spikes/P0-06-termux-resilience.md)
for the Phase 0 measurements this repeats on the real install.

## What this proves, and what it does not

| Proves | Does not prove |
|---|---|
| A committed care action, the open walk, the armed reminder tasks and a live session survive a hard `SIGKILL` of the server process on the phone | Anything about a *power loss* — the filesystem and the hardware are out of scope (PLAN §7.4's caveat) |
| The launcher restarts the server with capped backoff and `harness.resume()` runs on every start | That Android will not kill Termux again tomorrow; that is P5-05's day-long evidence |
| A killed launcher leaves its detached server serving, and a second launcher refuses to become a second writer | That the optional `sv` unit restarts the launcher — not installed on this host |
| The quick tunnel is *not* usable from the launcher on this phone today | Why, exactly: the DNS failure is observed, not root-caused |
| — | Web Push, PWA install, the partner's iPhone: those are P0-10/P4-09 |

## The host under test

| | |
|---|---|
| Device | Samsung `SM-G998B`, Android kernel `5.4.242-30958140-abG998BXXSJHZC2`, `aarch64` |
| `boot_id` | `cf7373f5-7f12-43d4-af54-8c607a2b3fee` (unchanged across every app restart below) |
| Termux user | `u0_a178` |
| Runtime | Node `v26.13.0`, npm `12.2.2`, SQLite `3.54.1`, OpenSSH `10.6p2` |
| Checkout | `~/pupkeep` at `e40f3c1` (`main`) |
| Data directory | `~/.pupkeep` (0700), port **8791** for the matrix — the boot path uses the default 8787 |
| Install | `scripts/termux-install.sh` run on 2026-11-10 12:03 +01:00, then `~/pupkeep-start.sh` |

**Why 8791, not 8787.** The operator's own `~/.ssh/config` on this phone carries
`Host oracle … LocalForward 8787 127.0.0.1:8787`, so an open `ssh oracle` session
*binds 127.0.0.1:8787 on the phone* and forwards it to the VPS. The launcher's
default port therefore fails with `EADDRINUSE` while the operator is connected —
observed 2026-11-10 12:04, ten restart attempts, then the supervisor gave up. See
Finding 3.

## How to read a row

- Times are the phone's local time (`+01:00`); the log's own lines are UTC.
- A **reboot** is distinguishable from an **app restart** by `boot_id`: the boot
  script appends `boot: <date -Is> (boot_id …)` to `~/.pupkeep/server.log`, and a
  changed `boot_id` is a real reboot.
- "State" means the four things the plan says must survive: committed care
  actions, the open walk, the armed reminder tasks, and a signed-in session.
  It is read with a throwaway driver on the phone (`~/p5-01b/state.mjs`) that
  signs in with `~/.pupkeep/owner-link.txt` — the link and the cookie never leave
  the device.
- The reminder tasks are read straight out of SQLite (`pi_tasks`), because there
  is no operator route for them:

  ```bash
  sqlite3 ~/.pupkeep/pupkeep.sqlite \
    "select id, kind, status from pi_tasks order by id;"
  ```

## The matrix

| # | Cell | Verdict | Observed |
|---|---|---|---|
| 1 | **Server child** killed (`SIGKILL`) | **pass** | 2026-11-10 12:09:35 |
| 2 | **Launcher** killed (`SIGKILL`) | **pass**, with the documented consequence | 2026-11-10 12:09:56 |
| 3 | **Termux app** killed (every process of the UID) | **pass** | 2026-11-10 13:53 |
| 4 | **Phone reboot** | **fail as shipped** — the data and the session survive, the boot path does not start the app | 2026-11-10 ~15:0x reboot, `boot_id` `3e85e392-…` |
| 5 | **Tunnel restart** | **fail** — two defects | 2026-11-10 12:10–12:14 |
| 6 | **Agent mid-turn** | **not observed** — no provider key on this host | — |

---

### 1. Server child killed — pass

The launcher supervises the server; `SIGKILL` is what Android does to a child it
reclaims, and it is the only kill that skips every shutdown path.

```bash
kill -9 "$(cut -d' ' -f1 ~/.pupkeep/server.pid)"
```

| | |
|---|---|
| Killed | server pid `22184` at 12:09:35 |
| Launcher logged | `server exited (code null, signal SIGKILL); restart 1 in 1000 ms` |
| New server | pid `23033` at 12:09:37 — **2.7 s** after the kill |
| Start logged | `session bootstrap created=false members=1 …`, `feed planner reconciliation createdPlanner=false armedReminders=0`, `listening url=http://127.0.0.1:8791` |
| State after | identical: setup complete, `profileRev 1`, open walk `6eb50678-…`, appointment `e84c230a-…`, `healthz 200` |
| Reminder tasks | ids `27` `app.feed.planner`, `28` `app.feed.reminder`, `29` `app.reminder` — all still `sleeping` |
| Session | the same cookie kept working; no re-login |
| `boot_id` | unchanged (an app restart, not a reboot) |

`harness.resume()` ran on the restart (`feed planner reconciliation` and the
`sleeping` planner row are its evidence) and nothing committed was lost.

### 2. Launcher killed — pass, with the consequence P0-06 predicted

```bash
kill -9 "$(cut -d' ' -f1 ~/.pupkeep/launcher.pid)"
```

| | |
|---|---|
| Killed | launcher pid `22171` at 12:09:56 |
| Server | pid `23033` **still alive**, `healthz 200` — the detached child keeps serving |
| Second launcher | `refusing to start: a server already owns ~/.pupkeep (pid 23033); one process per SQLite file — stop it before starting another launcher` |
| Second launcher, with the lock free | exit **3**, `refusing to start: another instance already owns … (pid 23299)` |
| Recovery | manual: `kill -TERM` the orphan server (it closes cleanly and removes both pid files), then start the launcher again |

Nothing restarts a killed launcher on this host — the optional `sv` unit is not
installed (P0-06 measured that it works; P5-04 decides whether to install it).
The pid lock is what stops the operator's next start from becoming a second
writer, and it says so in one sentence.

### 3. Termux app killed — pass

`am force-stop com.termux` from **inside** Termux does **not** work on this phone
(Finding 7), and the Android Settings force stop did not take either: after it the
launcher (`23299`, started 12:10) and even `sshd` (`17945`, started 12:01) were
still the same processes, which is only possible if no Termux process was stopped
at all. What did work, and what the record below is from, is killing every
process of the UID from inside Termux — the same end state as a force stop for
the app's durability (all processes gone, no supervisor, sockets closed), though
it is **not** Android's own force stop and is recorded as such:

```bash
pkill -9 -u "$(id -u)"
```

That ends the Termux app's whole process tree, `sshd` and the reverse `ssh -R`
tunnel included, so the operator has to reopen Termux and re-establish the tunnel
before the state can be read.

| | |
|---|---|
| Killed | every process of `u0_a178` at ~13:53 local (12:53Z was the last log line before it) |
| `boot_id` | `cf7373f5-…` — **unchanged**: an app kill, not a reboot |
| Boot line | **none** (`grep -c '^boot:'` → 0): Termux:Boot runs at reboot only |
| Restarted by itself | **no** — `pgrep -a node` empty, `healthz` `000` after the kill and before the manual start |
| Left behind | stale `launcher.pid` (`23299 …`) and `server.pid` (`23313 …`) with dead pids |
| Data on disk | 23 documents; `pi_tasks` 27/28/29 still `sleeping`; `pragma synchronous` = 2 |
| After `~/pupkeep-start.sh` | new launcher `4167`, server `4184`; the stale locks were cleared; `healthz 200`; `session bootstrap created=false`, `feed planner reconciliation createdPlanner=false`, `listening url=http://127.0.0.1:8791` |
| State after | identical: setup complete, `profileRev 1`, open walk `6eb50678-…`, appointment `e84c230a-…` |
| Session | the same cookie still worked; the driver never re-signed in |
| Reminder tasks | 27/28/29 still `sleeping` — nothing was lost or re-armed twice |

So: the data outlives the process, nothing restarts the app by itself, and the
next start finds everything (and clears its own dead locks).

### 4. Phone reboot — the data survives, the boot path does not start the app

**The durability half passes; the boot half fails.** Two separate claims, and it
matters which one is which.

| | |
|---|---|
| `boot_id` | `cf7373f5-…` → **`3e85e392-e208-4eb8-925a-03c97feea9cf`** — a real reboot |
| Boot line at reboot | **none**. The first `boot:` line in `server.log` is from 15:13:56, written by the *manual* run below |
| App after the reboot | **down**: no `node`, `healthz` `000` on 8787 (127.0.0.1 and the tailnet address) |
| Data after the reboot | intact: 23 documents, `pi_tasks` 27/28/29 `sleeping`, `pragma synchronous` = 2 |
| Session after the reboot | the same cookie still worked; the driver never re-signed in |
| Started by hand the way the boot path intends (`--access tailscale --boot`) | launcher `19857`, server `19869`, `listening url=http://100.90.202.61:8787`, `healthz 200` |
| State after that | identical: setup complete, `profileRev 1`, open walk `6eb50678-…`, appointment `e84c230a-…`, tasks 27/28/29 still `sleeping` |

**Why the boot path fails** (Findings 8–9): `~/.termux/boot/pupkeep.sh` execs
`scripts/termux-boot.sh`, whose shebang is `#!/usr/bin/env bash` — and Termux has
no `/usr/bin/env` (its `env` is `$PREFIX/bin/env`). Under a minimal environment
that is:

```
…/scripts/termux-boot.sh: /usr/bin/env: bad interpreter: No such file or directory
```

and with the interpreter passed explicitly, the next line that needs the
environment bites: `line 57: PREFIX: unbound variable` (`set -u`, and
Termux:Boot exports neither `PATH` nor `PREFIX`). The same script run from an
interactive Termux shell works — that is the run that produced the `boot:` line
and the tailnet listener above.

What this means for G5: **the reboot does not lose anything** (the gate's data
claim holds), but "phone reboot recovers" did **not** hold — the operator had to
start the launcher by hand after every reboot. **Fixed 2026-11-10:** the wrapper
`termux-install.sh` writes now execs `"$PREFIX/bin/bash" "<repo>/scripts/termux-boot.sh"`
instead of relying on the tracked script's shebang, and `termux-boot.sh` sets
`PATH`, `PREFIX` and `HOME` itself; `test/termux-scripts.test.ts` runs it with
`env` replaced entirely, which is the only way that regression stays caught. The
cell needs a **re-walk** to record the pass: `~/.termux/boot/pupkeep.sh` must be
regenerated by the new `scripts/termux-install.sh` first (the old wrapper is on
the phone).

Whether Termux:Boot ran the wrapper at all cannot be distinguished from here:
the wrapper dying at the `exec` and the app never being armed both leave exactly
this evidence (no boot line). The fix makes that distinction visible — a working
wrapper always writes the boot line.

### 5. Tunnel restart — fail (two defects)

Run as a throwaway second instance on port 8793 so the household was untouched.

```bash
node bin/pupkeep.js --access cloudflare --port 8793 --data ~/.pupkeep-tunnel
```

**Defect A — a fresh `cloudflare` start can never come up.** The launcher mints
the owner link only once it knows the origin, and in `cloudflare` mode the origin
is the tunnel URL, which does not exist yet: it logs *"the tunnel URL is not known
yet, so no owner link can be printed for this origin"* and mints nothing. The
server then refuses to bootstrap:

```
ERROR [server] refusing to start error=session bootstrap failed: config.json has no active member;
mint the owner before starting the server
```

Minting once in `local` mode and switching to `cloudflare` is the workaround.
PLAN §6.7 says minting on the tunnel URL belongs to P4-05, which has landed and
still does not do it.

**Defect B — the tunnel never registers, and the launcher announces a URL that is
not a tunnel.** With an owner present, the server starts, but every cloudflared
child exits ~5 ms after `Requesting new quick Tunnel on trycloudflare.com...`, and
the launcher prints:

```
pupkeep: quick tunnel at https://api.trycloudflare.com
```

`api.trycloudflare.com` is cloudflared's **API endpoint**, not a tunnel hostname:
`parseTunnelUrl` matches the first `https://<host>.trycloudflare.com` in any line,
and the launcher then swallows that line (`if (stream === "stderr" && !url) log(line)`),
so the operator sees neither the error nor the real URL. Captured with a shim in
place of the binary, the hidden line is:

```
failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel":
dial tcp: lookup api.trycloudflare.com on [::1]:53: read udp [::1]:33747->[::1]:53: read: connection refused
```

i.e. **DNS fails inside the chroot**: Go's resolver fell back to `[::1]:53`. The
same wrapper run by hand works, and this is the difference that is *not*
explained yet:

```bash
env SSL_CERT_FILE=/etc/tls/cert.pem termux-chroot ~/.pupkeep/bin/cloudflared \
  tunnel --no-autoupdate --url http://127.0.0.1:8791
# 6 s later: https://consulting-bras-insight-positions.trycloudflare.com
#           DNS Resolution region1/2.v2.argotunnel.com  PASS
```

`termux-chroot cat /etc/resolv.conf` shows `nameserver 8.8.8.8` / `8.8.4.4` both
from `~` and from `~/pupkeep`, so the bind itself is fine when run from an
interactive shell. The launcher's spawn (`detached: true`, `stdio: pipe`) is the
remaining difference; the working hypothesis is that the chroot's mount namespace
is not the one cloudflared ends up in, but it is **unproven** and recorded as
open. The restart line does not help: `tunnel restart 5 in 16000 ms` omits the
exit code and signal that the server's restart line carries.

### 6. Agent mid-turn — not observed on this host

The cell needs a real model turn, and the host has no provider key
(`~/.pupkeep/secrets.json` is absent). Entering one is the owner's call, and the
weekly budget applies. What is claimed instead is the host-side half: a process
killed between the tool intent and the tool result reruns the safe tool exactly
once and the turn completes attributed — [`../test/kill-matrix.test.ts`](../test/kill-matrix.test.ts)
does that with a real `SIGKILL` and a real SQLite file.

To run it here: enter a key in Settings, send the agent a message that makes it
call a write tool, and `kill -9` the server pid while the tool card is still
spinning. The turn must complete after the restart with one care write.

## Findings

1. **`pkg update` without `pkg upgrade` breaks Node on this phone** (observed
   12:01): the index moved `nodejs` to 26.13.0 but not `libicu`, and `node` then
   died with `CANNOT LINK EXECUTABLE "node": library "libicui18n.so.79" not found`.
   `scripts/termux-install.sh`'s own note says to upgrade first, but the script
   does not do it and does not check afterwards. P5-04 should make it run the
   upgrade (or fail with that sentence).
2. **`scripts/termux-install.sh` works end to end on a clean Termux** (12:03):
   packages, the pinned cloudflared (checksum matched the P0-03 binary), `npm ci
   --omit=dev` (93 packages, 9 s), the boot wrapper. `termux-setup-storage` was
   declined/non-fatal as designed.
3. **Port 8787 belongs to the operator's own ssh config** while `ssh oracle` is
   open (`LocalForward 8787`). The launcher's message is accurate but the cause is
   not obvious from it; the runbook should name this collision, because on this
   phone the default port is unusable during normal operator work.
4. **The quick tunnel does not work from the launcher on this phone** — defects A
   and B above. Both are host-side and testable without a phone.
5. **`/tmp` is not writable in Termux.** A probe that wrote `/tmp/second.out`
   failed with `Permission denied`; scratch files belong in `$HOME`.
6. **Node major divergence re-measured** (P1-03's carry-over): phone
   `v26.13.0` today (P0-01 measured `v26.12.1`; `pkg update` moved it), devcontainer
   `v24.22.1`. `engines.node` is `>= 24`, so both are covered; the phone is a
   moving target, and this row is why the pin is a floor.
7. **`am force-stop com.termux` is denied from inside Termux** (observed
   2026-11-10 13:49): `java.lang.SecurityException: Permission Denial:
   forceStopPackage() … requires android.permission.FORCE_STOP_PACKAGES`. It also
   exits **0**, so a script cannot detect the failure, and P0-06's "user ran
   `am force-stop com.termux`" is not reproducible this way on this build.
   **The Android Settings force stop did not take either** on this phone: after
   it, the launcher and even `sshd` were the same pids as before, so no Termux
   process had been stopped. Cell 3 was therefore observed with
   `pkill -9 -u "$(id -u)"`, which reaches the same end state for the app's
   durability but is not Android's own kill. P5-05 should find out what this ROM
   actually needs (it may be stopping the wrong package: `com.termux` vs
   `com.termux.boot`/`com.termux.api`), because "the operator can force stop the
   app" is a release-procedure assumption.
8. **The boot path cannot start on Termux at all** (observed 2026-11-10 15:14).
   `~/.termux/boot/pupkeep.sh` execs `scripts/termux-boot.sh`, whose shebang is
   `#!/usr/bin/env bash`; Termux has no `/usr/bin/env`, so under a minimal
   environment the exec fails with `bad interpreter: No such file or directory`.
   With the interpreter passed explicitly, `set -u` then kills it at
   `line 57: PREFIX: unbound variable`. `scripts/termux-sshd.sh` has the same
   shebang and fails the same way when exec'd. The scripts work from an
   interactive Termux shell (that is how they have always been run), which is
   exactly why this was never seen.
9. **Termux:Boot's environment is the missing contract.** It supplies neither
   `PATH` nor `PREFIX`, and the scripts assume both. The wrapper `termux-install.sh`
   writes should `exec "$PREFIX/bin/bash" "<repo>/scripts/termux-boot.sh"` and the
   script should set `PATH`/`PREFIX` itself; `test/runbook.test.ts` asserts the
   `#!/usr/bin/env bash` shebang today, so it has to change with the fix.
   Whether Termux:Boot ran the wrapper on this reboot cannot be distinguished
   from the log (a death at the exec and a never-armed app look identical); the
   fix is required either way.

## Where the result lands

- The two defects and the install findings go to P5-01b's follow-up (host-side
  fixes with tests) and P5-04 (the install script).
- The reboot row stays open until Tailscale is installed and the owner reboots the
  phone; G5's "phone reboot recovers" is **not** met until then.
- P5-05 owns the day-long battery/heat and the wake-lock effect; this file does
  not claim either.
