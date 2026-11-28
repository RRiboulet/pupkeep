#!/bin/sh
# Offline tests for shared pi auth/model state. No real credential file is read.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0 HUP INT TERM
home="$tmp/home"
repo="$tmp/repo"
agent="$home/.pi/agent"
shared="$home/.pi/shared-agent-state"
mkdir -p "$agent" "$repo/.devcontainer/pi"
cp "$root/.devcontainer/setup-shared-pi-state.sh" "$repo/.devcontainer/setup-shared-pi-state.sh"
cp "$root/.devcontainer/link-shared-pi-state.sh" "$repo/.devcontainer/link-shared-pi-state.sh"

printf '%s\n' '{"openrouter":{"type":"api_key","key":"fake-host-key"}}' > "$agent/auth.json"
printf '%s\n' '{"openrouter":{"models":[]}}' > "$agent/models-store.json"
printf '%s\n' '{"providers":{"seed":{"models":[]}}}' > "$repo/.devcontainer/pi/models.json"
chmod 600 "$agent/auth.json" "$agent/models-store.json"

HOME="$home" sh "$repo/.devcontainer/setup-shared-pi-state.sh" >/dev/null
[ "$(stat -c %a "$shared")" = 700 ] || { echo 'shared directory mode is not 700' >&2; exit 1; }
for file in auth.json models-store.json models.json; do
	[ -L "$agent/$file" ] || { echo "$file was not linked on the host" >&2; exit 1; }
	[ "$(readlink -f "$agent/$file")" = "$shared/$file" ] || { echo "$file points at the wrong shared file" >&2; exit 1; }
	[ "$(stat -c %a "$shared/$file")" = 600 ] || { echo "$file mode is not 600" >&2; exit 1; }
done
[ "$(cat "$shared/models.json")" = '{"providers":{"seed":{"models":[]}}}' ] || {
	echo 'the project model seed was not used when the host had no models.json' >&2
	exit 1
}

# If another project's initialize step creates an empty shared catalog first,
# a later project seed may fill it, but a populated shared catalog never changes.
second_home="$tmp/second-home"
second_agent="$second_home/.pi/agent"
second_repo="$tmp/second-repo"
mkdir -p "$second_agent" "$second_repo/.devcontainer"
cp "$root/.devcontainer/setup-shared-pi-state.sh" "$second_repo/.devcontainer/setup-shared-pi-state.sh"
HOME="$second_home" sh "$second_repo/.devcontainer/setup-shared-pi-state.sh" >/dev/null
[ "$(tr -d '[:space:]' < "$second_home/.pi/shared-agent-state/models.json")" = '{}' ] || {
	echo 'a host without a model seed did not get an empty shared catalog' >&2
	exit 1
}
mkdir -p "$second_repo/.devcontainer/pi"
cp "$repo/.devcontainer/pi/models.json" "$second_repo/.devcontainer/pi/models.json"
HOME="$second_home" sh "$second_repo/.devcontainer/setup-shared-pi-state.sh" >/dev/null
[ "$(cat "$second_home/.pi/shared-agent-state/models.json")" = '{"providers":{"seed":{"models":[]}}}' ] || {
	echo 'a later project seed did not fill an empty shared catalog' >&2
	exit 1
}

# A second run converges without replacing the shared source of truth.
printf '%s\n' '{"openrouter":{"type":"api_key","key":"fake-refreshed-key"}}' > "$shared/auth.json"
HOME="$home" sh "$repo/.devcontainer/setup-shared-pi-state.sh" >/dev/null
[ "$(cat "$shared/auth.json")" = '{"openrouter":{"type":"api_key","key":"fake-refreshed-key"}}' ] || {
	echo 'a repeated setup overwrote the shared credential' >&2
	exit 1
}

# A regular host file that disagrees with the shared source is ambiguous and
# must be refused rather than silently winning or losing.
rm "$agent/auth.json"
printf '%s\n' '{"conflict":true}' > "$agent/auth.json"
if HOME="$home" sh "$repo/.devcontainer/setup-shared-pi-state.sh" >/dev/null 2>&1; then
	echo 'setup accepted a conflicting regular host auth.json' >&2
	exit 1
fi

# Container linking keeps unrelated private state, backs up an existing private
# credential, and is idempotent on the second run.
container_agent="$tmp/container-agent"
container_shared="$tmp/container-shared"
mkdir -p "$container_agent" "$container_shared"
for file in auth.json models-store.json models.json; do
	printf '%s\n' '{}' > "$container_shared/$file"
	printf '%s\n' '{"private":true}' > "$container_agent/$file"
done
printf '%s\n' '{"theme":"private"}' > "$container_agent/settings.json"
PI_CODING_AGENT_DIR="$container_agent" PI_SHARED_STATE_DIR="$container_shared" \
	sh "$repo/.devcontainer/link-shared-pi-state.sh" >/dev/null
for file in auth.json models-store.json models.json; do
	[ -L "$container_agent/$file" ] || { echo "container $file was not linked" >&2; exit 1; }
	[ "$(readlink -f "$container_agent/$file")" = "$container_shared/$file" ] || { echo "container $file points at the wrong file" >&2; exit 1; }
done
[ "$(cat "$container_agent/settings.json")" = '{"theme":"private"}' ] || { echo 'private settings were changed' >&2; exit 1; }
[ "$(find "$container_agent" -maxdepth 1 -name '.pre-shared-auth.json.*' | wc -l)" -eq 1 ] || {
	echo 'the existing private auth.json was not backed up exactly once' >&2
	exit 1
}
PI_CODING_AGENT_DIR="$container_agent" PI_SHARED_STATE_DIR="$container_shared" \
	sh "$repo/.devcontainer/link-shared-pi-state.sh" >/dev/null
[ "$(find "$container_agent" -maxdepth 1 -name '.pre-shared-auth.json.*' | wc -l)" -eq 1 ] || {
	echo 'repeated container linking created another backup' >&2
	exit 1
}

if PI_CODING_AGENT_DIR="$container_agent" PI_SHARED_STATE_DIR="$tmp/missing-shared" \
	sh "$repo/.devcontainer/link-shared-pi-state.sh" >/dev/null 2>&1; then
	echo 'container linking accepted a missing shared directory' >&2
	exit 1
fi

printf 'shared pi state: migration, seed, idempotency, conflict and linking tests passed\n'
