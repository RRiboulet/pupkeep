#!/usr/bin/env bash
# The host phone's boot script (PLAN §6.3).
#
# Termux:Boot runs everything in ~/.termux/boot at *reboot* — and only then. A
# Termux app kill does not re-run it (P0-06), so this script deliberately does
# not try to be a supervisor: the launcher restarts its own server child and
# keeps the tunnel alive, and `scripts/termux-sshd.sh` is the on-demand path back
# in. Installing the boot wrapper and the optional `sv` unit is
# `scripts/termux-install.sh`'s job; the runbook is docs/PHONE-RUNBOOK.md.
#
# Everything is appended to `~/.pupkeep/server.log`, which is why `--boot`
# matters: a non-TTY stdout never prints the owner token, and the launcher writes
# the owner link to `~/.pupkeep/owner-link.txt` (0600) only when it mints or
# reissues one (PLAN §6.3).

set -euo pipefail

# Termux:Boot runs this with a minimal environment: no PATH, and on the daily
# phone neither PREFIX nor HOME (P5-01b, 2026-11-10 — the boot line was never
# written and the app stayed down after a reboot). Everything below uses all
# three, so establish them before the first use instead of dying with "unbound
# variable". PREFIX is Termux's compile-time prefix for the `com.termux`
# package, not a guess; a fork with another package id passes it in.
: "${PREFIX:=/data/data/com.termux/files/usr}"
: "${HOME:=/data/data/com.termux/files/home}"
export PREFIX HOME
PATH="${PREFIX}/bin:/system/bin:/system/xbin"
export PATH

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${PUPKEEP_DATA_DIR:-$HOME/.pupkeep}"
LOG="${DATA_DIR}/server.log"

mkdir -p "$DATA_DIR"
# The data directory holds the owner link and the database; PLAN §6.3 and P1-05
# keep it at 0700 and the files inside at 0600.
chmod 700 "$DATA_DIR"
: >>"$LOG"
chmod 600 "$LOG"

printf 'boot: %s (boot_id %s)\n' \
  "$(date -Is)" \
  "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf 'unknown')" >>"$LOG"

# The wake lock keeps Android from parking the CPU. P0-06 could only prove the
# command exits 0 — the effect is unobservable from Termux (`dumpsys` is
# blocked), so P5-05 owns the day-long check.
if ! termux-wake-lock >>"$LOG" 2>&1; then
  printf 'boot: termux-wake-lock failed; Android may suspend the server\n' >>"$LOG"
fi

# Operator SSH is not the product path. It needs Tailscale, which does not
# reconnect by itself after a reboot, so a failure here is logged and the app
# still starts — a phone with no operator shell beats a phone with no care app.
#
# The interpreter is passed explicitly: the repo scripts keep a portable
# `#!/usr/bin/env bash` shebang for the devcontainer, and Termux has no
# `/usr/bin/env`, so `exec script` (or running the path directly) fails with
# "bad interpreter: No such file or directory" under a minimal environment.
#
# **The tailnet arrives late, not never.** Android only reconnects Tailscale by
# itself with "Always-on VPN" (P0-06), and even then the interface appears a
# minute or two after boot. This path used to run once, be refused and exit — so
# the 2026-11-16 reboot wrote its boot line and then left the app down until
# somebody typed a command (P5-01b, `docs/kill-restart-matrix.md` cell 4).
# `scripts/termux-sshd.sh` already owns the question: it refuses with **exit 2**
# when there is no tailnet address to bind, before it does anything else. So its
# verdict is the wait condition rather than a second copy of the address logic.
#
# A failure that is *not* exit 2 (openssh missing, a port conflict, a broken
# config) means the tailnet is up and the app can start, which is the old
# "no operator shell beats no care app" rule. The wait is bounded because a
# phone with Always-on VPN off will never get an address until somebody opens
# the app; saying so once, after the wait, is the useful outcome.
TAILNET_WAIT="${PUPKEEP_BOOT_TAILNET_WAIT:-180}"
RETRY_STEP="${PUPKEEP_BOOT_RETRY_STEP:-10}"

start_sshd_when_the_tailnet_arrives() {
  local waited=0 status=0
  while :; do
    status=0
    "${BASH:-${PREFIX}/bin/bash}" "$REPO_ROOT/scripts/termux-sshd.sh" >>"$LOG" 2>&1 || status=$?
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$status" -ne 2 ]; then
      # sshd's own failure, not a missing tailnet: log it and start the app.
      printf 'boot: sshd not started; run scripts/termux-sshd.sh once Tailscale is connected\n' >>"$LOG"
      return 0
    fi
    if [ "$waited" -ge "$TAILNET_WAIT" ]; then
      printf 'boot: no tailnet address after %ss, so the app is not started (--access tailscale cannot work without it). Turn on Tailscale%s Always-on VPN, or open the app, then run this script again.\n' \
        "$TAILNET_WAIT" "'" >>"$LOG"
      return 1
    fi
    sleep "$RETRY_STEP"
    waited=$((waited + RETRY_STEP))
  done
}

if ! start_sshd_when_the_tailnet_arrives; then
  exit 1
fi

cd "$REPO_ROOT"

# `exec` the launcher's *entry point*, not `npm start`. npm would put two
# processes (`npm` and its `sh -c`) between the supervisor and the launcher, so
# `sv down` would signal npm and leave the launcher running — still holding
# `launcher.pid`, so the restart runit performs next is refused as a second
# instance. Exec'ing node makes the supervised pid the lock holder itself, which
# is what §3.2 and `src/server/lock.ts` assume. The flags mirror `npm start`
# (`node --env-file-if-exists=.env bin/pupkeep.js`), so there is still one
# definition of the entry point and no second npm-less variant of the app.
exec "$PREFIX/bin/node" \
  --env-file-if-exists=.env \
  bin/pupkeep.js \
  --access tailscale \
  --boot \
  --data "$DATA_DIR" >>"$LOG" 2>&1
