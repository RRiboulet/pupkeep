# Pupkeep's development container.
#
# The phone is the runtime; this image is only the coding environment. Nothing
# Android-shaped belongs here — no SDK, no JDK, no Gradle, no rootfs (PLAN §5.1).
# The base tag is the Node 24 line the plan pins; the final RUN proves the tag
# still resolves to Node 24 at build time.

FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm

# cloudflared is pinned by version *and* checksum: the quick tunnel is part of
# the access story (PLAN §6.7), and a moving `latest` download would make a
# rebuild a different binary. This is the amd64 build for the devcontainer; the
# phone uses the arm64 binary through its Termux wrapper.
ARG CLOUDFLARED_VERSION=2026.10.5
ARG CLOUDFLARED_SHA256=149d1ec4ac8e58bdbf08a41cc42347da9184d9fb4ef0df6528d75c90a85ac0ed

# The release .deb is amd64. Fail with a clear message on another architecture
# instead of letting dpkg produce a confusing one (PLAN §5.1).
ARG TARGETARCH
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    if [ "$arch" != "amd64" ]; then \
        echo "Pupkeep's devcontainer is amd64 (PLAN §5.1); found ${arch}" >&2; \
        exit 1; \
    fi

# gh's token lives on the pi-config volume (see docker-compose.yml), not in this
# image and not on the container-local home, which is discarded on rebuild.
ENV GH_CONFIG_DIR=/home/vscode/.pi/gh
ENV GH_PROMPT_DISABLED=1

USER root

# Host tools PLAN §5.1 names, plus age/expect/tar for the P1-07 backup job and
# its real encryption test. `git` is in the base but is listed here so the image
# does not depend on that detail.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        age ca-certificates curl expect git jq openssl ripgrep rclone sqlite3 sudo tar tmux unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/cloudflared.deb \
        "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb" \
    && echo "${CLOUDFLARED_SHA256}  /tmp/cloudflared.deb" | sha256sum -c - \
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

# /home/vscode/.pi is a named volume; on first creation it can arrive root-owned.
# Create the directories this image owns and hand the volume to vscode before
# postCreate runs. /tmp/pupkeep-dev is the disposable development database: it
# must not live on the 9p workspace mount (PLAN §5.2).
RUN mkdir -p /home/vscode/.pi/agent /home/vscode/.pi/gh /tmp/pupkeep-dev \
    && chmod 700 /tmp/pupkeep-dev

# Do NOT switch to `vscode` here: the base image does not create that user, and
# the common-utils feature creates it after this image is built. The devcontainer
# and Compose set `remoteUser`/`user: vscode`; postCreate repairs ownership of
# the pi volume and the dev database once the user exists.
WORKDIR /workspace

# PLAN §16 P1-02 asks for the base tag to be verified at build time, not trusted
# from a comment.
RUN test "$(node --version | cut -d. -f1)" = "v24" \
    && node --version \
    && sqlite3 --version \
    && tmux -V \
    && rclone version | sed -n '1p'
