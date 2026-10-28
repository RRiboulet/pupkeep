# P0-06 — Termux resilience and supervision

**Task:** P0-06. **Date:** 2026-10-28. **Status:** partial — process supervision,
`harness.resume()`, wake-lock commands, tmux, the parked-task path and the
Termux:Boot reboot are verified. The Termux app kill and the battery/phantom
settings check are still pending. P0-06 is **not** checked in PLAN §16.

## Environment

| Field | Value |
|---|---|
| Phone | Samsung `SM-G998B`, Android `15` / SDK `35`, `arm64-v8a` |
| Termux | `0.118.3` from F-Droid; `termux-api` `0.60.0` |
| Node | `v26.12.1` |
| Supervision | `termux-services` `0.13-1` (runit), `tmux` `3.8` |
| Pi Durable | `1.4.0` (scratch SQLite DBs; not product code) |
| Scratch paths | `~/p0-06` (`service.mjs`, `parked-*`), `~/.termux/boot/p0-06.sh` |
| Termux:Boot | `com.termux.boot` installed; boot script ran at reboot |

## Results

| # | Check | Evidence | Result |
|---|---|---|---|
| 1 | `termux-wake-lock` / `termux-wake-unlock` | both exit 0; `dumpsys power` is blocked to Termux (`dumpsys` not found / no permission), so the lock is not independently observable | **command pass; effect unverified** |
| 2 | `sv` supervises the Node process | `runsvdir` runs `p0-06`; `sv status` shows a pid; `kill -9` on the Node pid made runit start a new pid | **pass** |
| 3 | `harness.resume()` after supervised restart | service log: `start pid=10234 dbStarts=1 previousStarts=0 scheduling=running`, then after `kill -9`: `start pid=10345 dbStarts=2 previousStarts=1 scheduling=running` | **pass** |
| 4 | Manual `sv down` / `sv up` | `sv down` → `down: p0-06`; `sv up` → new pid; log `dbStarts=3 previousStarts=2` | **pass** |
| 5 | `tmux` | `tmux new-session -d -s p0-06 "sleep 300"`; `tmux ls` listed it; kill-session exit 0 | **pass** |
| 6 | Parked task at `restartLimit` | task `p0_06.hang`, `restartLimit: 1`: attempt 1 `running`; SIGKILL; attempt 2 `blocked` / `restart_limit`; `retryTask()` + finish flag → terminal `completed` | **pass** |
| 7 | Boot script | `~/.termux/boot/p0-06.sh` created; manual run exit 0; after reboot it wrote `boot.log`, started wake lock, sshd, `service-daemon`, `sv up p0-06` | **pass** |
| 8 | Termux:Boot companion app | `com.termux.boot` installed; boot script in `~/.termux/boot/p0-06.sh` | **pass** |
| 9 | Phone reboot / boot script | new boot id `cf7373f5-7f12-43d4-af54-8c607a2b3fee`; `boot.log` start 19:04:38, done 19:04:40; `sshd=13955`; service pid 13973 | **pass** |
| 10 | `harness.resume()` after reboot | service log `start pid=13973 dbStarts=4 previousStarts=3 scheduling=running` | **pass** |
| 11 | Kill the Termux app itself | not run yet | **pending** |
| 12 | Battery optimisation / phantom-process / OEM settings | Android blocks `settings get` and `dumpsys` from Termux (`INTERACT_ACROSS_USERS` / `DUMP` denial); the user must check the UI | **partial (not observable)** |
| 13 | Tailscale auto-connect after reboot | phone was offline in Tailscale after reboot until the user opened the Tailscale app | **manual start needed** |

## What was run

Supervision:

- `termux-services` provides `runsvdir` and `sv`.
- `$PREFIX/var/service/p0-06/run` execs
  `node /data/data/com.termux/files/home/p0-06/service.mjs`.
- The service opens the scratch SQLite DB with `PRAGMA synchronous=FULL`,
  `SqliteStorage.open(..., { prefix: "pi_" })`, `Harness.open`, commits a
  session document, calls `harness.resume()`, then stays alive.
- Killing the Node pid with SIGKILL made runit restart it; the next start read
  the prior document (`previousStarts`) and reported `scheduling=running`.
- `sv down`/`sv up` repeated the restart path.

Parked task:

```text
created task 7
attempt 1: {"scheduling":"running","state":{"kind":"running"}}
attempt 2: {"scheduling":"running","state":{"kind":"blocked","reason":"restart_limit"}}
retryTask(7) with a finish flag -> terminal completed
```

The task phase writes `parked.starts` and never commits while hanging. The
parent kills the child with SIGKILL; on the next attempt the scheduler parks the
task at `restartLimit: 1`. `retryTask()` clears the park, and the finish flag
lets the retried phase commit `completed`.

Boot script (exercised by the reboot):

```sh
#!/data/data/com.termux/files/usr/bin/sh
exec >> /data/data/com.termux/files/home/p0-06/boot.log 2>&1
echo "boot start $(date -Is) boot_id=$(cat /proc/sys/kernel/random/boot_id)"
termux-wake-lock
sshd
export SVDIR=$PREFIX/var/service
service-daemon start
sleep 1
sv up p0-06
echo "boot done $(date -Is) sshd=$(pgrep -x sshd | head -1) service=$(sv status p0-06 2>&1)"
```

The manual run exits 0. After the real reboot the same script started
`sshd` on 8022, `runsvdir` and the `p0-06` service; the service reopened SQLite
and `harness.resume()` logged `dbStarts=4 previousStarts=3 scheduling=running`.
The phone’s Tailscale client did **not** auto-connect after reboot; the user had
to open the Tailscale app before SSH was reachable.

## Blockers and next actions

- **Kill the Termux app itself** (`am force-stop com.termux`), reopen Termux and
  record whether `runsvdir`/`p0-06` returns. `sv-enable p0-06` should make the
  service autostart when the service daemon starts; sshd must be started again
  because Termux:Boot only runs on boot.
- **Battery/phantom/OEM settings:** set Termux to unrestricted battery use and
  check the Android 12+ developer option for the phantom-process killer. These
  settings are not readable from Termux; record the UI state manually.
- **Tailscale auto-connect:** it did not reconnect by itself after reboot. For a
  daily host, set Android’s “Always-on VPN” for Tailscale (or accept a manual
  start). This is an access-path finding for P0-03/P1-04.
- If Termux is killed too often even with these settings, PLAN §6.10 moves the
  server to the VPS/Docker fallback; the phone becomes a client.

## What P1-04/P1-13 can rely on

- `termux-services`/`runsvdir` restarts a Node child after SIGKILL; the next
  process can reopen SQLite and `harness.resume()` reports `scheduling=running`.
- The scratch service proves the supervision shape; P1-04’s launcher still owns
  the real pid lock and one-process rule.
- A task parked at `restartLimit` is visible as `blocked` / `restart_limit` in
  `harness.inspect()` and is retryable with `harness.retryTask()`.
- `tmux` is available for an interactive fallback, but `sv` is the supervised
  path.
- Termux:Boot restores the service after a reboot; the boot script started
  sshd, `runsvdir` and `p0-06`, and the service resumed the Harness. Tailscale
  needed a manual start after reboot.
- The Termux-app kill, wake-lock effectiveness, battery optimisation and the
  phantom-process killer are **not yet proven**; do not claim full phone
  survival until the pending checks are run.
