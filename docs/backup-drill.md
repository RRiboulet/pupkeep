# Backup and restore drill — P5-02

**Walked 2026-11-18** against the live household on the daily phone and against
this coding host. P1-07 built the job (`scripts/backup.ts`, `scripts/restore.ts`);
this file is the drill that tries to break it, and it records what was seen, what
was not, and the three things that went wrong here.

Companions: PLAN §7.5 (the procedure this checks), §14.4 (what may and may not be
in a bundle), [`PHONE-RUNBOOK.md`](PHONE-RUNBOOK.md) §7 (the operator's copy of
the same job), [`DEPLOY.md`](DEPLOY.md) (where a restore fits a deployment).

## What this proves, and what it does not

| Proves | Does not prove |
|---|---|
| A real household's bundle restores **on a different machine** and boots with `secrets.json` absent | A **clean** Termux install: the phone here had its packages, its checkout and its data | 
| A session minted before the snapshot still authenticates after the restore, and VAPID keys/subscriptions/ntfy topics survive | The partner's device: no push was delivered (P0-10) |
| An off-device copy through a real `rclone` sftp remote uploads, verifies and restores | A network remote other than sftp; no S3/WebDAV/B2 target was configured |
| A truncated archive is refused and installs nothing | A restore interrupted **mid-move**, caught by timing: see §5 |
| Rotation re-encrypts every retained archive and does not orphan the oldest | The Docker/VPS fallback: no Docker daemon here, and the image is unbuilt |
| — | That the job ever runs by itself: **no schedule is installed** (§8) |

## Hosts

| | |
|---|---|
| Phone | Samsung `SM-G998B`, Termux, Node `v26.13.0`, `rclone`, `age`, `expect` all present |
| Coding host | this devcontainer, Node `v24.22.3`, `age`/`expect`/`rclone`/`sqlite3` present |
| Data | the **live** household: 23 documents, 6 task rows, durable `next_seq` 53 |
| Archive | 12 262 B for that household (`pupkeep-20261118T133349Z.tar.gz.age`) |

The passphrase was generated on the coding host into a 0600 file, sent to the
phone **on stdin** (`IFS= read -r P && export PUPKEEP_BACKUP_PASSPHRASE="$P"`),
and never appeared in a command line, a file on the phone, or this document.

## 1. The backup job on the phone

```bash
npm run backup -- --data ~/.pupkeep
```

```
WARN [backup] no rclone remote configured; only the local encrypted archive was written
backup ~/.pupkeep/backups/pupkeep-20261118T133221Z.tar.gz.age (12263 bytes, seq 53->53, local only)
```

Two observations. The warning is exactly the gap P1-07 recorded (no remote), and
`seq 53->53` is the job's watermark check: nothing committed between the snapshot
and the verification, so there was nothing to miss.

## 2. The off-device copy, over a real remote

The phone's `rclone` reaches the operator's VPS with the key it already has:

```bash
rclone config create vps sftp host=<vps> user=ubuntu key_file="$HOME/.ssh/phone_oracle"
npm run backup -- --data ~/.pupkeep --remote vps:pupkeep-offsite/drill
```

```
backup ~/.pupkeep/backups/pupkeep-20261118T133349Z.tar.gz.age (12268 bytes, seq 53->53, uploaded)
```

and `--verify`, which decrypts the archive it just wrote and re-checks the seq:

```
verified pupkeep-20261118T133349Z.tar.gz.age (durable seq 53)
```

**Finding: `rclone`'s sftp backend does not verify host keys by default.** It
prints `NOTICE: No host key validation is being performed` and connects. For a
backup target that is worth fixing rather than noting: the drill added
`known_hosts_file=$HOME/.ssh/known_hosts` to the remote and the NOTICE went away.
A stolen archive is still encrypted, so the exposure is integrity and
availability, not confidentiality — but a silent substitution would fail a restore
at the worst possible moment. The runbook's backup section should name this line.

## 3. Restore the off-site copy on the phone

```bash
rclone copyto vps:pupkeep-offsite/drill/<archive> ~/p5-02/from-remote/offsite.age
npm run restore -- --data ~/p5-02/restored2 --archive ~/p5-02/from-remote/offsite.age
```

```
restored pupkeep.sqlite, config.json, push.json from …/offsite.age (durable seq 53)
secrets.json is absent (it is excluded from backups); re-enter the provider keys before use.
```

Then the restored copy was started **as a second instance** (`--access local
--port 8793 --data ~/p5-02/restored2`) and checked against the session that
existed before the snapshot:

| Check | Result |
|---|---|
| `healthz` on 8793 | **200** |
| `/api/session`, `/api/puppy`, `/api/walks` with the pre-restore cookie | **200, 200, 200** |
| the same routes with no cookie | **401** |
| `secrets.json` in the restored directory | **absent**, and it boots |
| `push.json` | `ntfy`, `prefs`, `schemaVersion`, `subscriptions`, `vapid` — VAPID keys and subscriptions survive |
| durable `next_seq`, documents, tasks | 53 / 23 / 6 — identical to live |

### Two ways this drill lied before it told the truth

Both are worth more than the pass, because both will fool the next person:

1. **A session minted after the snapshot is not in it.** The first attempt signed
   in *after* taking the backup and then reported 401 against the restored copy.
   That is not a restore defect: sessions live in `config.json`, the bundle is a
   snapshot, and a cookie created afterwards cannot be inside it. The fix is the
   order — sign in, *then* back up, *then* restore.
2. **A stray instance on the same port serves the old data directory.** Two of
   the first attempts left a launcher from an earlier try holding port 8793. The
   new instance hit `EADDRINUSE`, the launcher restarted it (five times), and
   every request was answered by the **old** restored directory — so the check
   read 401 for a session that was in the *new* archive. Killing `server.pid` is
   not enough: the launcher restarts the server. Kill the launcher, or match the
   data directory in `argv` (`pkill -f 'p5-02/restored'`), then confirm nothing
   holds the port. This is the same shape as P5-01b's launcher-versus-server
   lesson, from the other side.

## 4. Restore on a different machine (this host)

```bash
npm run restore -- --data /tmp/p5-02/data-restored --archive phone-20261118.age
npm run start  # --access local --port 8790
```

```
restored pupkeep.sqlite, config.json, push.json from … (durable seq 53)
listening url=http://127.0.0.1:8790
```

`healthz` 200, 23 documents, the planner reconciled, `secrets.json` absent and
the server did not care. That is the "restore works on a clean host" half of G5
as far as this container can carry it — a different machine, a different Node
major (24 vs 26), the same bundle.

## 5. An interrupted restore — and why the drill could not catch it

`restoreDataDir` moves the old files into `restore-backup-<stamp>-<pid>/` and
then installs the new ones; a failure in between names that directory. The window
between the two is milliseconds. **Twelve attempts** with a `SIGKILL` at 20–240 ms
never landed in it: every run either died before the move (old data intact) or
finished.

What that bought is a fix rather than a record. Reading the code after the failed
attempts showed `movedAside` was assigned *before* `mkdir`, so a `mkdir` that
fails (a read-only data directory, a full disk) made the error say "the previous
files are in `<dir>`" about a directory that was never created. It is now
assigned only after the directory exists, which makes the sentence true by
construction. A closer drill needs a filesystem seam the module does not have;
that is recorded here rather than bolted on.

## 6. A truncated archive (an interrupted generation) is refused

```bash
head -c 4000 archive.age > truncated.age
npm run restore -- --data /tmp/p5-02/data-trunc --archive truncated.age
```

```
ERROR [restore] age could not decrypt truncated.age (exit 1)
```

and the data directory stayed **empty** — no half-installed database, no
plausible-looking partial file. The job's own write path uses a temporary name and
a rename, so an interrupted *backup* does not leave an archive that looks newest.

## 7. Rotation, and the oldest retained archive

Three archives were taken with passphrase A, then rotated in one run:

```bash
PUPKEEP_BACKUP_PASSPHRASE=<B> PUPKEEP_OLD_BACKUP_PASSPHRASE=<A> npm run backup -- --rotate
```

```
rotated 3 archive(s) to the new passphrase
Store the new passphrase off the backup host and destroy the old copy; the old passphrase no longer decrypts these archives.
```

| Check | Result |
|---|---|
| Oldest retained archive restored with **B** | ok (`durable seq 53`) |
| Newest restored with **B** | ok |
| Newest restored with **A** | **refused** — `age could not decrypt … (exit 1)` |

So a rotation does not orphan a retained archive, the old key stops working, and
the job says out loud where the new passphrase belongs. The job also refuses to
rotate when the remote holds archives the local set does not (unit-tested), which
is the failure that would otherwise leave an old-key copy off-device unnoticed.

## 8. What this drill did *not* close

- **A clean Termux install.** The phone was the household's daily phone with
  packages, checkout and data in place. The clean-install leg from the todo was
  not done, and `DEPLOY.md`'s phone path is the closest thing to it.
- **The Docker/VPS restore.** No Docker daemon in this container; the image in
  this repository is unbuilt. This is P5-02's remaining leg and the only one that
  needs a host we do not have.
- **No schedule is installed.** `crontab` does not exist on the phone and
  `$PREFIX/var/service` holds only `pupkeep-tunnel`, `sshd`, `ssh-agent` and a
  stale `p0-06`. The job is real, the schedule is **P5-04's** scope, and an
  unattended run needs a passphrase source that is not beside the archive (PLAN
  §7.5) — an operator decision, not something a script should paper over.
- **Push delivery after the restore.** The VAPID keys and subscriptions are in
  the bundle and the restored `push.json` parses; no notification was actually
  delivered to the partner's device (P0-10).

## Cleanup, and what was left on the phone

The drill's archives were encrypted under a passphrase that existed only on this
host for the duration of the drill, so they were **deleted from the phone and from
the VPS** afterwards (`vps:pupkeep-offsite/drill`, `~/.pupkeep/backups`,
`~/p5-02/`). That returns the household to the state it was found in: **no
archives at all**, because none had ever been taken. The rclone remote definition
(`vps`) was left in the phone's rclone config — it is one config stanza, and the
next operator will want it — and the drill passphrases were removed from this
host.
