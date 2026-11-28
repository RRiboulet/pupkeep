#!/bin/sh
# Resolve the my-agent-setup release used by this devcontainer build.
#
# pi-agent-setup.version is either an exact stable tag or "latest". For
# "latest", resolve the newest stable vX.Y.Z tag on origin and record it in a
# generated file. The Dockerfile copies that file, so a changed resolution
# invalidates the cached clone layer on the next rebuild. Exact pins stay
# offline and deterministic.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version_file="$root/.devcontainer/pi-agent-setup.version"
resolved_file="$root/.devcontainer/pi-agent-setup.resolved"
url=https://github.com/RRiboulet/my-agent-setup.git

fail() {
	printf 'pi-agent-setup resolve: %s\n' "$*" >&2
	exit 1
}

[ -f "$version_file" ] || fail "missing $version_file"
want=$(tr -d '[:space:]' < "$version_file")
case "$want" in
latest)
	tag=$(git ls-remote --tags --refs --sort=-v:refname "$url" |
		awk -F 'refs/tags/' '$2 ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/ { print $2; exit }')
	[ -n "$tag" ] || fail "no stable vX.Y.Z release tag found at $url"
	;;
v[0-9]*.[0-9]*.[0-9]*)
	printf '%s\n' "$want" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' ||
		fail "invalid release tag '$want' in $version_file"
	tag=$want
	;;
*) fail "expected 'latest' or a stable vX.Y.Z tag in $version_file, got '$want'" ;;
esac

tmp="$root/.devcontainer/.pi-agent-setup.resolved.tmp.$$"
trap 'rm -f "$tmp"' 0 HUP INT TERM
printf '%s\n' "$tag" > "$tmp"
mv -f "$tmp" "$resolved_file"
printf 'pi-agent-setup: %s -> %s\n' "$want" "$tag"
