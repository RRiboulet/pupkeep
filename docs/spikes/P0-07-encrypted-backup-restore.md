# P0-07 — Encrypted backup and restore spike

**Task:** P0-07. **Date:** 2026-10-28. **Status:** complete for the backup/restore
drill, with one recorded limitation: the encrypted bundle is a cleanly closed
snapshot, so restoring an **in-progress generation** was not exercised. P0-07 is
checked in PLAN §16.

**Verdict:** a scratch data directory containing SQLite, `config.json` and
`push.json` was backed up with SQLite’s online `.backup`, integrity-checked,
archived with only the three intended files, encrypted with `age`, copied
off-device, and restored on a clean phone directory and a clean devcontainer
directory. Auth hashes, VAPID keys, the push subscription, the ntfy topic, the
transcript, the open walk and the sleeping reminder all survived; the reminder
then completed after the restore under a future clock (`now + 2h`). `secrets.json`
and `server.log` were excluded and the restored Harness opens without
`secrets.json`.

## Environment

| Field | Value |
|---|---|
| Host phone | Samsung `SM-G998B`, Android `15` / SDK `35`, `arm64-v8a` |
| Termux / Node | F-Droid Termux `0.118.3`; Node `v26.12.1` |
| SQLite | `3.54.1` (phone), `3.50.6` (devcontainer restore) |
| Pi Durable | `1.4.0` (scratch data only; no product code) |
| Encryption | `age` `1.3.2` (phone) / `1.1.1` (devcontainer), passphrase mode; `expect` drives the prompt |
| Off-device copy | `scp` from the phone to the devcontainer |
| Bundle | `p0-07.tar.gz.age`, **5.9K**, SHA-256 `9c907b44d24c72e9b7d287afa6af9b124296a05fbdc45b8f62a1691a0b74f49f` |

## Scratch data set

`~/p0-07/data` on the phone:

| File | Contents | In bundle |
|---|---|---|
| `pupkeep.sqlite` | Pi Durable `1.4.0`, prefix `pi_`; root transcript, `app.walk` session doc, sleeping `app.reminder` task | **yes** |
| `config.json` | scratch owner/session/invite **hashes** and roles; no raw tokens | **yes** |
| `push.json` | VAPID public/private key pair, one test push subscription, per-user ntfy topic | **yes** |
| `secrets.json` | fake provider key (`sk-p0-07-…`) | **no** |
| `server.log` | fake owner-link line | **no** |

The scratch `app.walk` doc held `{ open: true, walkId: "walk-p0-07", startedAt }`.
The `app.reminder` task slept until `now + 1h` and committed `completed` in its
`deliver` phase. The prior transcript was a faux-provider user/assistant pair.

## Procedure and timings

1. Build the scratch data set with Pi Durable (faux provider, no model calls).
2. **During-generation check:** copy the data dir to `live/`, start a scratch
   generation against `live/pupkeep.sqlite`, wait for the provider marker, and
   run `sqlite3 live/pupkeep.sqlite ".backup 'backup/during.sqlite'"`.
   `PRAGMA integrity_check` on that copy: **ok**. The newest live commit was not
   visible in that copy (`during_live_submission=0`), so it is not the bundle.
3. **Bundle:** with the generation stopped, checkpoint/flush the source, copy
   `pupkeep.sqlite`, `config.json`, `push.json` into a staging dir, and tar that
   dir. The archive lists exactly the three files; no `secrets.json`,
   `server.log`, `-wal` or `-shm`.
4. Encrypt the tar with `age -p` (passphrase supplied out-of-band via `expect`;
   the passphrase is not in the bundle, the repo or the note).
5. Copy the `.age` file to the devcontainer with `scp`; for the drill the
   passphrase was copied separately to the same devcontainer. Production must
   keep the passphrase off the backup host (credential vault/different channel).
6. Restore on a clean phone directory `~/p0-07/restore` and on a clean
   devcontainer directory `/tmp/p0-07-restore`: decrypt, extract, run
   `PRAGMA integrity_check`, then run the scratch `restore-check.mjs`.
7. The restore check opens the Harness with a **future clock** (`now + 2h`) for
   the second pass, so the sleeping reminder is due and must complete.

| Step | Measured |
|---|---|
| Online `.backup` during the scratch generation (incl. settle) | **4,090 ms** |
| Bundle encryption | **1,408 ms** |
| Full backup script | **6,853 ms** |
| Bundle size | **5.9K** |
| Phone restore | `RESTORE CHECKS PASSED` |
| Devcontainer restore | `RESTORE CHECKS PASSED` |

## Results

| # | Check | Evidence | Result |
|---|---|---|---|
| 1 | Bundle contents match PLAN §7.5 | archive: `pupkeep.sqlite`, `config.json`, `push.json` | **pass** |
| 2 | Excluded files stay out | no `secrets.json`, `server.log`, `pupkeep.sqlite-wal` or `-shm` in the archive | **pass** |
| 3 | Online backup during a generation | `.backup` on the live copy; `PRAGMA integrity_check` = `ok` | **pass (snapshot caveat)** |
| 4 | Encryption / off-device copy | `age -p`; `scp` to the devcontainer; passphrase separate for the drill (production must not co-locate) | **pass (drill)** |
| 5 | Clean restore on the phone | `integrity_check=ok`; all restore checks passed | **pass** |
| 6 | Clean restore on the devcontainer | Node `v24.22.0`, SQLite `3.50.6`; all restore checks passed | **pass** |
| 7 | Owner/session/invite hashes | SHA-256 of the scratch tokens matches `config.json`; no raw token in config | **pass** |
| 8 | VAPID keys and push subscription | private JWK derives the stored public key; test subscription and ntfy topic survive | **pass** |
| 9 | Transcript | prior user/assistant pair survives | **pass** |
| 10 | Open walk | `{open: true, walkId: "walk-p0-07"}` survives | **pass** |
| 11 | Reminder task | sleeping task survives; with a future clock it completes | **pass** |
| 12 | No `secrets.json` required to boot | restored Harness opens without it; fake provider key absent | **pass** |
| 13 | `PRAGMA integrity_check` | `ok` on the bundle copy and both restores | **pass** |

The phone and devcontainer restores both reported:

```text
PASS no secrets.json in bundle
PASS no server.log in bundle
PASS auth owner hash
PASS auth session hash
PASS auth invite hash
PASS no raw tokens in config
PASS VAPID public key
PASS VAPID private key matches public
PASS push subscription survives
PASS ntfy topic survives
PASS PRAGMA integrity_check
PASS open walk survives
PASS reminder task survives
PASS prior transcript survives
PASS reminder fires after restore
RESTORE CHECKS PASSED
```

## Limitation: in-progress generation

The online `.backup` was taken while a scratch generation was running and passed
`integrity_check`, but its copy did not include the newest live commit (the
commit was still in the writer’s WAL when the CLI copy settled). The encrypted
bundle is therefore a **cleanly closed snapshot**; it restores the transcript,
walk and reminder, but not a generation that was mid-flight. A restore that
retries an in-progress generation remains a P1-07/P5-02 test. This does not
change the bundle contents or the auth/push/reminder result.

## Residual risks / notes

- The scratch `config.json`/`push.json` shape is invented for this spike;
  P1-05 must define the real schema and keep the same exclusions. The VAPID
  private key is inside `push.json` **inside the encrypted bundle** because push
  subscriptions need it; `secrets.json` (provider keys) is excluded.
- The backup passphrase is out-of-band. A lost passphrase means a lost backup;
  P1-07/P5-02 should document the recovery/rotation step and must not store the
  passphrase beside the archive.
- The `.backup`/WAL interaction above is a tooling caveat for the real backup
  job; the real job should verify a post-backup copy, not just the exit code.
- The off-device copy used `scp`, not the plan’s `rclone` path; rclone on Termux
  and the 14-day retention were not exercised. P5-02 must configure the remote
  and retention.
- The restore was on a clean **directory**, not a clean Termux app install; the
  devcontainer restore proves host portability of the SQLite/config/push set.
  P5-02 still owns the clean-Termux/VPS release drill.

## What P1-05/P1-07/P5-02 can rely on

- The backup set is exactly `pupkeep.sqlite` + `config.json` + `push.json`; the
  encrypted archive can exclude `secrets.json` and `server.log`, and the
  restored Harness opens without them.
- Owner/session/invite **hashes** restore auth without raw tokens; VAPID keys,
  the push subscription and the ntfy topic survive in `push.json`.
- A clean restore can read the open walk, the transcript and a sleeping reminder;
  a future clock makes the reminder fire, so the task state is real.
- Age passphrase encryption + `scp` is a workable drill path; `age` is available
  on Termux and the devcontainer. The production `rclone` remote and retention
  remain P5-02.
- The in-progress-generation restore and the clean-Termux/VPS drill are still
  open; do not claim them from this spike.
