#!/bin/sh
# Offline behaviour tests for resolve-pi-agent-setup.sh. A fake git keeps the
# test independent of upstream's release schedule and network availability.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0 HUP INT TERM
mkdir -p "$tmp/repo/.devcontainer" "$tmp/bin"
cp "$root/.devcontainer/resolve-pi-agent-setup.sh" "$tmp/repo/.devcontainer/resolve-pi-agent-setup.sh"

cat > "$tmp/bin/git" <<'EOF'
#!/bin/sh
case "${FAKE_GIT_MODE:-tags}" in
tags)
	cat <<'TAGS'
1111111111111111111111111111111111111111	refs/tags/v10.0.0-rc1
2222222222222222222222222222222222222222	refs/tags/v9.1.0
3333333333333333333333333333333333333333	refs/tags/v9.0.0
4444444444444444444444444444444444444444	refs/tags/v2.10.0
5555555555555555555555555555555555555555	refs/tags/not-a-release
TAGS
	;;
empty)
	printf '%s\n' '6666666666666666666666666666666666666666	refs/tags/v10.0.0-rc1'
	;;
fail)
	exit 1
	;;
*) exit 2 ;;
esac
EOF
chmod +x "$tmp/bin/git"

resolver="$tmp/repo/.devcontainer/resolve-pi-agent-setup.sh"
version="$tmp/repo/.devcontainer/pi-agent-setup.version"
resolved="$tmp/repo/.devcontainer/pi-agent-setup.resolved"

printf '%s\n' latest > "$version"
PATH="$tmp/bin:$PATH" FAKE_GIT_MODE=tags sh "$resolver" >/dev/null
[ "$(cat "$resolved")" = v9.1.0 ] || {
	echo 'latest did not select the newest stable semver tag' >&2
	exit 1
}

printf '%s\n' v1.2.3 > "$version"
PATH="$tmp/bin:$PATH" FAKE_GIT_MODE=fail sh "$resolver" >/dev/null
[ "$(cat "$resolved")" = v1.2.3 ] || {
	echo 'an exact pin did not stay offline and deterministic' >&2
	exit 1
}

expect_fail() {
	if PATH="$tmp/bin:$PATH" FAKE_GIT_MODE="$1" sh "$resolver" >/dev/null 2>&1; then
		echo "resolver unexpectedly accepted $2" >&2
		exit 1
	fi
}

printf '%s\n' main > "$version"
expect_fail fail 'an arbitrary branch name'

printf '%s\n' latest > "$version"
expect_fail empty 'a remote with no stable release tag'
expect_fail fail 'an unreachable remote'

printf '%s\n' v1.2 > "$version"
expect_fail fail 'a malformed exact tag'

if find "$tmp/repo/.devcontainer" -name '.pi-agent-setup.resolved.tmp.*' | grep -q .; then
	echo 'resolver left a temporary stamp behind' >&2
	exit 1
fi

printf 'pi-agent-setup resolver: latest, exact, invalid and failure cases passed\n'
