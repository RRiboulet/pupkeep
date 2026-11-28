#!/bin/sh
# Prepare the host-side single source of truth for pi credentials and model
# catalogs. The devcontainer initialize step runs this before Docker reads the
# bind mount, so the source directory always exists with private permissions.
set -eu
umask 077

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
home=${HOME:?HOME must be set}
agent_dir="$home/.pi/agent"
shared_dir="${PI_SHARED_STATE_DIR:-$home/.pi/shared-agent-state}"
seed="$root/.devcontainer/pi/models.json"

fail() {
	printf 'shared pi state: %s\n' "$*" >&2
	exit 1
}

mkdir -p "$agent_dir" "$shared_dir"
chmod 700 "$agent_dir" "$shared_dir"

link_host_file() {
	file=$1
	target="$shared_dir/$file"
	source="$agent_dir/$file"
	tmp="$agent_dir/.$file.link.tmp.$$"
	trap 'rm -f "$tmp"' 0 HUP INT TERM
	ln -s "$target" "$tmp"
	mv -Tf "$tmp" "$source"
	trap - 0 HUP INT TERM
}

for file in auth.json models-store.json models.json; do
	target="$shared_dir/$file"
	source="$agent_dir/$file"

	# A project may ship a static model seed (analytics-agent currently does).
	# Use it only when the host has no independent claim to models.json; an
	# already-populated shared file always wins.
	seed_models=0
	if [ "$file" = models.json ] && [ -f "$seed" ]; then
		if [ ! -e "$source" ] || { [ -L "$source" ] && [ "$(readlink -f "$source" 2>/dev/null || true)" = "$target" ]; }; then
			if [ ! -e "$target" ] || [ "$(tr -d '[:space:]' < "$target")" = '{}' ]; then
				seed_models=1
			fi
		fi
	fi

	if [ ! -e "$target" ]; then
		tmp="$shared_dir/.$file.tmp.$$"
		trap 'rm -f "$tmp"' 0 HUP INT TERM
		if [ -f "$source" ] && [ ! -L "$source" ]; then
			cp -p "$source" "$tmp"
		elif [ "$seed_models" -eq 1 ]; then
			cp "$seed" "$tmp"
		else
			printf '{}\n' > "$tmp"
		fi
		chmod 600 "$tmp"
		mv -f "$tmp" "$target"
		trap - 0 HUP INT TERM
	elif [ "$seed_models" -eq 1 ]; then
		tmp="$shared_dir/.$file.tmp.$$"
		trap 'rm -f "$tmp"' 0 HUP INT TERM
		cp "$seed" "$tmp"
		chmod 600 "$tmp"
		mv -f "$tmp" "$target"
		trap - 0 HUP INT TERM
	fi

	if [ -L "$source" ]; then
		resolved=$(readlink -f "$source" 2>/dev/null || true)
		[ "$resolved" = "$target" ] || fail "$source points somewhere other than $target"
		continue
	fi
	if [ -e "$source" ]; then
		[ -f "$source" ] || fail "$source is not a regular file"
		cmp -s "$source" "$target" || fail "$source disagrees with shared $target; resolve the conflict manually"
	fi
	link_host_file "$file"
done

printf 'shared pi state: %s is authoritative for auth.json, models-store.json and models.json\n' "$shared_dir"
