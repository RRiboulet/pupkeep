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

# cloudflared is not in the Termux package repo (P0-03). The arm64 release
# binary is pinned by version *and* checksum, the same discipline the
# devcontainer uses (PLAN §5.1), because the quick tunnel is part of the access
# story and a moving download would silently be a different binary.
CLOUDFLARED_VERSION=2026.10.5
CLOUDFLARED_SHA256_ARM64=72e0d05a67e09da87cf495e409a28c3cc5994dd23fc66a982eebea6a55923b7d

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${PUPKEEP_DATA_DIR:-$HOME/.pupkeep}"
BOOT_DIR="${HOME}/.termux/boot"

step() { printf '\n== %s\n' "$1"; }
note() { printf '   %s\n' "$1"; }
die() {
  printf 'termux-install: %s\n' "$1" >&2
  exit "${2:-1}"
}

case "${1:-}" in
  "") ;;
  -h | --help)
    printf 'Usage: scripts/termux-install.sh\n'
    exit 0
    ;;
  *) die "unknown argument: $1" 2 ;;
esac

# --- this script is only meaningful on a phone -------------------------------
[ -n "${PREFIX:-}" ] || die "this script drives Termux; PREFIX is not set. The devcontainer has its own image (PLAN §5)." 1
case "${PREFIX}" in
  /data/data/com.termux/*) ;;
  *) die "PREFIX=${PREFIX} is not a Termux prefix" 1 ;;
esac

# v1 hosts on arm64 Android. A different machine is the VPS/Docker fallback's
# job (PLAN §6.9), not a second cloudflared pin nobody tests.
case "$(uname -m)" in
  aarch64 | arm64) ;;
  *) die "the host phone is arm64; found $(uname -m). PLAN §6.9 is the fallback for anything else." 1 ;;
esac

step "Termux packages"
note "cloudflared is NOT in the Termux repo (P0-03); the pinned arm64 binary below replaces it."
note "pkg update && pkg upgrade first if this Termux has not been updated (PLAN §6.1);"
note "the upgrade is left to the operator because it can prompt about config files."
pkg install -y \
  nodejs git curl termux-api sqlite rclone age expect tar termux-services tmux openssh

node_major="$(node --version | cut -d. -f1 | tr -d v)"
case "${node_major}" in
  24 | 26) note "node $(node --version)" ;;
  *) die "Node ${node_major}: the plan measures 24 (devcontainer) and 26 (phone, P0-01); upgrade nodejs first" 1 ;;
esac

# Android storage permission is a UI dialog; declining it costs nothing, so this
# is not fatal.
termux-setup-storage >/dev/null 2>&1 || note "termux-setup-storage was declined or timed out; not needed by the app"

step "Data directory"
mkdir -p "${DATA_DIR}" "${DATA_DIR}/bin"
chmod 700 "${DATA_DIR}"
note "${DATA_DIR} (0700)"

step "cloudflared ${CLOUDFLARED_VERSION} (arm64, checksum pinned)"
BIN="${DATA_DIR}/bin/cloudflared"
if [ -f "${BIN}" ] && [ "$(sha256sum "${BIN}" | cut -d' ' -f1)" = "${CLOUDFLARED_SHA256_ARM64}" ]; then
  note "already installed and matching"
else
  tmp="${BIN}.partial"
  # PLAN §6.7: this binary only runs through the termux-chroot + SSL_CERT_FILE
  # wrapper; the launcher builds that command, nobody spawns it by hand.
  curl -fsSL -o "${tmp}" \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64"
  printf '%s  %s\n' "${CLOUDFLARED_SHA256_ARM64}" "${tmp}" | sha256sum -c - >/dev/null ||
    die "the cloudflared download did not match ${CLOUDFLARED_VERSION}'s arm64 checksum" 3
  chmod 755 "${tmp}"
  mv "${tmp}" "${BIN}"
  note "installed ${BIN}"
fi

step "Application dependencies"
[ -f "${REPO_ROOT}/package-lock.json" ] || die "${REPO_ROOT} is not a Pupkeep checkout" 1
(cd "${REPO_ROOT}" && npm ci --omit=dev)

step "Termux:Boot wrapper"
mkdir -p "${BOOT_DIR}"
# Termux:Boot runs every file in ~/.termux/boot; this is a one-line hop to the
# tracked script so the repo stays the source of truth (PLAN §6.3).
wrapper="${BOOT_DIR}/pupkeep.sh"
printf '#!/data/data/com.termux/files/usr/bin/bash\nexec "%s/scripts/termux-boot.sh"\n' \
  "${REPO_ROOT}" >"${wrapper}"
chmod 700 "${wrapper}"
note "${wrapper} -> ${REPO_ROOT}/scripts/termux-boot.sh"

step "Done"
cat <<EOF
   Next, from the runbook (docs/PHONE-RUNBOOK.md):
     1. Install the Termux:Boot and Termux:API companion apps from F-Droid.
     2. Termux settings: battery "Unrestricted"; Developer options -> disable
        "child process restrictions" (the Android 12+ phantom-process killer).
     3. Tailscale: sign in, then enable Android "Always-on VPN" for it — the
        client does not reconnect by itself after a reboot (P0-06).
     4. First run:  cd ${REPO_ROOT} && npm start -- --access tailscale --data ${DATA_DIR}
        Keep SSH off the product path: scripts/termux-sshd.sh starts it on demand.
EOF
