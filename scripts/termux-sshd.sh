#!/usr/bin/env bash
# Operator SSH on the host phone, started on demand.
#
# Phase 0 found the trap this script exists for (P0-06): an `sshd_config` with a
# pinned `ListenAddress` is silently wrong on a phone. The tailnet address can
# change, and sshd that starts before Tailscale has an address fails to bind and
# then looks "up" to the operator — the phone was found on the tailnet with sshd
# not listening at all. The old config also bound every interface, which put an
# unauthenticated-until-authorized-keys SSH daemon on the phone's Wi-Fi network.
#
# So this script:
#   * resolves the tailnet address at every start instead of storing one;
#   * writes a config with exactly two `ListenAddress` lines, the tailnet address
#     and loopback — never `0.0.0.0` (PLAN §6.3);
#   * refuses to start, loudly, when Tailscale is not connected, rather than
#     falling back to a wildcard bind;
#   * is idempotent: a running instance is reused while its address is still
#     current, and restarted when the address moved.
#
# It is not the product path. The app is reached over HTTP through the launcher;
# this is how an operator gets a shell back after a Termux kill.
#
# Usage: scripts/termux-sshd.sh        (port 8022, overridable with PUPKEEP_SSH_PORT)

set -euo pipefail

PORT="${PUPKEEP_SSH_PORT:-8022}"
DATA_DIR="${PUPKEEP_DATA_DIR:-$HOME/.pupkeep}"
STATE="${DATA_DIR}/sshd"
CONFIG="${STATE}/sshd_config"
PID_FILE="${STATE}/sshd.pid"
ADDRESS_FILE="${STATE}/address"

die() {
  printf 'termux-sshd: %s\n' "$1" >&2
  exit "${2:-1}"
}

# The phone's tailnet IPv4 address, re-resolved now. Same rule the launcher uses
# (`src/launcher/access.ts`): an address in 100.64.0.0/10 on a `tun*` interface.
# `ip` is preferred when present, `ifconfig` is what P0-03 used and is what a
# stock Termux reliably has.
tailnet_address() {
  local found=""
  # `ip` and `ifconfig` are separate Termux packages and neither is guaranteed, so
  # a tool that is present but blind (no permission, an odd Android build) must not
  # be the last word: try it, and fall back to the other one when it finds nothing.
  if command -v ip >/dev/null 2>&1; then
    found="$(ip -o -4 addr show 2>/dev/null | awk '
      $2 ~ /^tun/ {
        for (i = 1; i <= NF; i++) {
          if ($i != "inet") continue;
          split($(i + 1), parts, "/");
          if (parts[1] ~ /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./) {
            print parts[1];
            exit
          }
        }
      }' || true)"
  fi
  if [ -z "$found" ] && command -v ifconfig >/dev/null 2>&1; then
    found="$(ifconfig 2>/dev/null | awk '
      /^[^[:space:]]/ {
        name = $1
        sub(/:$/, "", name)
      }
      $1 == "inet" && name ~ /^tun/ && $2 ~ /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./ {
        print $2
        exit
      }' || true)"
  fi
  printf '%s\n' "$found"
}

# Is this pid still our sshd? A pid file outlives the process, and Android
# recycles pids, so `kill -0` alone can match an unrelated process — which the
# restart path would then terminate. `src/server/lock.ts` solves the same problem
# in Node by comparing start ticks; here the cheaper check is enough, because a
# wrong answer only ever costs a refused start. Where /proc is unreadable (a
# locked-down Android build) the pid file is trusted rather than guessed at.
pid_is_sshd() {
  local pid="$1" cmdline=""
  [ -r "/proc/${pid}/cmdline" ] || return 0
  cmdline="$(tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true)"
  case "$cmdline" in
    *sshd*) return 0 ;;
    *) return 1 ;;
  esac
}

running_pid() {
  [ -f "$PID_FILE" ] || return 0
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  case "$pid" in
    "" | *[!0-9]*) return 0 ;;
  esac
  if kill -0 "$pid" 2>/dev/null && pid_is_sshd "$pid"; then
    printf '%s\n' "$pid"
  fi
}

command -v sshd >/dev/null 2>&1 || die "sshd is not installed; run: pkg install openssh" 3

address="$(tailnet_address)"
if [ -z "$address" ]; then
  die "Tailscale is not connected, so there is no address to bind. Android does not \
reconnect Tailscale by itself after a reboot (P0-06): open the Tailscale app (or turn on \
Always-on VPN), then run this again. sshd stays off rather than listening on every \
interface." 2
fi

mkdir -p "$STATE"
chmod 700 "$STATE"

# Host keys live in $PREFIX/etc/ssh; -A creates whichever are missing and leaves
# existing ones alone, so this is safe to repeat.
if ! ssh-keygen -A >/dev/null 2>&1; then
  die "could not create the sshd host keys in ${PREFIX:-/data/data/com.termux/files/usr}/etc/ssh" 4
fi

pid="$(running_pid)"
if [ -z "$pid" ] && command -v pgrep >/dev/null 2>&1 && pgrep -x sshd >/dev/null 2>&1; then
  # Something is already listening on 8022 and it is not ours, so our config
  # would fail to bind with a bare "Address already in use". On a phone from the
  # Phase 0 spikes that is usually the old all-interfaces config (P0-06), which
  # must not be left running.
  die "an sshd this script did not start is already running (pgrep -x sshd). If that is the old \
all-interfaces config from P0-06, stop it with 'pkill -x sshd' and run this again." 6
fi
if [ -n "$pid" ]; then
  # The address *and* the port: a run with a different PUPKEEP_SSH_PORT is not
  # the listener that is already up.
  if [ "$(cat "$ADDRESS_FILE" 2>/dev/null || true)" = "$address $PORT" ]; then
    printf 'termux-sshd: already listening on %s:%s (pid %s)\n' "$address" "$PORT" "$pid"
    exit 0
  fi
  # The tailnet address (or the port) moved. The old instance is listening on a
  # stale address; stop it before writing the new config.
  printf 'termux-sshd: the tailnet address or port changed to %s:%s; restarting sshd (pid %s)\n' \
    "$address" "$PORT" "$pid"
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

hostkeys=""
for key in "${PREFIX:-/data/data/com.termux/files/usr}"/etc/ssh/ssh_host_*_key; do
  [ -f "$key" ] || continue
  hostkeys="${hostkeys}HostKey ${key}"$'\n'
done
[ -n "$hostkeys" ] || die "no sshd host keys in ${PREFIX:-/data/data/com.termux/files/usr}/etc/ssh" 4

# umask so a partially written config is never world-readable; the file holds no
# secret, but the directory rule from PLAN §6.3 is the habit worth keeping.
umask 077
tmp="${CONFIG}.new"
cat >"$tmp" <<EOF
# Generated by scripts/termux-sshd.sh on every start — do not edit.
# The tailnet address is resolved each time (P0-06), and listening on every
# interface is not an option (PLAN §6.3).
Port ${PORT}
ListenAddress 127.0.0.1
ListenAddress ${address}
${hostkeys}PidFile ${PID_FILE}
AuthorizedKeysFile ${HOME}/.ssh/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UseDNS no
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
EOF
mv "$tmp" "$CONFIG"

# sshd daemonises, so a zero exit means the fork succeeded — not that the
# listener bound. The pid check below is what distinguishes the two.
if ! sshd -f "$CONFIG"; then
  die "sshd refused to start; the config is ${CONFIG}" 5
fi

# sshd writes its PidFile from the daemonised listener, which can land a moment
# after the parent exits, so give it a short window before deciding it failed.
pid=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  pid="$(running_pid)"
  [ -n "$pid" ] && break
  sleep 0.1
done
[ -n "$pid" ] || die "sshd exited instead of daemonising; the config is ${CONFIG}" 5
printf '%s %s\n' "$address" "$PORT" >"$ADDRESS_FILE"

# Optional extra check: confirm the listener exists when the tool is around.
if command -v ss >/dev/null 2>&1; then
  if ! ss -ltn 2>/dev/null | grep -q "${address}:${PORT}"; then
    printf 'termux-sshd: warning: sshd is running (pid %s) but %s:%s is not listed by ss\n' \
      "$pid" "$address" "$PORT" >&2
  fi
fi

printf 'termux-sshd: listening on %s:%s and 127.0.0.1:%s (pid %s)\n' \
  "$address" "$PORT" "$PORT" "$pid"
printf 'termux-sshd: add the operator key to ~/.ssh/authorized_keys; password auth is off\n'
