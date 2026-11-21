#!/usr/bin/env bash
# Pupkeep's daily self-report (R8): one line to a deployment-level ntfy topic.
#
# Installed as /usr/local/bin/pupkeep-report by deploy/README.md step 7 and run
# by pupkeep-report.timer. The unit deliberately does the *probing* here on the
# host, not in a container: the Caddy image ships no `openssl`, and a probe of
# the TLS terminator from inside its own host proves less than one from here.
#
# Configuration: /etc/pupkeep/report.env (root, 0600; the mode is enforced below),
# one KEY=value per line. It is read, not sourced: a syntax error in a sourced
# file is echoed by bash with the offending line — which is the topic — and a
# config file has no business running code as root anyway.
#   PUPKEEP_REPORT_TOPIC=<required; >=128 bits of entropy, [A-Za-z0-9_-]>
#   PUPKEEP_REPORT_ORIGIN=https://<the one name>   (required; README step 3)
#   PUPKEEP_REPORT_NTFY=https://ntfy.sh            (optional, this default)
#
# What it measures (R8) and where each number comes from:
#   cert       days until the certificate expires, probed with s_client
#   disk       free/used on the data filesystem
#   containers docker compose ps: state and health, so "both healthy" is real
#   archive    hours since the newest *.age in <data>/backups
#   auth_fail  `a request was refused status=401` lines in the last 24 h
#   rate429    `a credential attempt was rate limited` lines in the last 24 h
# The two counts read the container's capped json-file log (10 MB x 3, R8), so
# on a very noisy day they describe as far back as the cap reaches. The line
# still arrives; a marker of "unknown" means a probe failed, which is itself
# worth seeing rather than silently omitting the field.
#
# The topic is this channel's bearer secret. It never appears in this script's
# argv, in curl's argv, in the report line or in an error message: `ps` shows
# arguments to every local user, and systemd copies ExecStart into the journal.
# The URL that carries the topic reaches curl through stdin (`-K -`).

set -euo pipefail

ENV_FILE="${PUPKEEP_REPORT_ENV:-/etc/pupkeep/report.env}"
PROJECT_DIR="${PUPKEEP_PROJECT_DIR:-/srv/pupkeep}"
DATA_DIR="${PUPKEEP_REPORT_DATA:-/srv/pupkeep/data}"

die() {
  printf 'pupkeep-report: %s\n' "$1" >&2
  exit "${2:-1}"
}

[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE (root, 0600); see deploy/README.md step 3" 78

# The topic is a bearer secret, so a file another local user can read is a
# configuration failure, not a warning. `stat -L` follows a symlink the operator
# may have used to put the file on another filesystem.
mode="$(stat -Lc '%a' "$ENV_FILE")" || die "cannot stat $ENV_FILE; see deploy/README.md step 3" 78
if (( 8#$mode & 077 )); then
  die "$ENV_FILE is mode $mode; the report topic is a bearer secret. chmod 0600 $ENV_FILE" 78
fi

report_topic=""
report_origin=""
report_ntfy=""
lineno=0
while IFS='=' read -r key value || [ -n "${key:-}" ]; do
  lineno=$((lineno + 1))
  key="${key%$'\r'}"   # tolerate a CRLF editor on both sides of the '='
  value="${value%$'\r'}"
  case "$key" in
    PUPKEEP_REPORT_TOPIC) report_topic="$value" ;;
    PUPKEEP_REPORT_ORIGIN) report_origin="$value" ;;
    PUPKEEP_REPORT_NTFY) report_ntfy="$value" ;;
    '' | '#'*) : ;;
    *) die "unrecognised directive on line $lineno of $ENV_FILE; only KEY=value lines for PUPKEEP_REPORT_TOPIC, PUPKEEP_REPORT_ORIGIN and PUPKEEP_REPORT_NTFY are read" 78 ;;
  esac
done <"$ENV_FILE"

# The file is the only source: drop any exported copy a caller left behind, so
# no child inherits the topic. The parsed values are lowercase shell variables
# and are never exported.
unset PUPKEEP_REPORT_TOPIC PUPKEEP_REPORT_ORIGIN PUPKEEP_REPORT_NTFY

# Name the missing key and the file, never a value: a half-written report.env is
# the common failure after a rotation, and the error belongs in the journal
# without the secret it is complaining about.
[ -n "$report_topic" ] || die "PUPKEEP_REPORT_TOPIC is missing or empty in $ENV_FILE; write 'PUPKEEP_REPORT_TOPIC=<topic>' there (deploy/README.md step 3)" 78
[ -n "$report_origin" ] || die "PUPKEEP_REPORT_ORIGIN is missing or empty in $ENV_FILE; it is the name the certificate is probed on (deploy/README.md steps 3-4)" 78
report_ntfy="${report_ntfy:-https://ntfy.sh}"

# ntfy topic names are [A-Za-z0-9_-]; anything else could change the URL's path
# or the curl config below, so it is refused rather than pasted in.
case "$report_topic" in
  *[!A-Za-z0-9_-]*) die "PUPKEEP_REPORT_TOPIC in $ENV_FILE has characters outside [A-Za-z0-9_-]; generate it as deploy/README.md step 3 does" 78 ;;
esac

COMPOSE=()
if DOCKER="$(command -v docker)"; then
  # PATH, not a hardcoded /usr/bin/docker: the report must still work when the
  # CLI lives elsewhere, and it has to be runnable from a shell for testing.
  COMPOSE=("$DOCKER" compose -f "${PROJECT_DIR}/docker-compose.yml")
fi

# The origin is the only place the host name comes from; strip the scheme, any
# path and any port for s_client's -servername.
host="${report_origin#*://}"
host="${host%%/*}"
host="${host%%:*}"

# --- certificate ------------------------------------------------------------
cert=unknown
if command -v openssl >/dev/null 2>&1; then
  end="$(openssl s_client -servername "$host" -connect "$host:443" </dev/null 2>/dev/null |
    openssl x509 -noout -enddate 2>/dev/null | sed -n 's/^notAfter=//p')" || end=""
  if [ -n "${end:-}" ]; then
    expiry="$(date -u -d "$end" +%s 2>/dev/null)" || expiry=""
    if [ -n "$expiry" ]; then
      days=$(((expiry - $(date -u +%s)) / 86400))
      [ "$days" -ge 0 ] || days=0
      cert="${days}d"
    fi
  fi
fi

# --- disk -------------------------------------------------------------------
disk="$(df -P -BG "$DATA_DIR" 2>/dev/null | awk 'NR == 2 { printf "%s free (%s used)", $4, $5 }')" || disk=""
disk="${disk:-unknown}"

# --- containers -------------------------------------------------------------
containers=unknown
if [ "${#COMPOSE[@]}" -gt 0 ]; then
  # A `ps` that fails (docker down, wrong project) is "unknown", not "none":
  # the difference is the whole point of the report.
  if out="$("${COMPOSE[@]}" ps --format '{{.Service}}={{.State}}/{{.Health}}' 2>/dev/null |
    sed -e 's|/$||' | paste -sd, -)"; then
    containers="${out:-none}"
  fi
fi

# --- newest archive ---------------------------------------------------------
archive=unknown
newest="$(find "$DATA_DIR/backups" -maxdepth 1 -type f -name '*.age' -printf '%T@\n' 2>/dev/null |
  sort -n | tail -n 1)" || newest=""
if [ -n "${newest:-}" ]; then
  seconds=$(($(date -u +%s) - ${newest%.*}))
  [ "$seconds" -ge 0 ] || seconds=0
  archive="$((seconds / 3600))h"
fi

# --- last 24 h auth counts --------------------------------------------------
auth_fail=unknown
rate_limited=unknown
if [ "${#COMPOSE[@]}" -gt 0 ]; then
  # One pass over the (capped) log rather than holding 30 MB in a variable.
  if counts="$("${COMPOSE[@]}" logs --since 24h --no-log-prefix pupkeep 2>/dev/null |
    awk '/a request was refused status=401/ { failed++ }
         /a credential attempt was rate limited/ { limited++ }
         END { printf "%d %d", failed + 0, limited + 0 }')"; then
    read -r auth_fail rate_limited <<<"$counts"
  fi
fi

line="pupkeep ${host} cert=${cert} disk=${disk} containers=${containers} archive=${archive} auth_fail=${auth_fail} rate429=${rate_limited}"
printf '%s\n' "$line"

# The URL carries the topic, and a URL on curl's command line is visible in
# `ps` to every local user — the topic-in-argv finding, one process deeper.
# Feed curl its config on stdin instead: the URL then exists only in the
# heredoc, and the topic stays in this shell's memory. No `-S`: curl's own
# message is not worth the risk of echoing a URL that contains the topic.
ntfy_url="${report_ntfy%/}/${report_topic}"
if ! curl -fs -m 15 -o /dev/null -K - \
  -H 'Title: pupkeep daily report' --data-binary "$line" <<EOF
url = "$ntfy_url"
EOF
then
  die "the ntfy push failed (topic redacted; check /etc/pupkeep/report.env and egress)"
fi
