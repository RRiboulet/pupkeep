# P0-01 — Termux runtime and Pi Durable spike

**Task:** P0-01. **Date:** 2026-10-28. **Status:** complete on F-Droid Termux.

**Verdict:** all listed runtime checks pass on the host phone. Termux `0.118.3`
from F-Droid runs Node `26.12.1`; a server-style `.ts` probe runs directly by
type stripping, `node:sqlite` opens, `PRAGMA synchronous` reads `2` through the
plan’s exact open sequence, Pi Durable `1.4.0` commits a session document, the
document survives close/reopen and SIGKILL, `harness.resume()` starts cleanly,
and `Intl` resolves `Europe/Paris` with the correct winter/summer offsets.

An earlier run used the Play Store port `googleplay.2026.10.09` and also passed
the runtime checks; it was replaced with the F-Droid build to satisfy PLAN §6.1.
The evidence below is the F-Droid run.

## Device and runtime

| Field | Measured |
|---|---|
| Phone | Samsung `SM-G998B` (Galaxy S21 Ultra), `samsung` |
| Android | `15` / SDK `35`; security patch `2026-01-01` |
| Kernel | `5.4.242-30958140-abG998BXXSJHZC2` |
| ABI | `arm64-v8a`; `uname -m` = `aarch64` |
| Termux | `0.118.3`; installer `org.fdroid.fdroid` |
| Termux:API | `0.60.0`; `com.termux.api` installer `org.fdroid.fdroid`; `termux-notification` present |
| Termux:Boot | not installed at P0-01; installed during P0-06 |
| Node | `v26.12.1` |
| npm | `11.21.1` |
| SQLite | `node:sqlite` / CLI `3.54.1` |
| ICU / Unicode | `78.3` / `17.0` |
| Pi Durable | `1.4.0` |
| Pi AI | `1.4.0` |
| Chord | `1.4.0` |
| Database | `/data/data/com.termux/files/home/p0-01/p0-01.sqlite`, mode `0600`, 120K |
| Filesystem | `/data` on `/dev/block/dm-52`, `f2fs` — not `/workspace` or 9p |

`TERMUX_VERSION` was read from the environment because `termux-info` runs
`apt update` and stalls on the phone’s configured `mirrors.sdu.edu.cn` mirror.
The install used a temporary apt source file pointing at the official
`https://packages.termux.dev/apt/termux-main`; the user’s `sources.list` was not
changed.

A fresh F-Droid Termux needed a package upgrade before Node would run:
`apt install nodejs sqlite termux-api` installed Node `26.12.1`, but the binary
failed to link with `cannot locate symbol __hash_memory` until `apt upgrade -y`
updated `libc++` to `30` (74 packages, 23.519 s). PLAN §6.1’s `pkg upgrade` step
is therefore not optional on this repository.

## Commands, timings and install size

```bash
# The phone's configured mirror stalled; use the official repo for this run.
printf 'deb https://packages.termux.dev/apt/termux-main stable main\n' > ~/p0-sources.list
apt -o Dir::Etc::sourcelist=$HOME/p0-sources.list -o Dir::Etc::sourceparts=/dev/null update
apt -o Dir::Etc::sourcelist=$HOME/p0-sources.list -o Dir::Etc::sourceparts=/dev/null install -y nodejs sqlite termux-api
apt -o Dir::Etc::sourcelist=$HOME/p0-sources.list -o Dir::Etc::sourceparts=/dev/null upgrade -y

mkdir -p ~/p0-01 && cd ~/p0-01
npm init -y
npm pkg set type=module
npm install --no-audit --no-fund --save-exact \
  @earendil-works/pi-durable@1.4.0 \
  @earendil-works/pi-ai@1.4.0 \
  @earendil-works/chord@1.4.0

node probe.ts
```

| Step | Measured |
|---|---|
| `apt install nodejs sqlite termux-api` | **7.097 s** wall |
| `apt upgrade` (libc++ 30 and 73 others) | **23.519 s** wall |
| `npm install` (pinned) | **26.235 s** wall; 93 packages |
| `node_modules` size | **117M** (project total 118M) |
| First probe run | **4.418 s** wall |
| First open / commit / close | **112 ms** |
| Close / reopen / read / resume / close | **13 ms** |
| SIGKILL child startup (spawn + open + commit) | **1,894 ms** |
| Child open + commit (reported by the child) | **85 ms** |
| Reopen after SIGKILL / read / resume / commit / close | **30 ms** |
| Second restart / read / resume / close | **12 ms** |

`npm ls --depth=0` reported exactly:

```text
├── @earendil-works/chord@1.4.0
├── @earendil-works/pi-ai@1.4.0
└── @earendil-works/pi-durable@1.4.0
```

## What was run

The probe is throwaway scratch code at `~/p0-01/probe.ts` on the phone; it is
not in the repository and no app code was written. It defines a session-scoped
`app.spike` document with a `markers` array and uses Pi Durable’s faux provider
and an empty registry, so no network/model call is involved.

The exact open sequence, repeated on every open:

```ts
const db = await openNodeSqliteDatabase(path);
await db.exec("PRAGMA synchronous = FULL");
await db.exec("PRAGMA busy_timeout = 5000");
const storage = await SqliteStorage.open(db, { prefix: "pi_" });
const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
```

`openNodeSqliteDatabase` sets WAL + `NORMAL`; the `exec` raises the connection to
`FULL`. The probe asserts `PRAGMA synchronous` **before** storage/harness open
and **after** `Harness.open`, and checks `PRAGMA journal_mode` is `wal`.

The crash test is a real parent/child split:

1. The driver opens the DB, commits `first-commit`, closes, reopens, reads it
   back, calls `harness.resume()`, and closes.
2. The driver spawns a second Node process. The child opens the same DB with the
   same sequence, commits `before-kill`, writes a ready marker, and stays alive
   with the Harness open.
3. The driver sends **SIGKILL** to the child, waits for exit, reopens the same
   SQLite file, runs `PRAGMA integrity_check`, reads the document, calls
   `harness.resume()`, commits `after-restart`, and closes.
4. The driver opens the file once more and reads all three markers.

## Results

| # | Check | Measured output | Result |
|---|---|---|---|
| 1 | Node ≥ 24; server-style `.ts` runs with no build/flag | `runtime {"node":"v26.12.1","arch":"arm64","platform":"android","sqlite":"3.54.1","icu":"78.3","unicode":"17.0"}`; `node probe.ts` | **pass** |
| 2 | Exact open sequence; `PRAGMA synchronous` = `2` | `{"synchronous":2}` before storage and after `Harness.open` | **pass** |
| 3 | WAL | `{"journal_mode":"wal"}` | **pass** |
| 4 | Session `app.spike` doc commits, closes, reopens, reads back | `{"markers":["first-commit"],…}` after reopen | **pass** |
| 5 | Committed doc survives process death | child committed `["first-commit","before-kill"]`; SIGKILL; reopen still reads `["first-commit","before-kill"]` | **pass** |
| 6 | `PRAGMA integrity_check` after SIGKILL | `{"integrity_check":"ok"}` | **pass** |
| 7 | `harness.resume()` starts cleanly after restart | `running` after reopen, after SIGKILL, and after second restart | **pass** |
| 8 | `Intl` resolves `Europe/Paris` and DST offsets | `Europe/Paris`; `GMT+01:00` (15 Jan 2026) / `GMT+02:00` (15 Jul 2026) | **pass** |
| 9 | DB on local phone storage, never the workspace/9p mount | `realpath` = `/data/data/com.termux/files/home/p0-01/p0-01.sqlite`; `/data` is `f2fs` | **pass** |
| 10 | Pinned Pi versions | `1.4.0` / `1.4.0` / `1.4.0` | **pass** |
| 11 | Termux from F-Droid | `TERMUX_VERSION=0.118.3`; `com.termux` installer `org.fdroid.fdroid`; `com.termux.api` installer `org.fdroid.fdroid` | **pass** |

The SQLite database contains the expected `pi_`-prefixed tables
(`pi_conversations`, `pi_documents`, `pi_document_revisions`, `pi_entries`,
`pi_tasks`, `pi_submissions`, `pi_durable_schema`, …), confirming the
`{ prefix: "pi_" }` option was applied.

## Database path and durability caveat

- Path: `/data/data/com.termux/files/home/p0-01/p0-01.sqlite` (Termux home,
  internal app storage), mode `0600`.
- `/data` is `f2fs` on `/dev/block/dm-52`; the path is not `/workspace` and not a
  9p mount.
- `synchronous=FULL` + WAL means a committed transaction survives **process
  death**; the probe proves SIGKILL of a process with the Harness still open.
- It does **not** prove power-loss durability. That depends on the device,
  filesystem and storage flush behaviour; `FULL` reduces but cannot eliminate
  that risk. P1-07/P0-06 must keep the caveat and test OS process death, not just
  SIGKILL.
- The test kept one process on the DB at a time. The child was killed and joined
  before the parent reopened; no second writer overlapped.

## Blockers and fallback

The runtime itself has no blocker. The F-Droid install source is now satisfied.

- **Mirror:** the configured `mirrors.sdu.edu.cn` mirror stalled on `apt update`.
  The run used a temporary source file pointing at the official
  `packages.termux.dev` repository; the phone’s `sources.list` was left unchanged.
- **libc++:** a fresh F-Droid Termux needed `apt upgrade` before Node would link.
  Include `pkg update && pkg upgrade -y` in the phone install runbook.
- **Termux:API:** `0.60.0` is installed and `termux-notification` exists; actual
  notification delivery is P0-08, not tested here.
- **Termux:Boot:** not installed at P0-01; installed during P0-06, which owns
  boot/wake-lock/supervision.
- **One-process lock:** PLAN §16’s P0-01 bullet also names an application-level
  one-process lock. This spike did not test that lock module; P0-02 reviewed
  `lock.ts` for reuse, **P1-05 owns the pid lock**, and P1-04 calls it. The probe
  only kept one process on the DB at a time and proved the runtime’s
  crash/reopen path.
- **If the runtime ever fails on Termux** — apply PLAN §6.10: move the server to
  Docker/VPS, keep the same code, restore the backup, and make the phone a
  client. Do not build an Android runtime.

Not verified here: power loss; OS-driven process kill vs SIGKILL; real model/tool
tasks (faux provider only); the application-level one-process lock; Termux:Boot,
wake lock and phantom-process behavior (P0-06); `termux-notification` delivery
(P0-08); `node:sqlite` backup (P0-07). Only Node 26 was tested; Node 24 was not
separately installed.

## What P1-07 can rely on

- Node 26.12.1 on arm64 Android runs `.ts` server code by type stripping, with no
  build step and no flag.
- `node:sqlite` 3.54.1 works on Termux; the exact sequence
  `openNodeSqliteDatabase` → `PRAGMA synchronous = FULL` →
  `SqliteStorage.open(db, { prefix: "pi_" })` → `Harness.open` leaves
  `PRAGMA synchronous` at `2` with WAL.
- Pi Durable `1.4.0` session documents commit and survive close/reopen and
  SIGKILL; `PRAGMA integrity_check` is `ok` after the kill; `harness.resume()` is
  safe after restart.
- ICU is full (`78.3`): use IANA zones such as `Europe/Paris`; winter/summer
  offsets resolve correctly.
- The DB belongs on Termux home (`/data`, `f2fs`), not the Windows/9p workspace
  mount, and one process must own it.
- P1-07 still needs to prove the production schema/tools/tasks, the
  application-level one-process lock (P1-05), `harness.resume()` with live
  tasks/reminders, OS-level process death, power-loss limits, and the
  Termux:API/Boot notification path. This spike did not test those.
