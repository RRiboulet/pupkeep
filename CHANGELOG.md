# Changelog

## Unreleased

Fixed:

- **`--rotate` now proves the off-device copy instead of trusting an upload's
  exit code (P6-11 follow-up).** Normal backups already compare the remote
  object's size and sha256 with the verified local archive, but passphrase
  rotation treated `rclone copyto` success as proof. A same-size corrupt object
  could therefore replace the only off-device copy while rotation reported
  success. Every rotated or already-rotated archive uploaded by `--rotate` now
  goes through the same read-back check. A mismatch fails the rotation after the
  local archive has been verified under the new key; re-running finds that local
  archive, uploads it again and verifies the replacement. The regression test
  covers both the corrupt first upload and the successful retry. A real rclone
  remote remains P6-09's host proof.

- **The encrypted archive no longer carries a live credential, and a restore now
  needs a fresh owner mint.** `config.json` inside a bundle is the household's
  identities and nothing that authenticates: `ownerTokenHash` is null, every
  member's `sessions` is empty and `invites` is empty, built field by field rather
  than by deleting keys from a copy so a credential added to `MemberRecord` later
  is not carried into every archive until someone allows it. The reason is that
  the passphrase deliberately leaves the backup host (PLAN §7.5), so whoever can
  open an archive could otherwise sign in as a caregiver — and since a restore
  usually lands on a new origin, an old owner link or cookie would hand out trust
  minted for an address the household no longer uses (R7, P5-02 and P6). `restore`
  refuses a pre-scrub archive before touching the data directory, naming what it
  found; a restored copy prints that nobody can sign in until an owner token is
  minted, which the next launcher start does (`owner-link.txt`, 0600) and
  `--reissue-owner` does explicitly. Cookies and sessions from before the restore
  are dead; push subscriptions still ride in `push.json`, which is the deliberate
  exception that lets them survive. The drills in `docs/backup-drill.md` predate
  the scrub, and that file marks which of their observations no longer reproduce;
  a full drill of a scrubbed archive is still open.

## v0.1.1 — 2026-11-18

Fixed:

- **A backup kill could leave a truncated file wearing the newest name.** The job
  encrypted straight to the final archive name, so a `SIGKILL` during encryption
  left a partial archive that `--verify` (which defaults to the newest) and a
  restore with no `--archive` would both pick, while the older, valid archives sat
  beside it waiting for retention to delete them. P5-02's drill reviewers
  reproduced it with twelve real kills. The cipher now writes `<name>.partial`,
  the archive is decrypted and seq-checked from that name, and only then renamed
  and fsynced; two tests pin it. The same kill also leaves a `.staging-*`
  directory holding the plaintext bundle until the next run sweeps it, which is
  recorded in the runbook as one more reason the job needs a schedule.
- **`restoreDataDir` could name a directory it never created.** Its
  `restore-backup-<stamp>-<pid>` path was assigned before `mkdir`, so a failed
  `mkdir` produced "the previous files are in `<dir>`" about nothing. It is
  assigned only once the directory exists.

## v0.1.0 — 2026-11-17

The first release: one household, two caregivers, one shared agent, running on a
phone. Phase 0's spikes and Phases 1–4 are complete; Phase 5's hardening tasks
are complete except for the device checks listed under **Not proven here**. The
plan ([`docs/PLAN.md`](docs/PLAN.md)) stays the source of truth and every entry
below names its task.

### Added:

- **Setup and the household (P1-08, P1-09, P1-10).** First-run wizard, the
  household document with its timezone confirmed by a real instant, two-member
  invites with one-time codes, session cookies (hashed), and the owner link
  written to `~/.pupkeep/owner-link.txt` at 0600 only when a token is minted.
- **Feeding (P2-01…P2-05).** Meal slots, one-tap logs, "fed by" attribution, the
  other caregiver's live update over SSE, and an append-only history.
- **Walks (P2-06, P2-07).** A server-timestamped walk with exactly one open per
  household, an eight-hour stale rule, one commit per start and per end, and the
  record a caregiver's observations live on.
- **Growth, milestones and showers (P3-01…P3-07).** Weight series with the trend
  copy, the milestone board, and the shower interval pinned across a DST change,
  a month end and a leap day.
- **Calendar and reminders (P4-01…P4-04, P4-11).** Appointments store a wall
  clock plus a zone snapshot and derive the instant on read; reminder tasks are
  armed in the same commit on the hidden system conversation; a daily planner
  plans each household-local day and boot reconciliation repairs a missing or
  terminal planner. The meal schedule is editable from Settings after setup.
- **Notifications (P4-05, P4-06).** A per-intent delivery state, an outbox that
  drains to Web Push with VAPID keys generated once, the category-only titles
  that keep care detail out of a push body, an in-app notification centre with a
  badge, ntfy for the partner's daily path, and the host's Termux:API channel.
- **Approvals and the agent (P4-07).** The agent can propose a schedule change
  and nothing else: a caregiver's confirmation runs the stored action in one
  commit with its own revision check, and a double confirm replays the stored
  result. The Agent screen renders the shared thread, collapsed tool cards and
  the waiting-proposal cards.
- **Models and budget (P4-08).** `secrets.json` is the only credential source, a
  paid model's message is refused verbatim at the monthly cap while a free one
  still runs, and the provider catalog and picker are served by `/api/models/*`.
- **Backup and restore (P1-07).** `npm run backup` bundles SQLite, config and
  push as an encrypted `age` archive with retention; `npm run restore` restores
  one archive with the server stopped. VAPID keys deliberately ride inside the
  archive so push subscriptions survive a restore.
- **The host phone path (P1-13, P5-04).** `scripts/termux-install.sh` installs
  packages (upgrading the index first), pins and checksums cloudflared, verifies
  that the `node` it installed actually runs, and writes the Termux:Boot wrapper
  and the optional supervised operator tunnel; `scripts/termux-boot.sh` writes a
  boot line with the `boot_id`, takes a wake lock and waits for the tailnet;
  `scripts/termux-sshd.sh` binds the tailnet address and loopback only.
- **Access modes (P0-03, P5-01b).** `local`, `lan`, `tailscale` and `cloudflare`,
  each failing closed rather than binding everything, plus the client's polling
  fallback when a quick tunnel cannot carry the SSE stream.

### Fixed:

- **A six-tab bottom nav that no phone could fit (P5-10).** The real-browser
  suite found the row 459 px wide inside every phone viewport, so the sixth tab
  was unreachable. The notification tab now reads "Alerts" with its count in the
  accessible name, and the row shrinks with a scaled font instead of pushing a
  tab off the edge.
- **A reminder that could never fire (P4-10).** The "At the start" offset is the
  appointment's own instant, so a strictly-upcoming rule made the calendar form's
  preset useless; it now fires at the start with a five-minute grace.
- **A stale package index that left `node` unlinkable (P5-04).** On the daily
  phone `pkg install nodejs` fetched 26.13.0 without its `libicu`, and the app
  died on a link error that reads like a broken app. The install script now
  upgrades first and stops on a `node` that cannot run, naming what is left.
- **A tunnel alias that starved the operator tunnel (P5-01b).** ssh applies a
  Host block's `LocalForward` lines to every connection, so one busy port on the
  phone killed the supervised tunnel before it bound; the script now refuses that
  alias and says why.
- **A boot path that ran once (P5-04, P5-01b).** After a reboot, an unready
  Tailscale meant the app never started and nothing retried when the tailnet
  arrived. The boot script now waits for the address (bounded) and starts the app
  the moment it exists.
- **Checkpoints that cost 100× for nothing (P5-07).** A document delta is the
  whole value in this storage, so the old window multiplied disk and cold start
  by 100; `CHECKPOINT_DELTAS` is 1, and feeds and closed walks older than the
  current and previous month move into one committed document per month.
- **Log comments claiming what the code did not (P5-06).** The security review
  turned two prose claims into tests and fixed a docstring that would have made a
  cleanup break the tunnel path silently.

### Maintenance:

- **One process per SQLite file (P1-04, P1-06).** The launcher holds
  `launcher.pid`, the server takes `server.pid` at open, a SIGKILLed launcher's
  detached server keeps serving while a second launcher refuses to become a
  second writer, and both files are cleaned on a clean stop.
- **The devcontainer and CI (P0-05, P1-01, P1-02, P1-12, P5-10).** Node 24, a
  pinned pi package checked by `.devcontainer/check-pi-agent-setup.sh`, and a CI
  workflow that typechecks and runs the whole suite on every pull request.
- **Tests as the contract (P5-01a, P5-06).** A real `SIGKILL` mid-turn and right
  after four write acks, a parked task's `--retry-parked` way out, thirteen
  adversarial security attempts, and a real-browser layout check at four phone
  widths.

### Not proven here, and why:

- **The partner's iPhone (P0-10).** Reach, PWA install, Web Push and ntfy
  receipts on the partner's device were never tested: that is P0-10, carried.
- **A phone reboot recovering by itself (P5-01b).** The wrapper and the tailnet
  wait are verified on the device, but the cell needs one reboot with Android's
  Always-on VPN on to be recorded as a pass.
- **Restore on a clean host (P5-02).** The backup job is measured and the restore
  script is tested, but no clean-host drill has been run, and the Docker fallback
  in this repository is **unbuilt** — there is no Docker daemon in the coding
  container.
- **Two clients at once (P5-03).** The two-caregiver paths are covered by tests
  with two sessions; a real second device was never part of a session.
- **A day-long phone run (P5-05).** Battery, heat and the wake-lock effect are
  unmeasured.
