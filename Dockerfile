# The public-deployment image (Phase 6, R1/R7/R11).
#
# The household no longer runs on the phone: two containers on the Oracle A1 box
# run it — this one and Caddy — and this one is the only writer of one SQLite
# file. The image carries the server, the client it serves (`web/`, no build
# step, PLAN §3.5) and the distro tools the backup job hard-requires.
#
# No native modules: `node:sqlite` is built in (PLAN §7.1), so there is no build
# toolchain stage and the runtime image stays `-slim`.
#
# The base is pinned by digest, not by tag: a rebuild resolves the same Node 24
# (the multi-arch index below carries linux/arm64, which is the only platform
# the host and `image.yml` build). Bump the digest deliberately, in its own
# change, and let CI prove the image still builds (R11).

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# Dependencies first, so a source-only change does not re-run npm.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE}

# R7's exact-version rule for the backup tools. The `+bN` suffix is Debian's
# binNMU build number and is *per architecture*; these three are bookworm arm64
# (the host is arm64 and CI builds linux/arm64 only). A different architecture
# needs `--build-arg AGE_VERSION=…` with that architecture's suffix — apt
# refuses a wrong pin loudly rather than installing something else.
ARG AGE_VERSION=1.1.1-1+b3
ARG RCLONE_VERSION=1.60.1+dfsg-2+b5
ARG EXPECT_VERSION=5.45.4-2+b1

ENV NODE_ENV=production \
    PUPKEEP_DATA_DIR=/data \
    PUPKEEP_PORT=8787

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# `.dockerignore` keeps `.env`, `data/`, `node_modules/` and the test suite out,
# so this copies the deployable checkout and nothing secret.
COPY . .

# Why each package is here:
#   age     — the only cipher the archive has; `--verify` and `--rotate` run it
#             too, so it is not optional for a read-only drill either.
#   ca-certificates — rclone is Go: its TLS stack reads the system store
#             (/etc/ssl/certs), which `node:slim` does not ship — without it
#             every off-device upload dies with "certificate signed by
#             unknown authority" (found by P6-09's first real run). Unpinned
#             like tzdata: a trust store, not code; pinning one ships stale roots.
#   rclone  — the off-device copy. `--require-remote` makes a missing or broken
#             remote a failed run instead of a quiet local-only archive.
#   expect  — age prompts for its passphrase on a PTY, and the job answers that
#             prompt with expect (`src/server/backup.ts`); a pipe cannot, so an
#             unattended run hard-fails without it.
#   tzdata  — `TZ=Europe/Berlin` (R10) must mean the same thing to every process
#             in the container, not only to Node's bundled ICU. Deliberately
#             *unpinned*: it is a timezone database, not code, and pinning it
#             would ship stale DST rules for an app whose whole log is local
#             time. The exact-version rule (R11) names age, rclone and expect.
# `tar` is part of the Debian base and `checkBackupTools()` requires it; the
# assertion below makes a slimmer future base fail here, at build time, rather
# than at 03:30 on the host.
# hadolint ignore=DL3008 # tzdata is deliberately unpinned; the three above are not.
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
      "age=${AGE_VERSION}" \
      "ca-certificates" \
      "rclone=${RCLONE_VERSION}" \
      "expect=${EXPECT_VERSION}" \
      tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && tar --version \
 && dpkg-query -W age ca-certificates rclone expect tzdata

# The data directory holds the database, the owner link and the push keys; it is
# 0700 and owned by the runtime user (PLAN §6.3, §14.4). The Compose bind mount
# hides this ownership, which is why the operator pre-creates the host directory
# with `install -d -o 10001` (R1).
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin pupkeep \
 && mkdir -p /data \
 && chown pupkeep:pupkeep /data \
 && chmod 700 /data

USER pupkeep
VOLUME ["/data"]
EXPOSE 8787

# Liveness only, on the port the process is actually told to use rather than a
# hardcoded 8787 (R8): `PUPKEEP_PORT` is the one knob a different deployment
# would change. The HEALTHCHECK reads `/health`, which answers 200 whenever the
# event loop runs — no storage read, no `statfs` — so a wedged database does not
# restart the container in a loop. The deeper check is `/healthz`
# (`src/server/health.ts`): a read through the open SQLite handle and a 64 MiB
# free-disk floor on the data directory, answering 503 and naming the failed
# check when either is wrong. That is the endpoint the outside probe reads, so a
# sick database or a full disk is *reported* rather than bounced.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const p=process.env.PUPKEEP_PORT||8787;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `public` is the only mode that can serve the public origin (R2); it refuses to
# start without `PUPKEEP_PUBLIC_ORIGIN`, which the Compose service supplies. The
# deployment states the mode in its own `command:` as well, because a flag beats
# `PUPKEEP_ACCESS` — this default must never be the thing that decides.
ENTRYPOINT ["node", "--env-file-if-exists=.env", "bin/pupkeep.js"]
CMD ["--access", "public", "--data", "/data"]
