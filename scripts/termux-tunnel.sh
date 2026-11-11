#!/usr/bin/env bash
# The operator's way back onto the phone (PLAN §6.3): sshd plus a **supervised**
# reverse tunnel to the operator's VPS. This is not the product path — the app is
# reached over HTTP through the launcher — it is how a shell comes back after a
# Termux kill, and it is what makes the kill/restart matrix (P5-01b) runnable
# without a human at the phone.
#
# Why this is a script and not a line in the runbook: every failure mode it
# removes is silent, and each one cost an hour of guessing on 2026-11-10.
#
#   * a dead session leaves the VPS's remote port bound, so the *next* tunnel
#     cannot bind it and reports one warning line nobody reads;
#   * a `RemoteForward` in the operator's own `~/.ssh/config` wins the bind for
#     the same reason, and then that interactive session is the tunnel — with
#     whatever target it was written with (`localhost`, i.e. `::1`, while sshd
#     listens on 127.0.0.1: `Connection reset by peer` for every connection);
#   * a reverse tunnel to a loopback sshd that is not listening accepts every
#     connection and resets it, which looks like a network fault and is not one.
#
# So: the config is checked before anything binds, sshd is started (and its own
# refusal — no Tailscale — is what stops us), and the ssh client runs under a
# supervisor that restarts it with a backoff. `sv`/runit is the supervisor:
# `scripts/termux-install.sh --with-tunnel <host>` writes the unit.
#
# Usage:
#   scripts/termux-tunnel.sh <ssh-host-alias> [--port N] [--dry-run]
#
# <ssh-host-alias> is a Host block in `~/.ssh/config` (for example `oracle`).
# The tunnel binds 0.0.0.0:<port> on the VPS and forwards it to this phone's
# loopback sshd, so the operator's machine reaches the phone with
# `ssh -p <port> <phone-user>@<vps>`.

set -euo pipefail

# `sv`/runit and Termux:Boot both start this with a minimal environment; the same
# bootstrap as scripts/termux-boot.sh, for the same reason (P5-01b).
: "${PREFIX:=/data/data/com.termux/files/usr}"
: "${HOME:=/data/data/com.termux/files/home}"
export PREFIX HOME
PATH="${PREFIX}/bin:/system/bin:/system/xbin"
export PATH

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PUPKEEP_SSH_PORT:-8022}"
BACKOFF="${PUPKEEP_TUNNEL_BACKOFF:-10}"
HOST=""
DRY_RUN=0

usage() {
  printf 'usage: %s <ssh-host-alias> [--port N] [--dry-run]\n' "$(basename "$0")" >&2
}

die() {
  printf 'termux-tunnel: %s\n' "$1" >&2
  exit "${2:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || die "--port needs a number" 2
      PORT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1" 2
      ;;
    *)
      [ -z "$HOST" ] || die "only one ssh host alias is accepted; got a second: $1" 2
      HOST="$1"
      shift
      ;;
  esac
done
[ -n "$HOST" ] || {
  usage
  exit 2
}
case "$PORT" in
  "" | *[!0-9]*) die "--port must be a number, got '${PORT}'" 2 ;;
esac

# Preflight 1: the operator's own config must not claim the same remote port.
# `ssh -G` is the effective config, so this sees the Host block, a `Host *` block
# and `Match` alike — no parsing of the file itself.
preflight_ssh_config() {
  local effective conflict app_port_conflict
  effective="$(ssh -G "$HOST" 2>/dev/null || true)"
  conflict="$(printf '%s\n' "$effective" | awk -v port="$PORT" '
    $1 == "remoteforward" {
      split($2, parts, ":")
      if (parts[length(parts)] == port) print "  " $0
    }')"
  if [ -n "$conflict" ]; then
    printf 'termux-tunnel: ~/.ssh/config already forwards remote port %s for %s:\n%s\n' \
      "$PORT" "'$HOST'" "$conflict" >&2
    printf 'termux-tunnel: that session owns the port, so this tunnel cannot bind it —\n' >&2
    printf "termux-tunnel: and if its target is 'localhost' it forwards to ::1 while sshd\n" >&2
    printf 'termux-tunnel: listens on 127.0.0.1, which resets every connection.\n' >&2
    printf 'termux-tunnel: Remove the RemoteForward line from the Host block; this unit owns\n' >&2
    printf 'termux-tunnel: the port now.\n' >&2
    return 3
  fi
  # A `LocalForward` on the app's default port is not fatal — in `tailscale` mode
  # the launcher binds the tailnet address, not loopback — but it collides with a
  # `local`-mode app, and it is the same class of silent surprise.
  app_port_conflict="$(printf '%s\n' "$effective" | awk '
    $1 == "localforward" {
      split($2, parts, ":")
      if (parts[length(parts)] == "8787") print "  " $0
    }')"
  if [ -n "$app_port_conflict" ]; then
    printf 'termux-tunnel: note: ~/.ssh/config also forwards local 8787, which a\n' >&2
    printf 'termux-tunnel: local-mode app binds. Harmless in tailscale mode; it will fail there.\n' >&2
    printf '%s\n' "$app_port_conflict" >&2
  fi
  return 0
}

# Preflight 2: the forward target has to exist. A reverse tunnel to a loopback
# sshd that is not listening accepts every connection and resets it, which reads
# as a network fault and is not one. `termux-sshd.sh` fails closed without a
# tailnet address and says why, so its message is the reason this stops.
preflight_sshd() {
  if ! "${BASH:-${PREFIX}/bin/bash}" "${REPO_ROOT}/scripts/termux-sshd.sh"; then
    printf 'termux-tunnel: sshd is not listening, so the tunnel would accept and reset every\n' >&2
    printf 'termux-tunnel: connection. The message above says why sshd refused; fix that first.\n' >&2
    return 4
  fi
  return 0
}

run_preflight() {
  preflight_ssh_config || return 3
  preflight_sshd || return 4
  return 0
}

SSH_ARGS=(
  -N
  -R "0.0.0.0:${PORT}:127.0.0.1:${PORT}"
  # A stranded port is a loud failure, not a warning nobody reads.
  -o ExitOnForwardFailure=yes
  # Keep the session alive through an Android doze or a flaky mobile link; a
  # silently half-dead session is the state that strands the port.
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
  -o TCPKeepAlive=yes
  "$HOST"
)

if [ "$DRY_RUN" = "1" ]; then
  run_preflight || exit $?
  printf 'ssh'
  for arg in "${SSH_ARGS[@]}"; do
    printf ' %s' "$arg"
  done
  printf '\n'
  exit 0
fi

child=""
stop() {
  # runsv signals this script, not its children: an orphaned ssh would keep the
  # remote port bound and the next start would fail exactly as before.
  if [ -n "$child" ]; then
    kill "$child" 2>/dev/null || true
  fi
  exit 0
}
trap stop TERM INT

# Back off between attempts instead of exiting: runsv restarts a run script with
# no delay, so a preflight that fails (sshd down, port owned, no Tailscale) would
# spin hot until someone looks. Ten seconds of quiet is also what gives a
# conflicting session time to release the port.
pause() {
  sleep "$BACKOFF" &
  child=$!
  wait "$child" 2>/dev/null || true
  child=""
}

last_failure=""
while :; do
  # The preflights print to stderr; capture it so a standing failure is reported
  # once and then quietly retried, instead of writing the same paragraph every
  # ten seconds for a day.
  output="$(run_preflight 2>&1)" && status=0 || status=$?
  if [ "$status" -ne 0 ]; then
    if [ "$output" != "$last_failure" ]; then
      printf '%s\n' "$output" >&2
      last_failure="$output"
    fi
    pause
    continue
  fi
  last_failure=""
  printf 'termux-tunnel: connecting to %s (remote 0.0.0.0:%s)\n' "$HOST" "$PORT"
  ssh "${SSH_ARGS[@]}" &
  child=$!
  wait "$child" || printf 'termux-tunnel: the tunnel exited; retrying in %ss\n' "$BACKOFF"
  child=""
  pause
done
