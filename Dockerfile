# Pupkeep on a VPS or any Docker host — PLAN §6.9's fallback, not a second app.
#
# The phone stays primary. This image exists so the same server, the same
# SQLite file and the same encrypted backup can be stood up elsewhere when the
# phone proves unreliable, and so a restore (P5-02) has somewhere to be drilled.
#
# It is **unbuilt and unverified** as of v0.1.0: the coding container has no
# Docker daemon, and P5-02's drill is where this gets exercised. `docs/DEPLOY.md`
# says so in the operator's words rather than implying otherwise.
#
# No native modules: `node:sqlite` is built in (PLAN §7.1), so there is no build
# toolchain stage and the runtime image stays `-slim`.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
# Dependencies first, so a source-only change does not re-run npm.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PUPKEEP_DATA_DIR=/data \
    PUPKEEP_PORT=8787

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# The server serves `web/` itself (no build step, PLAN §3.5), so a plain copy of
# the checkout is the deployable artifact.
COPY . .

# The data directory holds the database, the owner link and the push keys; it is
# 0700 and owned by the runtime user (PLAN §6.3, §14.4). `durable` is the volume
# in docker-compose.yml — without it, a redeploy is a new household.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin pupkeep \
 && mkdir -p /data \
 && chown pupkeep:pupkeep /data \
 && chmod 700 /data

USER pupkeep
VOLUME ["/data"]
EXPOSE 8787

# Liveness only: the route answers without a household and carries no counts
# (`src/server/http.ts`), which is what a container health check should know.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `lan` is the only mode with a meaningful bind inside a container, and §6.9 puts
# TLS in front of it (Caddy, or Tailscale). The warning that mode prints is about
# the port being open to the network — which is the deployment's job to scope.
ENTRYPOINT ["node", "--env-file-if-exists=.env", "bin/pupkeep.js"]
CMD ["--access", "lan", "--data", "/data"]
