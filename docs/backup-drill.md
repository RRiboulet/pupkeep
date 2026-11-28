# Backup and restore drill — P5-02

**Walked 2026-11-18** against the live household on the daily phone and against
this coding host. P1-07 built the job (`scripts/backup.ts`, `scripts/restore.ts`);
this file is the drill that tries to break it, and it records what was seen, what
was not, and the three things that went wrong here.

Companions: PLAN §7.5 (the procedure this checks), §14.4 (what may and may not be
in a bundle), [`PHONE-RUNBOOK.md`](PHONE-RUNBOOK.md) **§10** (the operator's copy of
the same job — §7 is daily access), [`DEPLOY.md`](DEPLOY.md) (where a restore fits
a deployment).

## What this proves, and what it does not

| Proves | Does not prove |
|---|---|
| A real household's bundle restores **on a different machine** and boots with `secrets.json` absent | A **clean** Termux install: the phone here had its packages, its checkout and its data | 
| A session minted before the snapshot still authenticates after the restore, and VAPID keys/subscriptions/ntfy topics survive | The partner's device: no push was delivered (P0-10) |
| An off-device copy through a real `rclone` sftp remote uploads, verifies and restores | A network remote other than sftp; no S3/WebDAV/B2 target was configured |
| A truncated archive is refused and installs nothing | A restore interrupted **mid-move**, caught by timing: see §5 |
| Rotation re-encrypts every retained **local** archive and does not orphan the oldest | The Docker/VPS fallback: no Docker daemon here, and the image is unbuilt |
| — | That the job ever runs by itself: **no schedule is installed** (§8) |

## Hosts

| | |
|---|---|
| Phone | Samsung `SM-G998B`, Termux, Node `v26.13.0`, `rclone`, `age`, `expect` all present |
| Coding host | this devcontainer, Node `v24.22.3`, `age`/`expect`/`rclone`/`sqlite3` present |
| Data | the **live** household: 23 documents, 6 task rows, durable `next_seq` 53 |
| Archive | 12 262 B for that household (`pupkeep-20261118T133349Z.tar.gz.age`) |

The passphrase was generated on the coding host into a 0600 file and sent to the
phone **on stdin**, read into `PUPKEEP_BACKUP_PASSPHRASE` for the length of the
run (`IFS= read -r P && export PUPKEEP_BACKUP_PASSPHRASE="$P"`). It never appeared
in a command line *on the coding host* and never in this document.

**Recorded as a drill violation, exactly as P0-07 recorded its own:** the
passphrase was present *on the backup host* for the duration of each run, in a
process environment. PLAN §7.5's strong form is that it lives off the backup host,
and §14.4 says so; here rotation has to run where the archives are, so the key
necessarily reached the machine that holds them. A same-uid process could have
read `/proc/<pid>/environ` while the run was alive. That is acceptable on a
single-user phone (the plan says so for the `expect` path) and is **not**
acceptable as a pattern for the unattended run, which §8 leaves open on purpose.
The rotation command in §7 is shown with both passphrases as environment
assignments because that is the shape the job needs; the drill's own runs used
stdin as described.

## 1. The backup job on the phone

```bash
npm run backup -- --data ~/.pupkeep
```

```
WARN [backup] no rclone remote configured; only the local encrypted archive was written
backup ~/.pupkeep/backups/pupkeep-20261118T133221Z.tar.gz.age (12263 bytes, seq 53->53, local only)
```

Two observations. The warning is exactly the gap P1-07 recorded (no remote), and
`seq 53->53` is the job's watermark check — the source's seq when the copy began
against the copy's seq when it finished, and the archive is then verified against
the copy-start value. So it catches a copy that lagged; it does **not** see a
commit that lands after the copy but before the verify. That is what "a snapshot,
not corruption" means in §7.5, and the number here says the household was quiet
for the seconds the copy took.

## 2. The off-device copy, over a real remote

The phone's `rclone` reaches the operator's VPS with the key it already has:

```bash
rclone config create vps sftp host=<vps> user=ubuntu key_file="$HOME/.ssh/phone_oracle"
npm run backup -- --data ~/.pupkeep --remote vps:pupkeep-offsite/drill
```

```
backup ~/.pupkeep/backups/pupkeep-20261118T133349Z.tar.gz.age (12268 bytes, seq 53->53, uploaded)
# 12 268 B here and in the listing below; the 12 262 B in the table above is an
# earlier archive (13:32:21Z), not the same file.
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
| `/api/session`, `/api/puppy`, `/api/walks` with the pre-restore cookie | **200, 200, 200**[^scrub] |
| the same routes with no cookie | **401** |
| `secrets.json` in the restored directory | **absent**, and it boots |
| `push.json` | `ntfy`, `prefs`, `schemaVersion`, `subscriptions`, `vapid` — VAPID keys and subscriptions survive |
| durable `next_seq`, documents, tasks | 53 / 23 / 6 — identical to live |

### Two ways this drill lied before it told the truth

Both are worth more than the pass, because both will fool the next person:

1. **A session minted after the snapshot is not in it.** The first attempt signed
   in *after* taking the backup and then reported 401 against the restored copy.
   That is not a restore defect: sessions live in `config.json`, the bundle is a
   snapshot, and a cookie created afterwards cannot be inside it.[^scrub] The fix is the
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
node bin/pupkeep.js --access local --port 8790 --data /tmp/p5-02/data-restored
```

```
restored pupkeep.sqlite, config.json, push.json from … (durable seq 53)
listening url=http://127.0.0.1:8790
```

`healthz` 200, 23 documents, the planner reconciled, `secrets.json` absent and
the server did not care. That is **evidence toward** G5's "restore works on a
clean host" — a different machine, a different Node major (24 vs 26), the same
bundle — and it is **not** the clause itself: this host was a provisioned
devcontainer, not a clean install, and §15.6's G5 also still lacks the two-client
pass and the phone reboot.

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
plausible-looking partial file.

### What the reviewers found here, and the fix

This section originally ended by claiming the *backup* path also used a temporary
name and a rename. **It did not.** `backupDataDir` encrypted straight to the final
archive name, so a `SIGKILL` during encryption left a truncated file under the
**newest** name: the next default `--verify` and a restore with no `--archive`
both failed on it while the older archives sat beside it waiting for retention to
delete them. One reviewer reproduced it with twelve real kills at 250–800 ms and
caught the 800 ms one — 3 553 B at the final name that would not decrypt. The
same kill left a `.staging-*` directory holding the **plaintext** bundle
(`config.json`, `push.json` with the VAPID private keys, the database), which
`sweepStaging` only removes after an hour *and only when another backup runs* —
and §8 records that nothing runs this job on a schedule.

That is the answer to this section's question, so it was fixed rather than
reworded: the cipher now writes `<name>.partial`, the archive is decrypted and
seq-checked from that name, and only then renamed into place and fsynced. A
killed run can therefore leave a `.partial` and a `.staging-*`, never something
that matches the archive pattern. `test/backup.test.ts` pins both halves: no
archive-shaped file exists while encryption is running, and a stale `.partial` is
never `newestArchive`'s answer. **The staging residue is still only swept by the
next run** — it is 0700 and inside a 0700 directory, but a schedule (P5-04) is
what actually bounds it, and that is now recorded rather than assumed.

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
- **Two items from §7.5's post-restore checklist.** The drill confirmed the
  transcript and task rows by **count**, not by reading them, and it did not
  confirm an **open walk** after a restore or a reminder task **firing** post
  restore. The counts and the `/api/puppy` read make both very likely; neither was
  observed, so neither is claimed.
- **The interrupted restore itself.** §5 explains why timing could not catch it;
  until the module has a filesystem seam, §7.5's "the drill checks the interrupted
  case" stays unproven rather than passed.
- **Rotation with a remote configured.** The rotation ran local-only; the remote
  half was not drilled. Current `test/backup.test.ts` coverage refuses a
  remote-only archive and pins size-and-digest verification of a rotated
  re-upload, including a retry after corruption, but that is an injected
  `CommandRunner`, not a real rclone remote.

## Cleanup, and what was left on the phone

The drill's archives were encrypted under a passphrase that existed only on this
host for the duration of the drill, so they were removed afterwards. Nothing was
left that could look like a usable backup and then fail:

```bash
# on the phone
pkill -f 'p5-02/restore[d]' ; rm -rf ~/p5-02 ~/.pupkeep/backups
rclone purge vps:pupkeep-offsite/drill
rclone lsf vps:pupkeep-offsite/          # empty
ls ~/.pupkeep | grep -c backups          # 0
# here
rm -rf /tmp/p5-02                        # archives and passphrase files
```

That returns the household to the state it was found in: **no archives at all**,
because none had ever been taken. **`status.json` went with the directory** — it
lives in `<data>/backups`, so deleting the directory also deletes the app's
backup-warning signal; the app re-creates it on the next failed run. **Do not copy
this part of the drill against real backups**: deleting a live household's only
backup directory would be a data-loss event, and it was only safe here because
every archive in it was made minutes earlier with a key that died with the drill.

The rclone remote definition (`vps`) was **left** in the phone's rclone config.
It holds a hostname, a user, a path and a `key_file` path — no key material and no
passphrase — so it is not a secret. It is a **half-configured target** (no
schedule, no passphrase source), and "the next operator will want it" must not be
read as "backups are running".

The drill passphrases were removed from this host with `/tmp/p5-02`.

## S3 target (OCI Object Storage) — drilled 2026-11-20

The 2026-11-18 drill above left one row of its own table open: "a network remote
other than sftp; no S3/WebDAV/B2 target was configured". This section closes that
row against a real S3-compatible bucket, and records what it still does not prove.

| | |
|---|---|
| Host | this coding host, Ubuntu 24.04 arm64, Node `v24.22.2`, `age 1.1.1`, `rclone v1.60.1`, `expect 5.45.4` |
| Target | rclone remote `pupkeep-oci`, bucket `pupkeep-backups` (OCI Object Storage, S3-compatible), `RCLONE_CONFIG=/etc/pupkeep/rclone.conf` |
| Config | `/etc/pupkeep/rclone.conf` is `root:root 0600`, so **the job ran under `sudo -n`**: the app's own user cannot read the copy target's credentials |
| Data | a data directory the **app itself created** (`node bin/pupkeep.js --access local --port 8798 --data …/hh`): 23 documents, 1 task, durable `next_seq` 8, plus a **fake** `secrets.json` and a `server.log` |
| Archives | 7 392 B (`pupkeep-20261120T152959Z.tar.gz.age`, taken while the server was running) and 7 391 B (`…153021Z`) |

### What this proves, and what it does not

| Proves | Does not prove |
|---|---|
| An encrypted bundle uploads to an S3-compatible object store and the object is **byte-identical** to the local archive (sha256 compared) | Another S3 vendor, a slow or lossy link, or a bucket in a different region: this bucket is beside the host |
| The object at rest is age ciphertext — `file` says `age encrypted file, scrypt recipient (N=2**18)` and the first two bytes are `61 67` (`ag`), not the gzip magic `1f 8b` | That the bucket's own policy is right for a household: the drill did not audit OCI IAM, versioning or lifecycle rules, and the object is only as private as the key's scope |
| `secrets.json` and `server.log` are **absent** from a bundle taken from a data dir that contains both | That no *other* copy of them exists anywhere: the drill only inspects the bundle |
| `PRAGMA integrity_check` runs on the copy, and a corrupt database is **refused** (`… failed integrity_check`, exit 1, no archive written, `status.json` carries the message) | Corruption in a page's **free space**: a first attempt garbled 32 unused bytes and the job (correctly) still said `ok` — the check validates structure, not the whole file |
| A restore from the object **downloaded out of the bucket** yields a bootable data dir: `healthz` 200, 401 without the cookie, `next_seq` and the 23 documents identical | A restore on a clean host: this is the same machine that took the backup |
| 14-day retention prunes expired archives **locally and remotely** and keeps everything inside the window; the never-delete-the-newest rule holds | The newest-keep rule with a **real clock** where the newest archive is itself expired — impossible against `new Date()`, so that one case was checked against `expiredArchives()` in isolation |
| A passphrase file inside `<data>` or `<data>/backups` is refused, in both places | PLAN §7.5's strong form: the drill key sat on this host (outside the data dir, 0600) for the length of the run |

### 1. A missing helper, and what the job said about it

`expect` was **not installed** on this host, although `checkBackupTools` requires
it:

```bash
sudo -n env RCLONE_CONFIG=… npm run backup -- --data …/hh --remote pupkeep-oci:pupkeep-backups/drill-<UTCSTAMP> \
  --passphrase-file /tmp/pupkeep-drill/pass --retention-days 14 --require-remote
```

```
ERROR [backup] could not run expect: spawn expect ENOENT
```

Exit 1 before anything was written — correct behaviour, wrong sentence. See
defect 1 below. `sudo -n apt-get install -y expect` (5.45.4, plus automatic
`tcl-expect`) made the rest of this section possible; **that package is left
installed on this host** and is the only host change the drill made.

### 2. One encrypted bundle, and what is not in it

Two runs, both with `--require-remote`:

```
backup /tmp/pupkeep-drill/hh/backups/pupkeep-20261120T152959Z.tar.gz.age (7392 bytes, seq 8->8, uploaded)
backup /tmp/pupkeep-drill/hh/backups/pupkeep-20261120T153021Z.tar.gz.age (7391 bytes, seq 8->8, uploaded)
```

`seq 8->8` is the watermark check described in §1 above; the first run was taken
with the server **live** on port 8798, so this also re-confirms that the SQLite
online-backup path is safe against a running app.

The object was pulled back out of the bucket, decrypted with the drill
passphrase over a PTY (`expect`, as the job does), and its members listed:

```bash
sudo -n rclone copyto pupkeep-oci:pupkeep-backups/drill-<UTCSTAMP>/pupkeep-20261120T153021Z.tar.gz.age /tmp/…/
sudo -n expect -c '…spawn age -d -o $env(OUT) $env(IN)…'
sudo -n tar -tzvf /tmp/…/bundle.tar.gz
```

```
-rw------- root/root  122880 2026-11-20 15:30 pupkeep.sqlite
-rw------- root/root     304 2026-11-20 15:30 config.json
-rw------- root/root     408 2026-11-20 15:30 push.json
```

**Three members and no others.**[^scrub] `secrets.json` and `server.log` were present in
the source directory at the time of the run (fake provider keys, `0600`) and both
are absent from the bundle; the job builds the tarball from the `BACKUP_FILES`
list, not from a directory walk, and `stageArchive` refuses a bundle whose member
set differs from that list.

### 3. The object in the bucket is ciphertext, and it is the same bytes

```bash
rclone lsjson pupkeep-oci:pupkeep-backups/drill-<UTCSTAMP>
rclone cat …/pupkeep-20261120T152959Z.tar.gz.age | head -c 4096 | file -
rclone cat …/pupkeep-20261120T152959Z.tar.gz.age | head -c 2 | xxd -p
sha256sum <local archive>                     # and the same over `rclone cat`
```

| Check | Observed |
|---|---|
| `lsjson` | `{"Path":"pupkeep-20261120T152959Z.tar.gz.age","Size":7392,…,"Tier":"STANDARD"}` — size matches the local archive exactly |
| `file -` on the remote bytes | `age encrypted file, scrypt recipient (N=2**18)` |
| first two bytes | `6167` (`ag`), **not** `1f8b` — rclone is moving opaque bytes, as intended |
| sha256 local vs `rclone cat` of the object | identical (`e84addf6…57f3` for run A, `bad8d38b…57f3` for run B) |

So "encrypted before it leaves the host" is not an assumption here: the bytes at
rest in the bucket are age output, and no rclone crypt remote is involved.

### 4. The integrity check, both ways

The job prints nothing when `PRAGMA integrity_check` says `ok` — it only speaks
when the copy is bad. The positive side is visible in the restored copy (§5) and
in a direct read of the decrypted bundle (`integrity_check: ok`, `next_seq 8`).
The check is live, not decorative:

```bash
# a copy of the same database with one b-tree cell pointer overwritten (page 3, +8)
printf "\xff\xff" | dd of=…/pupkeep.sqlite bs=1 seek=$((2*4096+8)) conv=notrunc
```

```
ERROR [backup] the database copy failed integrity_check: *** in database main ***
Tree 3 page 3 cell 0: Offset 65535 out of range 3881..4092
```

Exit 1, **no archive written**, and `backups/status.json` carries that text in
`lastError` while `lastArchive` stays `null` — which is exactly the signal the app
needs to show a failed backup rather than a stale success.

### 5. Restore from the bucket object

```bash
sudo -n rclone copyto pupkeep-oci:pupkeep-backups/drill-<UTCSTAMP>/pupkeep-20261120T153021Z.tar.gz.age /tmp/…/from-remote/
sudo -n npm run restore -- --data /tmp/…/restore-live --archive /tmp/…/from-remote/pupkeep-20261120T153021Z.tar.gz.age \
  --passphrase-file /tmp/pupkeep-drill/pass
```

```
restored pupkeep.sqlite, config.json, push.json from /tmp/…/pupkeep-20261120T153021Z.tar.gz.age (durable seq 8)
secrets.json is absent (it is excluded from backups); re-enter the provider keys before use.
```

| Check | Result |
|---|---|
| `config.json`, `push.json` vs the source directory | **byte-identical** (`cmp`)[^scrub] |
| `PRAGMA integrity_check` on the restored copy | `ok` |
| durable `next_seq`, documents, tasks | 8 / 23 / 1 — identical to the source |
| `secrets.json` in the restored directory | absent, and the app does not care |
| the app booted from it (`--access local --port 8799`) | `healthz` **200**, `/api/puppy` and `/api/walks` without the cookie **401**, `session bootstrap created=false` (it recognised the restored owner)[^scrub], `listening url=http://127.0.0.1:8799` |
| `integrity_check` after that boot | still `ok` |

Nothing was deployed: one process on `127.0.0.1:8799`, stopped after the check.

### 6. Retention, with the counters

Four dummy objects with archive-shaped names (512 random bytes each — never
decrypted, they exist only to be listed and pruned) were seeded **both** in
`<data>/backups` and in the remote prefix, dated `20260901`, `20261001`,
`20261030` (all older than the 14-day window at 2026-11-20T15:30Z) and `20261119`
(inside it). The next run:

```
backup /tmp/pupkeep-drill/hh/backups/pupkeep-20261120T153021Z.tar.gz.age (7391 bytes, seq 8->8, uploaded)
retention removed locally: pupkeep-20260901T030000Z.tar.gz.age, pupkeep-20261001T030000Z.tar.gz.age, pupkeep-20261030T030000Z.tar.gz.age
retention removed remotely: pupkeep-20260901T030000Z.tar.gz.age, pupkeep-20261001T030000Z.tar.gz.age, pupkeep-20261030T030000Z.tar.gz.age
```

| Seeded name | Age at 15:30Z | Local | Remote |
|---|---|---|---|
| `pupkeep-20260901T030000Z` | 80 days | deleted | deleted |
| `pupkeep-20261001T030000Z` | 50 days | deleted | deleted |
| `pupkeep-20261030T030000Z` | 21 days | deleted | deleted |
| `pupkeep-20261119T030000Z` | 1 day | **kept** | **kept** |
| both real archives of this drill | 0 | **kept** | **kept** |

Remote pruning is `rclone lsf` + `rclone delete` per expired name, and it reports
what it deleted rather than doing it silently. The **never-delete-the-newest**
rule cannot be exercised by a live run, because the run's own archive is always
freshest; it was checked against `expiredArchives()` with the drill's choice of
clock, importing the module read-only and touching no archive:

```
all four archives older than the window (the newest is expired too)
  deletes: ["pupkeep-20260901T030000Z.tar.gz.age","pupkeep-20261001T030000Z.tar.gz.age","pupkeep-20261030T030000Z.tar.gz.age"]
a single archive, months old — a host that was off
  deletes: []
boundary: exactly 14 days old is kept, one second older is not
  deletes: ["pupkeep-20261106T152959Z.tar.gz.age"]
```

The newest of an all-expired set survives, a lone old archive survives, and the
cutoff is exact (`entry.time < cutoff`, so 14 days old exactly is kept).

### 7. Two ways this drill was wrong before it was right

1. **A hand-built fixture is not a household.** The first bundle in this drill was
   made from a synthetic SQLite file with a table *named* `pi_durable_metadata`
   but not the harness schema. It backed up, uploaded, restored and passed
   `integrity_check` — and then refused to boot: `refusing to start
   error=could not open the harness: table pi_durable_metadata already exists`.
   That is the fixture's fault, not the job's, and it is why the bundle recorded
   above is one the **app itself** created. The bundle is only as good as the data
   directory; "restored" and "bootable" are two checks, and only the second one
   would have caught this.
2. **`integrity_check` is structural.** The first corruption attempt overwrote 32
   bytes of free space inside a page; the job said `ok` and produced a perfectly
   valid archive — correctly. A database can be damaged in ways that check cannot
   see, so the drill also keeps a restore-and-boot, which is the check that
   matters.

### 8. Defects found

| # | Severity | Defect | File that would need the fix |
|---|---|---|---|
| 1 | low (diagnostics) | A missing `expect` reaches the operator as `could not run expect: spawn expect ENOENT`. `checkBackupTools`' own sentence — "expect is not available (exit N); install it before backing up" — is **unreachable** for a binary that is absent, because the runner rejects the promise on `ENOENT` before it can return an exit code. The run still fails safe (nothing written). | `src/server/backup.ts` — `runCommand` (turn a spawn error into `{code: -1}`) or `checkBackupTools` (catch the rejection) |
| 2 | low (cosmetic) | With no passphrase source the message reads `no backup passphrase: set [redacted] or pass --passphrase-file …` — the log scrubber redacts the **environment variable name**, which is not a secret, so the operator loses the one word that tells them what to set. | `src/server/backup.ts` (`readPassphrase` message) and the rule in `src/shared/redact.ts` |
| 3 | informational | The module's header claims a truncated **upload** "is found now rather than at restore time"; the job verifies the local archive by decrypting it, then runs `rclone copyto` and never re-reads the object. rclone's own checks cover a botched transfer, but nothing re-checks the object at rest. This drill verified size and sha256 by hand. | `src/server/backup.ts` (comment and `backupDataDir`, if the claim is to hold) |

No defect was found in the retention, exclusion, encryption, upload or restore
paths themselves.

### 9. Cleanup

```bash
sudo -n rclone purge pupkeep-oci:pupkeep-backups/drill-<UTCSTAMP>   # both drill prefixes
sudo -n rclone size pupkeep-oci:pupkeep-backups                     # Total objects: 0 (0) / Total size: 0 B
shred -u /tmp/pupkeep-drill/pass ; rm -rf /tmp/pupkeep-drill
```

The bucket is back to `0 objects / 0 B`, the drill passphrase is shredded (it was
generated into a `0600` file outside the data dir and never printed or passed on a
command line), the scratch tree and every archive are gone, no process or port is
left, and `/etc/pupkeep/rclone.conf` was not touched. The one thing that remains
is the `expect` package, recorded in §1.

### What the scrub changed (2026-11-20)

This drill was taken before the backup job began scrubbing the archived
`config.json`, and everything above is kept as it was observed. From 2026-11-20
the encrypted archive carries the household's **identities** — `schemaVersion`, and
for each member the `id`, `role`, `displayName`, `createdAt` and `removedAt` — and
**no credential at all**: `ownerTokenHash` is `null`, every member's `sessions` is
`[]`, and `invites` is `[]`. `push.json` is unchanged: its `vapid` keys and
`subscriptions` are the deliberate exception that lets push survive a restore.
`secrets.json` and `server.log` are still excluded.

The reason is not hygiene. The passphrase deliberately leaves the backup host
(PLAN §7.5), so whoever can open an archive can read everything in it, and an
owner token hash plus a session hash would let them sign in as a caregiver. Worse,
a restore usually lands on a **new** origin: re-arming an owner link or a cookie
taken before the move would hand out trust minted for an address the household no
longer uses (R7, `docs/specs/2026-11-20-hosting-public-https.md`). So the restore
refuses such an archive before it touches the data directory, naming what it found:

```
the archive still carries <what it found>: restoring it would re-arm an old sign-in, so it was refused.
```

A drill against this build must expect:

- **`cmp` on `config.json` fails, by design.** The restored file is the scrubbed
  one; only `pupkeep.sqlite` and `push.json` can be compared byte-wise with the
  source. Member ids, roles and the durable data still match.
- **A fresh owner mint before any sign-in.** `npm run restore` prints that nobody
  can sign in until one is minted. The next launcher start mints one and writes
  `owner-link.txt` (0600); the launcher's `--reissue-owner` mints one explicitly.
  That flag belongs to `bin/pupkeep.js` / `npm start`, **not** to `npm run
  restore`, whose parser rejects it even though its own message names it.
- **Cookies from before the restore are dead**, and so is every session: a
  pre-restore cookie gets 401, and each caregiver signs in again from a new invite.
- **Push subscriptions are the one thing the archive still has and the devices may
  not.** `push.json` survives, but a subscription belongs to the origin it was made
  on; after a restore onto the new origin each device must subscribe again. This
  drill never exercised push after a restore, so read the earlier "subscriptions
  survive" as surviving *in the file*, not as delivering notifications.
- **An archive written by the builds drilled above is refused.** It must be
  rewritten by this build, or its `config.json` credentials removed by hand,
  before `restore` accepts it.

Observations above that no longer reproduce, and why:

| Above | Now |
|---|---|
| §3, the pre-restore cookie → **200, 200, 200** | 401 on all three: the archive carries no sessions |
| §3, "the fix is the order — sign in, then back up, then restore" | no ordering helps: no archive carries a session |
| §5, `config.json` vs the source **byte-identical** (`cmp`) | identical for `push.json` and the database only |
| §5, `session bootstrap created=false` — "it recognised the restored owner" | no restored owner exists; the boot mints a new one |
| §2, the `config.json` 304-byte member, and the archive sizes and sha256s | different bytes: the config is smaller, so every archive is new |

What still holds: the three-member bundle, the age ciphertext, the integrity
check, the durable sequence and the document and task counts, 401 without a
cookie, and retention. **None of this subsection was observed by a run.** It was
read on 2026-11-20 out of `scrubArchivedConfig`, `archivedCredentials`, the
refusal in `restoreDataDir` and the restore CLI's output; a full drill of a
scrubbed archive is still open (P5-02).

[^scrub]: Footnote added 2026-11-20, after the archive scrub. The observation was
    true of the build drilled here and is not what a restored household shows
    now; **What the scrub changed (2026-11-20)** above says what holds.
