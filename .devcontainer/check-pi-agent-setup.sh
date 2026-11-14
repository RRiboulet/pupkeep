#!/bin/sh
# Fail when the image's my-agent-setup pin and this checkout's intended pin drift.
#
# The intended pin is .devcontainer/pi-agent-setup.version. The Dockerfile has
# to agree with it twice: its ARG is what the build clones, and its COPY + test
# makes the image build fail if the two ever diverge. postCreate repeats the
# check against the tag baked into the running image, so a repository pin bump
# without a rebuild cannot silently keep the previous release's extensions.
#
# Offline by design: comparing the recorded pin is enough. Fetching the newest
# upstream tag would make this workflow red on someone else's release schedule.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version_file="$root/.devcontainer/pi-agent-setup.version"
dockerfile="$root/.devcontainer/Dockerfile"
post_create="$root/.devcontainer/postCreate.sh"
package_path=/opt/pi-packages/my-agent-setup

fail() {
	printf 'pi-agent-setup pin: %s\n' "$*" >&2
	exit 1
}

[ -f "$version_file" ] || fail "missing $version_file"
want=$(tr -d '[:space:]' < "$version_file")
case "$want" in
v[0-9]*.[0-9]*.[0-9]*) ;;
*) fail "invalid pin '$want' in $version_file" ;;
esac

grep -Fxq "ARG PI_AGENT_SETUP_TAG=$want" "$dockerfile" ||
	fail "Dockerfile ARG PI_AGENT_SETUP_TAG does not equal $want"

grep -Fq 'COPY .devcontainer/pi-agent-setup.version /tmp/pi-agent-setup.version' "$dockerfile" ||
	fail "Dockerfile does not copy pi-agent-setup.version into the build"

grep -Fq 'ln -sfn "my-agent-setup-${PI_AGENT_SETUP_TAG}" /opt/pi-packages/my-agent-setup' "$dockerfile" ||
	fail "Dockerfile does not expose the versioned clone at $package_path"

grep -Fxq 'ENV PI_AGENT_SETUP_TAG=${PI_AGENT_SETUP_TAG}' "$dockerfile" ||
	fail "Dockerfile does not export PI_AGENT_SETUP_TAG to the container"

grep -Fxq 'LABEL org.rriboulet.pi-package="${PI_AGENT_SETUP_TAG}"' "$dockerfile" ||
	fail "Dockerfile does not label the image with the package pin"

grep -Fq "PI_PACKAGE=$package_path" "$post_create" ||
	fail "postCreate does not declare the baked package path"

grep -Fq 'pi-agent-setup.version' "$post_create" ||
	fail "postCreate does not compare the baked tag with this checkout's pin"

printf 'pi-agent-setup pin %s: Dockerfile, version file and postCreate agree\n' "$want"
