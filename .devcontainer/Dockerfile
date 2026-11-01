# Pupkeep's development container.
#
# The phone is the runtime; this image is only the coding environment. Nothing
# Android-shaped belongs here — no SDK, no JDK, no Gradle, no rootfs (PLAN §5.1).
# The base tag is the Node 24 line the plan pins; the final RUN proves the tag
# still resolves to Node 24 at build time.

FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm

# cloudflared is pinned by version *and* checksum: the quick tunnel is part of
# the access story (PLAN §6.7), and a moving `latest` download would make a
# rebuild a different binary. Cloudflare publishes the `.deb` per architecture
# with no shared manifest, so each one carries its own SHA-256 (PLAN §5.1).
# The phone uses the arm64 release through its Termux wrapper; this is the
# devcontainer's copy and has to build on both a laptop and an arm64 host.
ARG CLOUDFLARED_VERSION=2026.10.5
ARG CLOUDFLARED_SHA256_AMD64=149d1ec4ac8e58bdbf08a41cc42347da9184d9fb4ef0df6528d75c90a85ac0ed
ARG CLOUDFLARED_SHA256_ARM64=361584f9c6a1af6f9c553011291494b72fb6c887841ce6735dc6df8b6e727e72

# Both `.deb`s exist; anything else fails here rather than at dpkg with a
# confusing message (PLAN §5.1). `dpkg --print-architecture` is the fallback so
# a direct `docker build` without BuildKit's TARGETARCH cannot silently pass.
ARG TARGETARCH
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
        amd64|arm64) echo "cloudflared: ${arch}" ;; \
        *) echo "Pupkeep's devcontainer supports amd64 and arm64; found ${arch}" >&2; exit 1 ;; \
    esac

# gh's token lives on the pi-config volume (see docker-compose.yml), not in this
# image and not on the container-local home, which is discarded on rebuild.
ENV GH_CONFIG_DIR=/home/vscode/.pi/gh
ENV GH_PROMPT_DISABLED=1

USER root

# The base image's uid/gid 1000 is `node` — its own metadata says
# `remoteUser: node`. Compose, devcontainer.json and postCreate all name
# `vscode`, so rename the image's user rather than leave that to the
# common-utils feature; PLAN §5.1 records why a second user cannot do this job
# (uid 1000 is taken, so it lands on 1001 and a bind mount owned by the host's
# 1000 stops being writable). The trap that broke this container is the home:
# `useradd -m` does not adopt a directory that already exists, so a root-owned
# /home/vscode stays root-owned, and VS Code creates ~/.vscode-server as
# `vscode` *before* postCreate can chown anything — "Permission denied".
#
# Renaming keeps the uid, gid, home and ownership. This image's
# docker-entrypoint.sh only runs `exec "$@"`, so no `gosu node` path misses the
# old name, and the assertions below fail the build, not the connection.
# common-utils writes the same sudoers rule when the CLI applies features, but
# the image is started on its own too (`docker compose up` runs no features),
# and the base image's entry names `node`, which stops existing here.
RUN test "$(id -u node)" = "1000" \
    && groupmod --new-name vscode node \
    && usermod --login vscode --home /home/vscode --move-home node \
    && echo 'vscode ALL=(root) NOPASSWD:ALL' > /etc/sudoers.d/vscode \
    && chmod 0440 /etc/sudoers.d/vscode \
    && rm -f /etc/sudoers.d/node \
    && visudo -cf /etc/sudoers \
    && test "$(id -u vscode)" = "1000" \
    && test "$(id -g vscode)" = "1000" \
    && test "$(stat -c %u:%g /home/vscode)" = "1000:1000"

# Host tools PLAN §5.1 names, plus age/expect/tar for the P1-07 backup job and
# its real encryption test. `git` is in the base but is listed here so the image
# does not depend on that detail.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        age ca-certificates curl expect git jq openssl ripgrep rclone sqlite3 sudo tar tmux unzip \
    && rm -rf /var/lib/apt/lists/*

RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
        amd64) sha="${CLOUDFLARED_SHA256_AMD64}" ;; \
        arm64) sha="${CLOUDFLARED_SHA256_ARM64}" ;; \
        *) echo "Pupkeep's devcontainer supports amd64 and arm64; found ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/cloudflared.deb \
        "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}.deb" \
    && echo "${sha}  /tmp/cloudflared.deb" | sha256sum -c - \
    && dpkg -i /tmp/cloudflared.deb \
    && rm -f /tmp/cloudflared.deb \
    && cloudflared --version

# The pi coding agent, exact. The enclosing workspace tracks @latest, but this
# repo pins 1.4.0 (PLAN §5.1) and the devcontainer is the enforcement point.
RUN npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@1.4.0 \
    && test "$(pi --version)" = "1.4.0"

# The github-cli feature installs gh *after* this image. Register gh as git's
# credential helper system-wide now: the token survives in the pi-config volume,
# but ~/.gitconfig is container-local and would be discarded on rebuild, leaving
# a valid token that git cannot use. The empty-value line shadows the helper
# vscode-server installs system-wide, exactly as gh writes it.
RUN git config --system credential.https://github.com.helper '' \
    && git config --system credential.https://github.com.helper '!/usr/bin/gh auth git-credential' \
    && git config --system credential.https://gist.github.com.helper '' \
    && git config --system credential.https://gist.github.com.helper '!/usr/bin/gh auth git-credential'

# /home/vscode/.pi is a named volume. Docker copies the image's contents into a
# fresh volume but not the mount point's own ownership, so the image creates the
# directories pi and gh expect *owned by vscode*: the copy-up then lands
# writable, and postCreate has only the volume root and an older volume's
# leftovers to repair. /tmp/pupkeep-dev is the disposable development database:
# it must not live on the 9p workspace mount (PLAN §5.2).
RUN mkdir -p /home/vscode/.pi/agent /home/vscode/.pi/gh /tmp/pupkeep-dev \
    && chown -R vscode:vscode /home/vscode/.pi /tmp/pupkeep-dev \
    && chmod 700 /tmp/pupkeep-dev

# Stay root: every layer above installs into /usr/local or /etc, and postCreate
# edits the *system* git config with `sudo git config --system`. Who connects is
# devcontainer.json's `remoteUser` and Compose's `user: vscode`; that user now
# exists in this image (renamed above), so nothing here waits on a feature.
WORKDIR /workspace

# PLAN §16 P1-02 asks for the base tag to be verified at build time, not trusted
# from a comment.
RUN test "$(node --version | cut -d. -f1)" = "v24" \
    && node --version \
    && sqlite3 --version \
    && tmux -V \
    && rclone version | sed -n '1p'
