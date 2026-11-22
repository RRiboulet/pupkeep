#!/usr/bin/env bash
# Install the host phone (PLAN §6.1), from a checkout that is already on the
# phone. Draft: P1-13 writes it so the runbook has something exact to point at;
# P5-04 polishes it after the release drill.
#
# It is idempotent — running it twice is harmless — and prints no secret. It
# deliberately does not clone the repo, install the Termux:Boot or Termux:API
# companion *apps* (Android has to do that), or start anything: the runbook
# covers first run.
#
# Usage: scripts/termux-install.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${PUPKEEP_DATA_DIR:-$HOME/.pupkeep}"
BOOT_DIR="${HOME}/.termux/boot"
# The operator's VPS, as a `~/.ssh/config` alias. Empty means "no supervised
# tunnel": SSH is not the product path (PLAN §6.3), so this is opt-in.
TUNNEL_HOST=""

step() { printf '\n== %s\n' "$1"; }
note() { printf '   %s\n' "$1"; }
die() {
  printf 'termux-install: %s\n' "$1" >&2
  exit "${2:-1}"
}

case "${1:-}" in
  "") ;;
  -h | --help)
    printf 'Usage: scripts/termux-install.sh [--with-tunnel <ssh-host-alias>]\n'
    exit 0
    ;;
  --with-tunnel)
    [ -n "${2:-}" ] || die "--with-tunnel needs an ssh host alias from ~/.ssh/config (for example: oracle)" 2
    TUNNEL_HOST="$2"
    shift 2
    ;;
  *) die "unknown argument: $1" 2 ;;
esac
case "${1:-}" in
  "") ;;
  *) die "unknown argument: $1" 2 ;;
esac

# --- this script is only meaningful on a phone -------------------------------
[ -n "${PREFIX:-}" ] || die "this script drives Termux; PREFIX is not set. The devcontainer has its own image (PLAN §5)." 1
case "${PREFIX}" in
  /data/data/com.termux/*) ;;
  *) die "PREFIX=${PREFIX} is not a Termux prefix" 1 ;;
esac

# v1 hosts on arm64 Android. A different machine is the VPS/Docker fallback's
# job (PLAN §6.9), not a second host's install path.
case "$(uname -m)" in
  aarch64 | arm64) ;;
  *) die "the host phone is arm64; found $(uname -m). PLAN §6.9 is the fallback for anything else." 1 ;;
esac

step "Termux packages"
# Upgrade before install (P5-01b finding 1, 2026-11-10). That phone's index had
# already been moved by an earlier `pkg update`, so `pkg install nodejs` fetched
# 26.13.0 without the matching libicu and `node` then died with
# `CANNOT LINK EXECUTABLE "node": library "libicui18n.so.79" not found`. The note
# that used to live here asked the operator to upgrade first; a note is not a
# guarantee, and the result reads as a broken app rather than a stale index.
#
# `pkg upgrade` refreshes the index itself (termux-tools' `pkg` runs `apt update`
# before `apt full-upgrade`), so the `pkg update` line is explicit intent rather
# than necessity: it stays because the failure it prevents is this exact one, and
# a change in `pkg` must not be able to bring the trap back silently.
#
# This is the longest step here and the only one that touches the package system,
# so it takes a wake lock first: Android reclaiming Termux mid-transaction leaves
# dpkg half-configured, which is worse than the stale index this repairs.
termux-wake-lock >/dev/null 2>&1 ||
  note "termux-wake-lock unavailable; keep Termux in the foreground until this finishes"
#
# Non-interactive, keeping local config files. `pkg upgrade` is apt underneath and
# otherwise stops on a conffile prompt nobody is at the phone to answer: `confdef`
# answers the "no default action" case, `confold` keeps the installed file. Both
# fail through `die` like every other step, because raw apt output is the least
# diagnosable error this script can produce, and each remedy below is one the
# operator can act on at the phone.
DEBIAN_FRONTEND=noninteractive pkg update ||
  die "pkg update failed: no network, a dpkg lock held by another session, or a broken curl (pkg's mirror probe needs it: pkg install curl)" 4
DEBIAN_FRONTEND=noninteractive pkg upgrade -y \
  -o Dpkg::Options::=--force-confdef \
  -o Dpkg::Options::=--force-confold ||
  die "pkg upgrade failed: no network, a dpkg lock held by another session, or a full disk. If an earlier run was interrupted, run 'dpkg --configure -a'; if the mirror is the problem, 'termux-change-repo'. Nothing below ran." 4

pkg install -y \
  nodejs git curl termux-api sqlite rclone age expect tar termux-services tmux openssh

# Installed is not the same as runnable, and the difference is the trap above, so
# this runs the binary instead of reading the package list — and names the path it
# ran, because on Termux PATH starts with $PREFIX/bin and the name is what makes a
# shim visible. Nothing is written after this point, so a broken upgrade leaves no
# half-configured boot wrapper behind.
node_path="$(command -v node)" ||
  die "node is not on PATH after pkg install: the nodejs package did not install" 1
if ! node_diagnosis="$("${node_path}" --version 2>&1)"; then
  # Deliberately not "run pkg update && pkg upgrade": this run has already done
  # exactly that, so repeating it is the one remedy that cannot help.
  die "${node_path} is installed but does not run:
   ${node_diagnosis}
   The index was updated and upgraded by this run, so a stale index is no longer
   the likely cause. What is left: an interrupted dpkg ('dpkg --configure -a'), a
   nodejs the upgrade held back ('pkg install --reinstall nodejs'), or a mirror
   that failed mid-run ('termux-change-repo'). Nothing below ran." 1
fi
# stdout only: bionic's linker writes its failure to stderr, and a warning on
# stderr must not become the version string this parses.
node_version="$("${node_path}" --version 2>/dev/null)"
[ -n "${node_version}" ] ||
  die "${node_path} --version printed nothing: the nodejs package is broken ('pkg install --reinstall nodejs')" 1

node_major="$(printf '%s' "${node_version}" | cut -d. -f1 | tr -d v)"
case "${node_major}" in
  24 | 26) note "node ${node_version}" ;;
  *)
    # The upgrade above can move Node across majors on its own (P0-01 measured
    # 26.12.1, P5-01b 26.13.0), so this is "the line moved", not "the operator
    # forgot to upgrade".
    die "Node ${node_version} is outside the 24/26 the plan measured (P0-01). The upgrade this script runs can move Node across majors; re-measure this phone's Node before deploying, or pin nodejs back. The app and the boot wrapper were not touched." 1
    ;;
esac

# Android storage permission is a UI dialog; declining it costs nothing, so this
# is not fatal.
termux-setup-storage >/dev/null 2>&1 || note "termux-setup-storage was declined or timed out; not needed by the app"

step "Data directory"
mkdir -p "${DATA_DIR}"
chmod 700 "${DATA_DIR}"
note "${DATA_DIR} (0700)"

step "Application dependencies"
[ -f "${REPO_ROOT}/package-lock.json" ] || die "${REPO_ROOT} is not a Pupkeep checkout" 1
(cd "${REPO_ROOT}" && npm ci --omit=dev)

step "Termux:Boot wrapper"
mkdir -p "${BOOT_DIR}"
# Termux:Boot runs every file in ~/.termux/boot; this is a one-line hop to the
# tracked script so the repo stays the source of truth (PLAN §6.3).
#
# The interpreter is passed explicitly instead of relying on the tracked script's
# shebang: that shebang is `#!/usr/bin/env bash` for the devcontainer's sake, and
# Termux has no `/usr/bin/env`, so an `exec <script>` under Termux:Boot's minimal
# environment dies with "bad interpreter: No such file or directory". That is what
# happened on the daily phone on 2026-11-10 (P5-01b): no boot line, no app.
wrapper="${BOOT_DIR}/pupkeep.sh"
printf '#!/%s/bin/bash\nexec "%s/bin/bash" "%s/scripts/termux-boot.sh"\n' \
  "${PREFIX#/}" "${PREFIX}" "${REPO_ROOT}" >"${wrapper}"
chmod 700 "${wrapper}"
note "${wrapper} -> ${REPO_ROOT}/scripts/termux-boot.sh (via ${PREFIX}/bin/bash)"

if [ -n "${TUNNEL_HOST}" ]; then
  step "Supervised operator tunnel (${TUNNEL_HOST})"
  # `termux-services`' runsvdir watches this directory, so the unit is live as
  # soon as it is written. The tunnel restarts itself with a backoff and checks
  # the operator's ssh config before it binds, so a dead session or a conflicting
  # `RemoteForward` cannot silently strand the port (P5-01b).
  unit="${PREFIX}/var/service/pupkeep-tunnel"
  mkdir -p "${unit}"
  printf '#!/%s/bin/bash\n# Generated by scripts/termux-install.sh — the supervised operator tunnel.\n# Remove the RemoteForward and LocalForward lines from the "%s" block in\n# ~/.ssh/config: this unit owns that remote port now, and a local forward it\n# cannot carry kills it before it binds.\nexec "%s/scripts/termux-tunnel.sh" "%s"\n' \
    "${PREFIX#/}" "${TUNNEL_HOST}" "${REPO_ROOT}" "${TUNNEL_HOST}" >"${unit}/run"
  chmod 700 "${unit}/run"
  # `runsvdir` discards a service's output unless the service has a `log/` child
  # (P5-01b, 2026-11-17: the tunnel lost the remote port to a duplicate for five
  # days and said so only to /dev/null). svlogd keeps the recent lines where the
  # operator looks after a failure, instead of nowhere.
  mkdir -p "${unit}/log" "${PREFIX}/var/log/sv/pupkeep-tunnel"
  printf '#!/%s/bin/bash\nexec "%s/bin/svlogd" "%s/var/log/sv/pupkeep-tunnel"\n' \
    "${PREFIX#/}" "${PREFIX}" "${PREFIX}" >"${unit}/log/run"
  chmod 700 "${unit}/log/run"
  if command -v sv-enable >/dev/null 2>&1; then
    sv-enable pupkeep-tunnel >/dev/null 2>&1 || note "run: sv-enable pupkeep-tunnel"
  fi
  note "${unit}/run (sv status pupkeep-tunnel)"
  note "${PREFIX}/var/log/sv/pupkeep-tunnel/current (the tunnel's last lines)"
fi

step "Done"
cat <<EOF
   Next, from the runbook (docs/PHONE-RUNBOOK.md):
     1. Install the Termux:Boot and Termux:API companion apps from F-Droid.
     2. Termux settings: battery "Unrestricted"; Developer options -> disable
        "child process restrictions" (the Android 12+ phantom-process killer).
     3. First run:  cd ${REPO_ROOT} && npm start -- --access lan --data ${DATA_DIR}
      Keep SSH off the product path: scripts/termux-sshd.sh starts it on demand
      (operator tooling — it needs Tailscale, which the app itself no longer
      uses).
EOF
