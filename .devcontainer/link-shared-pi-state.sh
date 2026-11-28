#!/bin/sh
# Link one container's private pi agent directory to the shared credential and
# model files. Sessions, settings, trust and all other state stay private.
set -eu

agent_dir="${PI_CODING_AGENT_DIR:-/home/vscode/.pi/agent}"
shared_dir="${PI_SHARED_STATE_DIR:-/shared-pi-state}"

fail() {
	printf 'shared pi state: %s\n' "$*" >&2
	exit 1
}

[ -d "$shared_dir" ] || fail "missing shared directory $shared_dir; run the devcontainer initialize step"
mkdir -p "$agent_dir"

for file in auth.json models-store.json models.json; do
	target="$shared_dir/$file"
	link="$agent_dir/$file"
	[ -f "$target" ] || fail "missing shared file $target"

	if [ -L "$link" ]; then
		resolved=$(readlink -f "$link" 2>/dev/null || true)
		[ "$resolved" = "$target" ] || fail "$link points somewhere other than $target"
		continue
	fi
	if [ -e "$link" ]; then
		[ -f "$link" ] || fail "$link is not a regular file"
		backup="$agent_dir/.pre-shared-$file.$(date +%Y%m%d%H%M%S).$$"
		mv "$link" "$backup"
	fi

	tmp="$agent_dir/.$file.link.tmp.$$"
	trap 'rm -f "$tmp"' 0 HUP INT TERM
	ln -s "$target" "$tmp"
	mv -Tf "$tmp" "$link"
	trap - 0 HUP INT TERM
done

printf 'shared pi state: linked auth.json, models-store.json and models.json from %s\n' "$shared_dir"
