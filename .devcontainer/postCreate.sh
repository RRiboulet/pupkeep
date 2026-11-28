#!/usr/bin/env bash
# Container creation for the Pupkeep devcontainer.
#
# This script is deliberately idempotent: it runs on every create, not only the
# first build. It must not clobber `.env`, the repo's `.pi/settings.json`, the
# pi-config volume's settings, or `~/.pupkeep`. It also must not print secrets:
# the owner link, invite codes and provider keys never belong in build output.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/home/vscode/.pi/gh}"

# /home/vscode itself belongs to vscode from the image on (the Dockerfile
# renames the base image's uid-1000 `node` user), so VS Code can create
# ~/.vscode-server before this script runs at all. What Docker still cannot
# promise is the volume: a named volume is created root-owned and the copy-up
# does not carry the mount point's ownership. Create and repair those paths
# before pi or gh write anything; `sudo mkdir` also keeps this working if the
# image ever stops pre-creating them.
sudo mkdir -p "$GH_CONFIG_DIR" /tmp/pupkeep-dev
sudo chown -R vscode:vscode /home/vscode/.pi /tmp/pupkeep-dev
chmod 700 /tmp/pupkeep-dev
# A bind mount can arrive owned by a host UID that does not match vscode, which
# would make `npm ci` fail on node_modules. Only pay for the recursive chown
# when the checkout is not already writable.
if [ ! -w "$REPO" ]; then
  sudo chown -R vscode:vscode "$REPO"
fi

# Auth and model catalogs are shared with the host and every devcontainer;
# sessions, settings and trust remain in this container's private volume.
sh "$REPO/.devcontainer/link-shared-pi-state.sh"

# --- git identity and gh credential helper --------------------------------
# A fresh container has no git identity, and this repo's workflow is commit ->
# push -> PR. This is the owner's public GitHub noreply address, not a secret;
# `git config --global` overrides it for a different author.
git config --global user.name "RRiboulet"
git config --global user.email "122018936+RRiboulet@users.noreply.github.com"

# The Dockerfile registered /usr/bin/gh, but the github-cli feature installs gh
# later and may choose another path. Fix the system helper to the binary that is
# actually present *before* the long npm ci step: an offline create must not
# leave a token in the volume that git cannot use.
GH_BIN="$(command -v gh)"
sudo git config --system credential.https://github.com.helper ''
sudo git config --system credential.https://github.com.helper "!${GH_BIN} auth git-credential"
sudo git config --system credential.https://gist.github.com.helper ''
sudo git config --system credential.https://gist.github.com.helper "!${GH_BIN} auth git-credential"

# --- tmux config ----------------------------------------------------------
# used by pi and its tmux-backed subagents; enables modified Enter keys.
cp "$REPO/.devcontainer/shell/tmux.conf" /home/vscode/.tmux.conf

# --- ssh config for /voice -------------------------------------------------
# ~/.ssh/config is container-local and wiped on rebuild; restore it from the
# persisted template on the pi-config volume so /voice can reach the phone.
# Missing template (fresh volume) is not an error: /voice just stays unusable.
if [ -f /home/vscode/.pi/ssh/config ]; then
  mkdir -p /home/vscode/.ssh
  cp /home/vscode/.pi/ssh/config /home/vscode/.ssh/config
  chmod 600 /home/vscode/.ssh/config
fi

# --- pi configuration -----------------------------------------------------
# Use the same kokomi theme as my-agent-setup/analytics-agent so pi looks
# identical across projects. Select it WITHOUT clobbering the rest of the
# user's settings: the pi-config volume persists across rebuilds.
mkdir -p /home/vscode/.pi/agent/themes
cp "$REPO/.devcontainer/pi/themes/kokomi-theme.json" /home/vscode/.pi/agent/themes/kokomi-theme.json
SETTINGS=/home/vscode/.pi/agent/settings.json
if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
  jq --arg t kokomi-theme '.theme = $t' "$SETTINGS" > "$SETTINGS.tmp" \
    && mv "$SETTINGS.tmp" "$SETTINGS" \
    || echo '{"theme": "kokomi-theme"}' > "$SETTINGS"
else
  echo '{"theme": "kokomi-theme"}' > "$SETTINGS"
fi

# --- review-triage policy ---
# The policy lives on the private volume, not in the image or the clone, so a
# fresh volume — which is what another host gets — would otherwise start from
# the extension's built-in defaults. Seed this checkout's policy when the volume
# has none, and never overwrite it: from then on the file belongs to whoever runs
# the container, and a rebuild must not undo their edit. Validated with jq first
# and installed through a temp file, so a malformed template fails here instead
# of leaving pi with a policy it cannot parse.
AGENT_DIR="${PI_CODING_AGENT_DIR:-/home/vscode/.pi/agent}"
REVIEW_TRIAGE="$AGENT_DIR/review-triage.json"
if [ ! -f "$REVIEW_TRIAGE" ]; then
  if command -v jq >/dev/null 2>&1 \
    && jq -e . "$REPO/.devcontainer/pi/review-triage.json" >/dev/null 2>&1 \
    && jq . "$REPO/.devcontainer/pi/review-triage.json" > "$REVIEW_TRIAGE.tmp" \
    && [ -s "$REVIEW_TRIAGE.tmp" ]; then
    mv "$REVIEW_TRIAGE.tmp" "$REVIEW_TRIAGE"
  else
    rm -f "$REVIEW_TRIAGE.tmp"
    echo "postCreate: could not install $REPO/.devcontainer/pi/review-triage.json into $AGENT_DIR" >&2
    exit 1
  fi
fi

# --- .env ------------------------------------------------------------------
# Copy only when absent: a developer's local keys and overrides must survive a
# rebuild. `.env` is gitignored; `.env.example` is the committed template.
if [ ! -f .env ]; then
  cp .env.example .env
  # .env can hold provider keys; keep it private from the moment it exists.
  chmod 600 .env
  echo "created .env from .env.example (edit it if you need provider keys)"
fi

# --- dependencies, types, tests -------------------------------------------
# No build step: node strips the TypeScript directly. `npm ci` is the same
# command the README gives a human, so a broken lock file fails at create time.
npm ci

# The render checks (test/browser-render.test.ts) need a real Chromium. It is a
# dev dependency's browser in the container cache, not the image, so a rebuild
# does not carry it; `install` is a no-op once it is there. A create that cannot
# download it must still finish: the suite skips those checks rather than
# failing, so this is a warning, not an exit.
if ! npx playwright install --with-deps chromium; then
  echo "warning: no Playwright Chromium installed; the browser render checks will skip" >&2
fi

npm run typecheck
npm test

# --- tool versions ---------------------------------------------------------
# PLAN §16 P1-02: verify the base tag and the pinned tools at build/create time.
for tool in age cloudflared expect gh jq node npm openssl pi rclone rg sqlite3 tar tmux; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing required tool: ${tool}" >&2
    exit 1
  fi
done

node_major="$(node --version | cut -d. -f1)"
if [ "$node_major" != "v24" ]; then
  echo "Node 24 is required; found $(node --version)" >&2
  exit 1
fi

pi_version="$(pi --version)"
if [ "$pi_version" != "1.7.0" ]; then
  echo "pi 1.7.0 is required; found ${pi_version}" >&2
  exit 1
fi

gh_version="$(gh --version | sed -n '1p')"
case "$gh_version" in
  *2.103.2*) ;;
  *)
    echo "gh 2.103.2 is required; found ${gh_version}" >&2
    exit 1
    ;;
esac

cloudflared_version="$(cloudflared --version)"
case "$cloudflared_version" in
  *2026.10.5*) ;;
  *)
    echo "cloudflared 2026.10.5 is required; found ${cloudflared_version}" >&2
    exit 1
    ;;
esac


echo "node $(node --version) · pi ${pi_version} · ${gh_version} · ${cloudflared_version}"
echo "sqlite3 $(sqlite3 --version | cut -d' ' -f1) · $(rclone version | sed -n '1p')"

# --- pi package from the image --------------------------------------------
# The image clones the release resolved from pi-agent-setup.version. An exact
# tag is deterministic; "latest" is resolved by the host initialize step before
# the build, and the generated stamp must match the image's actual release.
# This container only declares that baked copy; it never fetches the package.
PI_PACKAGE=/opt/pi-packages/my-agent-setup
PI_PACKAGE_TAG_FILE="$PI_PACKAGE/.pi-agent-setup-tag"
EXPECTED_TAG="$(tr -d '[:space:]' < "$REPO/.devcontainer/pi-agent-setup.version")"
if [ "$EXPECTED_TAG" = latest ]; then
  RESOLVED_FILE="$REPO/.devcontainer/pi-agent-setup.resolved"
  if [ ! -f "$RESOLVED_FILE" ]; then
    echo "postCreate: missing $RESOLVED_FILE; rebuild through devcontainer so initializeCommand resolves latest" >&2
    exit 1
  fi
  EXPECTED_TAG="$(tr -d '[:space:]' < "$RESOLVED_FILE")"
fi
if [ ! -d "$PI_PACKAGE" ] || [ ! -f "$PI_PACKAGE_TAG_FILE" ]; then
  echo "postCreate: missing baked pi package at $PI_PACKAGE; rebuild the image" >&2
  exit 1
fi
ACTUAL_TAG="$(tr -d '[:space:]' < "$PI_PACKAGE_TAG_FILE")"
if [ "$ACTUAL_TAG" != "$EXPECTED_TAG" ]; then
  echo "postCreate: image carries $ACTUAL_TAG but this checkout resolves $EXPECTED_TAG; rebuild the image (devc rebuild pupkeep)" >&2
  exit 1
fi

# User-level declaration, absolute so the path does not depend on where the
# agent dir lives. Remove any older git clone entry first: two entries would
# load the same extensions twice, and pi exits on the duplicate tools.
jq --arg pkg "$PI_PACKAGE" '
  .packages = (((.packages // [])
    | map(select((if type == "object" then (.source // "") else . end) | tostring | test("my-agent-setup") | not))) + [$pkg])
' "$SETTINGS" > "$SETTINGS.tmp" && [ -s "$SETTINGS.tmp" ] \
  && mv "$SETTINGS.tmp" "$SETTINGS" \
  || { rm -f "$SETTINGS.tmp"; echo "postCreate: could not record $PI_PACKAGE in $SETTINGS" >&2; exit 1; }

# --- gh and pi authentication ---------------------------------------------
if ! gh auth status >/dev/null 2>&1; then
  cat <<'MSG'

gh is installed but not authenticated. One-time setup, in this terminal:

  gh auth login --hostname github.com --git-protocol https --web

The token arrives as GH_TOKEN from the host environment (`~/.config/devc/env`,
sourced by devc), so every container can share the credential without sharing a
volume. git's credential helper is configured system-wide in the image, so
plain `git push` works in a fresh container without a token in .git/config.

MSG
fi

# --- pi model catalogs ---
# The judge the policy names can be newer than the model list pi ships with, so a
# fresh volume does not have it and the judge fails with "not in pi's catalogue"
# until one refresh has run. A container with no network or no provider key must
# still come up usable: hence a warning, not an exit.
MODELS_STORE="$AGENT_DIR/models-store.json"
# A refresh that cannot reach a provider still exits 0 and writes an empty
# catalog, so the exit status alone does not prove the judge is reachable.
# Confirm that the model the policy names is actually in the catalog and say so
# when it is not: the only other symptom is triage quietly falling back to its
# most expensive profile.
JUDGE_PROVIDER="$(jq -r '.judge.provider // empty' "$REVIEW_TRIAGE" 2>/dev/null || true)"
JUDGE_ID="$(jq -r '.judge.model // empty' "$REVIEW_TRIAGE" 2>/dev/null || true)"
if ! pi update --models >/dev/null; then
  echo "postCreate: 'pi update --models' failed; review-triage may not find its judge in the catalog (run it again once this container has network and a provider key)" >&2
elif [ -n "$JUDGE_PROVIDER" ] && [ -n "$JUDGE_ID" ] \
  && ! jq -e --arg p "$JUDGE_PROVIDER" --arg id "$JUDGE_ID" \
    '((.[$p].models) // []) | any(.id == $id)' "$MODELS_STORE" >/dev/null 2>&1; then
  echo "postCreate: the review-triage judge $JUDGE_PROVIDER/$JUDGE_ID is not in the model catalog; supply that provider's key and run 'pi update --models' in this container" >&2
fi

cat <<'MSG'
Pupkeep devcontainer ready. The server currently has only a scaffold listener:
/healthz answers and every other route is 503 until P1-09/P1-10.

  npm start -- --access local --data /tmp/pupkeep-dev

The dev database is /tmp/pupkeep-dev (never the workspace mount). The browser
client, shared thread and HTTP routes are still open tasks.
MSG
