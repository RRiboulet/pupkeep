#!/bin/sh
# Fail when the image's my-agent-setup release policy and this checkout drift.
#
# pi-agent-setup.version is either an exact stable tag or "latest". The
# Dockerfile ARG must name the same policy, the host initialize step must resolve
# it before a devcontainer build, and postCreate must compare the image's actual
# release stamp with that resolution. This check stays offline: it validates the
# wiring, not whichever release happens to be newest upstream today.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version_file="$root/.devcontainer/pi-agent-setup.version"
dockerfile="$root/.devcontainer/Dockerfile"
post_create="$root/.devcontainer/postCreate.sh"
config="$root/.devcontainer/devcontainer.json"
resolver="$root/.devcontainer/resolve-pi-agent-setup.sh"
package_path=/opt/pi-packages/my-agent-setup

fail() {
	printf 'pi-agent-setup pin: %s\n' "$*" >&2
	exit 1
}

[ -f "$version_file" ] || fail "missing $version_file"
want=$(tr -d '[:space:]' < "$version_file")
case "$want" in
latest) ;;
v[0-9]*.[0-9]*.[0-9]*)
	printf '%s\n' "$want" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' ||
		fail "invalid release tag '$want' in $version_file"
	;;
*) fail "expected 'latest' or a stable vX.Y.Z tag in $version_file, got '$want'" ;;
esac

[ -f "$resolver" ] || fail "missing $resolver"
grep -Fxq "ARG PI_AGENT_SETUP_TAG=$want" "$dockerfile" ||
	fail "Dockerfile ARG PI_AGENT_SETUP_TAG does not equal $want"

grep -Fq 'COPY .devcontainer/pi-agent-setup.* /tmp/' "$dockerfile" ||
	fail "Dockerfile does not copy the policy and resolved release into the build"

grep -Fq 'git clone --depth 1 --branch "${setup_tag}"' "$dockerfile" ||
	fail "Dockerfile does not clone the resolved release"

grep -Fq 'ln -sfn "my-agent-setup-${setup_tag}" /opt/pi-packages/my-agent-setup' "$dockerfile" ||
	fail "Dockerfile does not expose the resolved clone at $package_path"

grep -Fq 'printf '\''%s\n'\'' "${setup_tag}" > "/opt/pi-packages/my-agent-setup-${setup_tag}/.pi-agent-setup-tag"' "$dockerfile" ||
	fail "Dockerfile does not stamp the image with the resolved release"

grep -Fxq 'ENV PI_AGENT_SETUP_TAG=${PI_AGENT_SETUP_TAG}' "$dockerfile" ||
	fail "Dockerfile does not export PI_AGENT_SETUP_TAG to the container"

grep -Fxq 'LABEL org.rriboulet.pi-package="${PI_AGENT_SETUP_TAG}"' "$dockerfile" ||
	fail "Dockerfile does not label the image with the release policy"

grep -Fq 'resolve-pi-agent-setup.sh' "$config" ||
	fail "devcontainer.json does not resolve the release in initializeCommand"

grep -Fq "PI_PACKAGE=$package_path" "$post_create" ||
	fail "postCreate does not declare the baked package path"

grep -Fq 'pi-agent-setup.version' "$post_create" ||
	fail "postCreate does not read this checkout's release policy"

grep -Fq 'pi-agent-setup.resolved' "$post_create" ||
	fail "postCreate does not compare the baked release with the resolved stamp"

sh "$root/.devcontainer/resolve-pi-agent-setup.test.sh"

printf 'pi-agent-setup policy %s: resolver, Dockerfile, version file and postCreate agree\n' "$want"
