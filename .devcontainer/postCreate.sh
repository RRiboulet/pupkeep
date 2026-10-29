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

# The pi-config volume can arrive root-owned on its first mount. Fix that before
# pi or gh write anything. The image already creates both directories.
sudo chown -R vscode:vscode /home/vscode/.pi
# A bind mount can arrive owned by a host UID that does not match vscode, which
# would make `npm ci` fail on node_modules. Only pay for the recursive chown
# when the checkout is not already writable.
if [ ! -w "$REPO" ]; then
  sudo chown -R vscode:vscode "$REPO"
fi
mkdir -p "$GH_CONFIG_DIR" /tmp/pupkeep-dev
chmod 700 /tmp/pupkeep-dev

# --- .env ------------------------------------------------------------------
# Copy only when absent: a developer's local keys and overrides must survive a
# rebuild. `.env` is gitignored; `.env.example` is the committed template.
if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example (edit it if you need provider keys)"
fi

# --- dependencies, types, tests -------------------------------------------
# No build step: node strips the TypeScript directly. `npm ci` is the same
# command the README gives a human, so a broken lock file fails at create time.
npm ci
npm run typecheck
npm test

# --- tool versions ---------------------------------------------------------
# PLAN §16 P1-02: verify the base tag and the pinned tools at build/create time.
node_major="$(node --version | cut -d. -f1)"
if [ "$node_major" != "v24" ]; then
  echo "Node 24 is required; found $(node --version)" >&2
  exit 1
fi

pi_version="$(pi --version)"
if [ "$pi_version" != "1.4.0" ]; then
  echo "pi 1.4.0 is required; found ${pi_version}" >&2
  exit 1
fi

cloudflared_version="$(cloudflared --version)"
case "$cloudflared_version" in
  *2026.10.5*) ;;
  *)
    echo "cloudflared 2026.10.5 is required; found ${cloudflared_version}" >&2
    exit 1
    ;;
esac

for tool in age expect gh jq openssl rclone rg sqlite3 tar tmux; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing required tool: ${tool}" >&2
    exit 1
  fi
done

echo "node $(node --version) · pi ${pi_version} · ${cloudflared_version}"
echo "sqlite3 $(sqlite3 --version | cut -d' ' -f1) · $(rclone version | sed -n '1p')"

# --- the shared pi package -------------------------------------------------
# The package is NOT declared in this repo's `.pi/settings.json`: when pupkeep
# lives inside a workspace that already loads those extensions, a second
# declaration makes every extension load twice and subagents die on a duplicate
# flag (test/pi-settings.test.ts guards this). A standalone devcontainer still
# wants the package, so install it into the *personal* pi settings, which the
# volume persists. `--local` would write the repo's settings file and is the one
# thing this must never do.
SHARED_PACKAGE_REF="${PUPKEEP_SHARED_PACKAGE_REF:-v1.9.0}"
if pi list 2>/dev/null | grep 'my-agent-setup' >/dev/null; then
  echo "shared pi package already installed; leaving it alone"
elif [ -f .pi/settings.json ] && grep -q '"my-agent-setup"' .pi/settings.json; then
  echo "this project already declares the shared pi package; not installing a second copy"
else
  if pi install "git:github.com/RRiboulet/my-agent-setup@${SHARED_PACKAGE_REF}"; then
    echo "installed the shared pi package at ${SHARED_PACKAGE_REF} into the pi-config volume"
  else
    echo "WARNING: could not install the shared pi package at ${SHARED_PACKAGE_REF}." >&2
    echo "         The app and its tests do not need it; run the command again when online:" >&2
    echo "         pi install git:github.com/RRiboulet/my-agent-setup@${SHARED_PACKAGE_REF}" >&2
  fi
fi

# --- gh and pi authentication ---------------------------------------------
# The Dockerfile registered /usr/bin/gh as git's system credential helper. The
# github-cli feature can install it elsewhere, so pin the helper to the binary
# that is actually present before telling the user to log in.
GH_BIN="$(command -v gh)"
sudo git config --system credential.https://github.com.helper ''
sudo git config --system credential.https://github.com.helper "!${GH_BIN} auth git-credential"
sudo git config --system credential.https://gist.github.com.helper ''
sudo git config --system credential.https://gist.github.com.helper "!${GH_BIN} auth git-credential"

if ! gh auth status >/dev/null 2>&1; then
  cat <<'MSG'

gh is installed but not authenticated. One-time setup, in this terminal:

  gh auth login --hostname github.com --git-protocol https --web

The token is stored in the pi-config volume (GH_CONFIG_DIR), so it survives a
rebuild. git's credential helper is configured system-wide in the image, so
plain `git push` works in a fresh container without a token in .git/config.

MSG
fi

cat <<'MSG'
Pupkeep devcontainer ready. The server currently has only a scaffold listener:
/healthz answers and every other route is 503 until P1-09/P1-10.

  npm start -- --access local --data /tmp/pupkeep-dev

The dev database is /tmp/pupkeep-dev (never the workspace mount). The browser
client, shared thread and HTTP routes are still open tasks.
MSG
