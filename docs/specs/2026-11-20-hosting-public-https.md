# Hosting off the phone: public HTTPS on the server

Phase 6's first and only subject. The care app, its data model and its agent stay
as they are; what changes is where the process runs, how a caregiver reaches it,
and everything that was only true because the host was a phone.

Revision 2 (2026-11-20): rewritten after three adversarial reviews and a host
probe. The substantive corrections are listed at the end under *Review changes*.

Revision 3 (2026-11-21): implementation notes only — what this slice does and
does not do, the DNS timer's real cadence, the backup invocation the unit
actually runs, the restore advice that no longer names a flag the restore
script rejects, and the off-box upload check as shipped.

Revision 4 (2026-11-21): **`P6-08` landed.** The retired `tailscale`/`cloudflare`
modes, the tailnet detection and boot wait, the tunnel module and URL wait and
the Termux notification transport are deleted, `scripts/termux-boot.sh` starts
`--access lan`, and the installer no longer fetches `cloudflared`. R2's rejection
rows, R6's transport removal and R13/R14's script/doc/test rewrites are met at
the **test level** (`access`, `options`, `outbox`, `runbook`, `termux-scripts` and
`security` tests, 940 green); no phone walk has re-run them. The box-dependent
rows below are still the operator's legs and are untouched by this revision.

**The design was built in two slices.** The first added `public` mode and made
every other mode refuse to start once an origin was configured; `P6-08` then
deleted the old path. What the design says about `tailscale`/`cloudflare` as
future deletions is therefore implemented history; the rest of the narrative is
kept as revision 2/3 wrote it.

Two limits stated where they are load-bearing rather than discovered later:
**the off-box copy is proved by a size gate and then a sha256 of the object read
back into the job's staging directory** (a corrupted upload of the right length
is refused — the remaining gap is `--rotate`'s re-upload, which still trusts
`rclone copyto`'s exit code), and no step in this repository has been executed
against a Docker daemon or a public name, so R0/R1/R9 are the operator's legs on
the box.

## Objective

Pupkeep is hosted on the host phone (Termux, wake lock, Termux:Boot), and the
partner reaches it over Tailscale. Both are the product's biggest liabilities:
Android suspends or kills the process, and daily access needs every caregiver to
be on one tailnet. The plan's own stop rule ("Termux is killed too often → move
to the VPS; the phone becomes a client") was met twice in a day of dogfooding —
a launcher that gave up after 10 restarts with `EADDRNOTAVAIL` on the tailnet
bind (`~/.pupkeep/server.log`, 2026-11-19T13:03), and a live listener that
disappeared on a Wi-Fi → 5G switch while the process stayed up.

After this phase: the household runs on the server behind a public HTTPS origin
(`pupkeep.duckdns.org`), the phone is a browser, Web Push is the daily
notification channel, and the Tailscale and Cloudflare access modes are retired —
refused at runtime by part one, deleted from the code by `P6-08`.

The host is the existing Oracle Cloud `VM.Standard.A1.Flex` instance (2 OCPU,
12 GB, `eu-frankfurt-1`) that already runs the coding container. It is free, and
free is the requirement. Its idle-reclamation policy is an **accepted,
unmitigated risk** in this phase — see Open assumptions.

## Current behavior

Evidence, reproducible on the released tag:

- Four access modes (`local`, `lan`, `tailscale`, `cloudflare`); `tailscale`
  binds a discovered `100.64/10` address and fails closed without one.
- The owner link is minted from `BindPlan.displayUrl`, the *discovered* address,
  so `--access lan` mints a link naming the container's or phone's own address.
- `PUPKEEP_PUBLIC_ORIGIN` is documented in PLAN §5.4/§6.9/§14.2 and
  `.env.example` and is read by **no code**. Mutations behind a proxy survive
  only through the `sameOrigin(Origin, Host)` fallback.
- `requestScheme()` reads the **leftmost** `X-Forwarded-Proto` and
  `clientIp()` the `CF-Connecting-IP` header, both **only from a loopback peer**
  (`src/server/http.ts`). A Caddy container on a bridge is not loopback, so
  cookies are issued without `Secure` and every sign-in shares one rate-limit
  bucket keyed on the proxy.
- The sign-in, invite and invite-mint routes **charge the limiter before
  validating the credential**, all on one `signin:<ip>` bucket.
- Sessions last 365 days, are never capped or pruned, and `lastSeenAt` is parsed
  but never written — there is no idle expiry. `revokeSession` kills one session
  and does not touch that device's push subscriptions.
- No `Strict-Transport-Security` header is sent anywhere.
- The host notification transport is `termux-notification` (Termux:API), wired
  through the outbox for one member.
- The archive is `pupkeep.sqlite`, `config.json` and `push.json`
  (`BACKUP_FILES`), and `config.json` carries `ownerTokenHash`, every
  `session.tokenHash` and every `invite.codeHash`. So **restoring an archive
  re-arms an old owner link and old sessions**; PLAN §14.4's claim that "the
  backup can restore auth without becoming a credential" is false today.
- The image installs Node only, but `checkBackupTools()` requires `tar`, `age`,
  **`expect`** and (with a remote) `rclone`.
- `Dockerfile` `CMD` is `--access lan`, and `parseOptions` applies the `--access`
  **flag** after `PUPKEEP_ACCESS`, so the environment cannot override it.
- `docker build`/`docker compose` have never been run by anyone in this repo.
  `test/ci.test.ts` pins `ci.yml` to exactly `permissions: contents: read`.

Verified on the host, 2026-11-20: the box is an Oracle
`VM.Standard.A1.Flex`, 2 OCPU / 12 GB, `eu-frankfurt-1` (the whole 2026 Always
Free A1 allowance); 48 GiB disk, 28 GiB used; the app measures ~3 MiB (launcher)
and ~95 MiB (server child) RSS.

## Required behavior

R0. **Reachability preflight gates everything.** Before any mode is deleted or
   any stack is created: a temporary listener on host 80 and 443, probed from a
   device on mobile data (not the same network), must show the pages arriving.
   If it fails — CGNAT, a blocking cloud firewall, a closed port — this phase
   stops and the host decision reopens. Nothing in R1–R14 is done first.

R1. **Deployment shape.** Two containers on the host, `pupkeep` and `caddy`, on
   one ordinary bridge network (**not** `internal: true` — the app needs egress
   for the model provider, Web Push, ntfy and rclone, and Caddy needs it for
   ACME). Only Caddy publishes host ports 80 and 443. The app publishes nothing.
   Caddy persists ACME state and its config in named volumes. The household's
   data directory is a host bind mount at `/srv/pupkeep/data`, pre-created by the
   operator with `install -d -o 10001 -g 10001 -m 0700`, because a bind mount
   hides the image's own `/data` ownership.

R2. **`public` access mode.** `--access` accepts `local`, `lan`, `public`;
   `tailscale` and `cloudflare` are rejected as unknown modes — that half is the
   deletion slice (`P6-08`), and until it lands a configured origin makes both
   refuse to start rather than parse into a listener. `public` refuses
   to start when `PUPKEEP_PUBLIC_ORIGIN` is absent, is not an absolute `https://`
   URL, or carries a path, query or fragment. The published image's command is
   `--access public --data /data`; a Compose `command:` states it explicitly
   rather than relying on the image default, because the flag beats
   `PUPKEEP_ACCESS`.

R2b. **The dangerous modes fail closed once an origin exists.** When
   `PUPKEEP_PUBLIC_ORIGIN` is set, `local` and `lan` refuse to start.
   Independently, `lan` refuses to start when the address it discovered is not
   RFC1918 — the same fail-closed rule the deleted `tailscale` mode had. A
   plaintext sign-in screen cannot appear on the public internet by choosing a
   mode, and the image's old `CMD --access lan` cannot resurrect it.

R3. **One configured origin is the only origin.** In `public` mode:
   `allowedOrigins()` returns exactly the configured origin — not the loopback
   origins, and the `sameOrigin(Origin, Host)` fallback is removed. A request
   whose `Host` is not the configured host is refused. The owner link is minted
   on the configured origin, and the partner invite link is built from it rather
   than from the request's scheme and `Host`. `Secure` on the session cookie and
   `Strict-Transport-Security` (a stated `max-age`, no `includeSubDomains`)
   follow from the configured origin being HTTPS, not from a proxy header. A
   proxy header that contradicts the origin is refused and logged.

R4. **The proxy is a known address, not a class of address.** In `public` mode,
   `X-Forwarded-Proto` and `X-Forwarded-For` are honoured only when the peer is
   the address configured for the proxy (a Compose static `ipv4_address`, passed
   to the app as configuration) — never because the peer is "private". The
   scheme is the **rightmost** `X-Forwarded-Proto` value and the client address
   the **rightmost** `X-Forwarded-For` entry, both because the proxy appends its
   own view last and anything to the left is client-supplied. Peer addresses are
   compared in normalised form, including IPv4-mapped (`::ffff:a.b.c.d`)
   forms. In `local`/`lan` modes forwarded headers are ignored entirely, and
   `CF-Connecting-IP` handling is deleted with the `cloudflare` mode.

R5. **Sessions sized for the internet.** Sessions last 30 days; a member's
   session rows are capped and expired rows pruned; `lastSeenAt` is written on
   authenticated requests and an idle session expires (the idle window is stated
   in the plan, default 14 days). The cookie is named with the `__Host-` prefix
   in `public` mode. `revokeMemberSessions(memberId)` empties that member's
   sessions **and** removes that member's push subscriptions, so a revoked device
   stops being notified; the owner may revoke either member, a member only
   themselves. The owner *token* is not a session and survives revocation —
   `npm start -- --reissue-owner` (or the container's entrypoint with the same
   flag, production stopped first) is the stated repair, and the docs say so.
   The flag belongs to the launcher, not to `restore.ts`, whose parser rejects
   it.

R5b. **The sign-in limiter cannot be a lockout lever.** Credentials are
   validated before the limiter is charged; a successful sign-in resets the
   bucket instead of consuming it; failures are charged per client address with a
   separate, higher ceiling for invite redemption so a household onboarding is
   never blocked by a stranger's attempts. A limited request logs the client
   address it was keyed on.

R6. **Phone transport removed.** The Termux notification transport and its
   outbox wiring are deleted; delivery is in-app (authoritative), Web Push, and
   ntfy as an optional per-user channel whose topic must be generated with ≥128
   bits of entropy (a length rule is not entropy). A change that keeps a channel
   must keep the in-app record regardless.

R7. **Backups run unattended, off-box, and cannot leak auth.** The image carries
   `age`, `rclone`, `expect` and `tar` at pinned versions. A host systemd timer
   runs, serialised so two runs cannot overlap (`Persistent=true`,
   `After=docker.service`, plus a lock):

   ```
   docker compose run --rm -T --entrypoint node --no-deps \
     -e PUPKEEP_BACKUP_PASSPHRASE \
     pupkeep scripts/backup.ts --data /data --remote <remote>:<path> --require-remote
   ```

   That is the invocation, `-e` included: systemd decrypts a `systemd-creds`
   copy of the passphrase into `${CREDENTIALS_DIRECTORY}`, a one-line shell
   reads it into an exported variable and `exec`s compose, and `-e` names the
   variable so compose forwards that value. The passphrase is therefore in
   neither `ps` nor the journal; it is in the one-shot's environment, which is
   readable by the same uid — acceptable on a single-tenant box (§6.10). The destination comes from
   `/etc/pupkeep/backup.env`. `--entrypoint node` is load-bearing because
   `compose run` appends to the image's `ENTRYPOINT`, which is the launcher.

   The nightly passphrase arrives from the `systemd-creds` copy through `-e`,
   and the Compose secret of the same name is what the restore drill mounts;
   `rclone.conf` and `known_hosts` arrive as Compose secrets. All of them are
   readable by uid 10001 — never a root-owned 0600 bind mount, which the
   container cannot read (the failure R7 names).

   The archived `config.json` has `ownerTokenHash` set to null, `sessions` and
   `invites` emptied, so a restored archive can never re-arm an old owner link or
   session; the restore procedure then requires `npm start -- --reissue-owner`
   (the launcher's flag) before the first sign-in, and PLAN §14.4's claim is
   corrected to match. A pre-scrub archive is **refused** before the data
   directory is touched: rotating the passphrase does not repair it, because
   rotation re-encrypts the same `config.json` with the credentials still inside
   — only a fresh archive from a scrubbing build, or removing those fields by
   hand, does. A failed run exits non-zero and leaves the previous archive and
   the status file intact.

   The off-box copy is verified, not assumed. The uploaded object's reported
   size is compared with the local archive's first — cheap, one round trip, and
   it is what catches a truncated upload — then the object is copied back into
   the job's private staging directory and both files are hashed with sha256, so
   corruption that keeps the length is found too; a mismatch fails the run and
   names which copy is intact and where the other one is, and the read-back copy
   is removed on both paths. A re-upload after `--rotate` still trusts
   `rclone copyto`'s exit code, which is the remaining gap.

R8. **The box reports on itself, and the report is measurable.** A daily host
   timer pushes one line to a deployment-level ntfy topic named in
   `/etc/pupkeep`: certificate days remaining (probed with `openssl s_client`
   from the host, since the Caddy image ships no `openssl`), free disk, container
   health (`docker compose ps` plus a Caddy healthcheck so "both healthy" is a
   real state), the age of the newest archive, and the count of sign-in failures
   and 429s in the last 24 h. `/healthz` gains a cheap `SELECT 1` and a
   disk-free floor so a wedged database or a full disk is not reported healthy,
   and is rate-limited; the Docker `HEALTHCHECK` uses a separate cheap endpoint
   and the container's actual port rather than a hardcoded 8787. The outside
   probe requests `https://<name>/healthz` (a 308 from the HTTP redirect is not
   a healthy answer) and alerts after two consecutive failures. Container logs
   are capped at 10 MB × 3; Caddy's access log stays off.

R9. **The name stays pointed at the box.** A `pupkeep-dns-update.timer` updates
   the record every **5 minutes** (`OnUnitActiveSec=5min`, plus `OnBootSec=2min`
   so a rebooted box is re-pointed promptly), with the token supplied as a
   systemd credential so it never appears in `ps` or the journal. Five, not
   fifteen: the box's public address is ephemeral — a stop/start of the instance
   can hand it a different one — and the name is the identity every cookie and
   push subscription is scoped to, so the stale window after an address change is
   kept short rather than widened. The hand-installed timer on the box already
   ran at five minutes, and the shipped unit replaces it at the same cadence
   instead of quietly loosening it. The deploy preflight verifies the record
   resolves to the box's public IP. The name is the identity: the incident note
   for a lost or repointed name is re-mint plus revoke-all, because every cookie
   is origin-scoped.

R10. **First run.** `TZ=Europe/Berlin` on the container (the wizard's zone seed
   reads the runtime zone; the zone itself is confirmed in the wizard). The
   household is fresh — no data migrated. The operator re-enters the provider
   keys, because `secrets.json` is excluded from archives and a fresh household
   has none: without this the agent is dead on day one. The owner link is
   **never printed** in `public` mode — written 0600 only — so `docker compose up`
   without `-d` cannot put the trust root in a container log. The partner is
   invited on the configured origin; the phase closes on a web sign-in from the
   partner's browser, not on the iPhone push leg (that is P0-10).

R11. **Images come from CI, pinned, arm64.** A workflow of its own (`image.yml` —
   `ci.yml` is untouched, because `test/ci.test.ts` pins its permissions) builds
   the image on every pull request and pushes on a tag, for `linux/arm64` via
   buildx, with digest-pinned base images and the repo's exact-version rule
   applied to `age`/`rclone`/`expect`. The Compose service references
   `ghcr.io/<owner>/pupkeep:<tag>` with no `build:` stanza, so `compose pull`
   cannot silently build or pull from Docker Hub; the package is public or the
   host is logged in. Updates are a manual `pull` + `up -d`; no updater runs.

R12. **Docs, plan and gates.** PLAN gains a Phase 6 with `P6-*` task IDs, and
   §2.1/§6 become the hosting story; §14.2 states the real header and origin
   rules; §14.4's backup-auth claim is corrected. `AGENTS.md`, `docs/DEPLOY.md`,
   `docs/PHONE-RUNBOOK.md`, `docs/access-and-notifications.md`,
   `docs/kill-restart-matrix.md`, `README.md` (Known limitations),
   `.env.example` and `docker-compose.yml` are updated or explicitly marked
   historical in the same change. Gate re-cut: P5-01b closes as moot; **P5-05 is
   retired** and a `P6-*` "7-day resource run" replaces it rather than mutating
   the old ID; P5-02's clean-host leg stays open and is drilled on the box;
   P5-03 and P5-10's device half stay; P0-10 is promoted to a release blocker
   only for the notification claim; G4's literal Termux:API requirement is
   replaced in the plan, not quietly ignored.

R13. **The phone fallback keeps working or goes.** The Termux scripts stay as an
   offline fallback, which means `termux-boot.sh` starts `--access lan` on the
   household LAN (not the deleted `tailscale` mode), and the scripts and docs
   that assume a tailnet address (`termux-sshd.sh`, `termux-tunnel.sh`,
   `PHONE-RUNBOOK` §6) are marked operator-only and Tailscale-dependent. The
   installer stops fetching `cloudflared`.

R14. **The deletion is verifiable, not just grepped.** A test asserts that
   `CF-Connecting-IP` is now ignored and that a non-proxy peer's forwarded
   headers change nothing; the mode list is asserted; the docs assertion tests
   that currently pin `--access tailscale` and the cloudflared pin are rewritten
   in the same change.

## Non-goals

- Anything about the agent beyond where it runs: no new tools, no deeper
  integration, no prompt or model changes.
- Care-log semantics, documents, client routes, the in-app notification centre.
- Multi-household, multi-instance, replicas, a second writer.
- Cloudflare Access, a named tunnel, or buying a domain.
- Mitigating Oracle's idle reclamation (deferred by decision; recorded in Open
  assumptions).
- Prometheus/Grafana-class observability, log shipping, alert routing beyond
  ntfy.
- Keeping the phone a supported *host*: an offline fallback and a client only.

## Constraints

- **One process, one SQLite file.** No second writer. A container stop must let
  the launcher release both pid locks; `stop_grace_period` stays 30 s (measured:
  2 s server close, 3 s TERM→KILL).
- **No native modules.** `age`/`rclone`/`expect` are distro binaries in the
  image; `node:sqlite` stays the only storage binding.
- **The coding container has no Docker daemon and no route to the host.** Docker,
  TLS and systemd work is authored here and executed on the host by the
  operator; the verification section is explicit about which side runs what.
- **Disk:** 48 GiB with 28 GiB used. WAL, archives, Caddy state and capped logs
  must stay far inside it.
- **Secrets:** DuckDNS token, backup passphrase, rclone config and the report
  topic live under `/etc/pupkeep` (0600, root) and reach containers only as
  Compose secrets. Nothing secret in the repo, the data dir, or a log.
- **Pinning:** exact versions for base images (digest), `age`/`rclone`/`expect`
  and the app image tag; the repo's rule, not a style preference.
- **Node 24** remains the runtime floor; the image stays `node:24-bookworm-slim`.

## Design decisions

**Modes collapse to three, and only one of them can be public.** `ACCESS_MODES`
becomes `["local","lan","public"]`; `BindPlan` gains `origin`; the mint reads
`plan.origin ?? plan.displayUrl`. Deleting `tailscale` deletes tailnet detection,
the boot script's tailnet wait and the 8791/8787 split; deleting `cloudflare`
deletes the tunnel module, the tunnel-URL wait, the `EXIT_NO_ORIGIN` tunnel
branch, the `CF-Connecting-IP` trust and the installer's `cloudflared` download.
Rejected: keeping `cloudflare` as a preview — localhost is already a secure
context.

**The origin is passed in the environment and validated once**, in
`parseOptions`, normalised to `scheme://host[:port]` (lower-cased host, explicit
`:443` stripped, no trailing dot, no userinfo). Rejected: a CLI flag — Compose
and the boot script are the configuration surfaces, and one validated location
beats two.

**Proxy trust is by address.** `public` implies "proxy-fronted"; the proxy's
address is configuration (a Compose static address on the bridge), not "any
private peer". Rejected: trusting all RFC1918 peers (any sibling container and
any host process would be trusted), and the shared-network-namespace trick
(makes a security property depend on YAML nobody will remember).

**Rightmost for both forwarded headers.** The proxy appends its own view last;
everything to its left is forgeable. The existing leftmost `X-Forwarded-Proto`
read is a bug this change fixes rather than a convention to keep.

**HSTS and `Secure` come from the origin.** The session cookie and the invite
link are built from the configured origin, so a missing or rewritten
`X-Forwarded-Proto` cannot downgrade the credential.

**The limiter charges failures, not attempts.** `hit()` moves after validation,
`reset()` on success, and redeem gets its own ceiling — otherwise a stranger's
ten requests a minute are a denial-of-service against the household's only door.

**Sessions get a real lifecycle.** Cap and prune per member, write and honour
`lastSeenAt`, `__Host-` prefix in public mode, and revoke-all also deletes that
member's push subscriptions so a revoked device stops being notified. The owner
*token* is explicitly not revocable by this route; `--reissue-owner` is.

**The archive carries no live credential.** The backup job nulls
`ownerTokenHash`, `sessions` and `invites` in the archived `config.json` and the
restore procedure requires a re-mint. Rejected: keeping them "for convenience" —
an archive is the most copied object in the system, and this phase makes
restores routine.

**One-shot work runs through `--entrypoint`,** because `docker compose run`
appends to `ENTRYPOINT`, not `CMD`. A dedicated one-shot Compose service would
work too and is the fallback if the flag proves awkward in the unit file.

**Compose topology is deliberately boring:** a `pupkeep` service with no `ports:`
and an explicit `command:`, a `caddy` service publishing 80/443 with
`caddy-data`/`caddy-config` volumes and a healthcheck, a normal bridge network, a
bind mount, `restart: unless-stopped`, `stop_grace_period: 30s`, `TZ`, capped
`json-file` logs. TLS via Caddy's HTTP-01; Caddy's default issuer also tries
TLS-ALPN-01, so a host with only 80 blocked may still issue without any custom
build. The DNS-01 + `caddy-dns/duckdns` path is a pinned one-file fallback for a
host that blocks both, and it does **not** fix CGNAT — only R0's preflight can.

**Deployment artifacts live in `deploy/`** — Caddyfile, systemd units
(backup, report, duckdns), a short operator README and the restore-drill Compose
override — beside the root `Dockerfile`/`docker-compose.yml` that PLAN §4 already
places there. The plan update records the addition.

## Test seams

1. **Option parsing** (`test/options.test.ts`, `test/launcher.test.ts`) — the
   public fail-closed exits, origin validation/normalisation, `lan`/`local`
   refusing with an origin set, `lan` refusing a non-private discovered address,
   deletion of the two modes, and the mint receiving the configured origin.
2. **Peer trust, as a pure function plus a route test** (`src/server/http.ts`
   seam, `test/security.test.ts`) — `trustedPeer(remoteAddress, proxyAddress)`
   and `forwardedValue(header, "rightmost")` tested directly, plus route-level
   tests that inject the peer address through an explicit dependency. This seam
   is new because `peerIsLoopback`/`clientIp` read `req.socket.remoteAddress` and
   the harness only ever binds `127.0.0.1` (`test/support/app.ts`), so R4's
   "public peer" half is otherwise untestable.
3. **HTTP app seam** (`test/auth.test.ts`, `test/app.test.ts`,
   `test/multiplayer.test.ts`) — `Secure`/HSTS by origin, invite link built from
   the origin, 30-day sessions, idle expiry, `__Host-` name, revoke-all including
   push subscriptions, limiter-after-validation and its reset, and one bucket per
   client address.
4. **Adversarial** (`test/security.test.ts`) — forged leftmost `X-Forwarded-For`
   changes no limiter key; forwarded headers from a non-proxy peer do nothing;
   `CF-Connecting-IP` is ignored; a `public` start without a valid origin neither
   mints nor listens; `Host` mismatch is refused.
5. **Notifications** (`test/outbox.test.ts`) — Termux transport gone, Web Push
   and ntfy delivery unchanged, in-app always recorded, ntfy topic entropy
   enforced.
6. **Backup** (`test/backup.test.ts`, CLI args test) — the archive has no
   `ownerTokenHash`/`sessions`/`invites`; the invocation's arguments and
   passphrase path; non-zero exit on failure.
7. **CI** (`test/ci.test.ts` sibling) — `image.yml` builds on PR, pushes only on
   a tag, targets `linux/arm64`, and `ci.yml` keeps its pinned permissions.
8. **Not unit-testable — verified on the host:** R0 reachability, certificate
   issuance and renewal, container restart and host reboot, the restore drill,
   the timers, and the idle-reclamation metrics watch.

## Acceptance criteria

**Two kinds of box are unticked for different reasons.** Everything that needs
the box (R0, R1, R7's unattended run, R8's report, R9, R10, R11's host pull, the
restore drill) is the operator's leg and has not been run from this repository.
The deletion slice's rows — R2's rejection of `tailscale`/`cloudflare`, R6's
removal of the Termux transport, R13's rewritten scripts and R14's rewritten docs
assertions — are met at the test level by `P6-08` and are ticked below with that
caveat; none of them has been re-walked on a phone.

- [ ] R0 — a page served by a temporary listener on 80 and on 443 arrived on a
  phone using mobile data; the listeners were removed. If it did not, no other
  criterion here was attempted.
- [ ] R1 — `docker compose ps` shows both services up; host 80/443 are served by
  Caddy and no host port reaches the app (`docker compose ps` ports plus a host
  probe); `/srv/pupkeep/data` is 0700, uid 10001, and a `compose run` as uid
  10001 can create and delete a file in it.
- [ ] R1 — after `docker compose down && up -d`, the certificate is served from
  the persisted Caddy volume (no re-issuance in `caddy` logs).
- [ ] R1 — the app reaches the model provider, `ntfy` and the push endpoint from
  inside its container (`compose exec pupkeep node -e 'fetch(...)'`), proving the
  network is not `internal`.
- [x] R2 — `--access tailscale` and `--access cloudflare` are rejected as unknown
  modes (test-level, `test/access.test.ts`, `test/options.test.ts`); a
  `public` start with no origin, with `http://…`, and with a URL carrying a path
  each exit non-zero and start nothing; the image's `command:` is `public`
  (P6-06, unbuilt).
- [ ] R2b — with `PUPKEEP_PUBLIC_ORIGIN` set, `--access lan` and `--access local`
  refuse to start; `--access lan` alone refuses when the discovered address is
  public.
- [ ] R3 — `owner-link.txt` begins with the configured origin; a mutation from
  any other origin or with a mismatched `Host` is refused; the session cookie is
  `__Host-`-prefixed, `Secure`, `HttpOnly`, `SameSite=Lax`, `Max-Age=2592000`;
  the response carries the stated HSTS header; the invite link is on the origin.
- [ ] R4 — from the proxy address, `X-Forwarded-Proto: https` plus
  `X-Forwarded-For: 203.0.113.9, 198.51.100.7` yields HTTPS and client
  `198.51.100.7`; from any other peer the same headers change nothing; the peer
  test passes with an IPv4-mapped address.
- [ ] R5/R5b — a revoked member's cookie stops working *and* their push
  subscription is gone; ten failed sign-ins from one address do not prevent a
  correct sign-in from another; a successful sign-in resets the bucket; session
  rows are capped and expired ones pruned.
- [x] R6 — no `termux-notification` in `src/` (`P6-08`; `test/outbox.test.ts`
  and `test/security.test.ts`); a delivered notification reaches the in-app centre
  and a Web Push subscription with ntfy absent; an ntfy topic below 128 bits of
  entropy is refused. Test-level, no phone walk.
- [ ] R7 — the unit's command produces a new `.age` archive, its `config.json`
  has a null `ownerTokenHash` and empty `sessions`/`invites`, the off-box copy's
  sha256 matches the local archive's (the size gate, then the read-back digest;
  a same-size corrupt object is refused), and a run with a wrong passphrase
  exits non-zero leaving the previous archive and status intact.
- [ ] R8 — the daily report arrives with cert days, disk, container health,
  archive age and 24 h auth-failure counts; a stopped database is *not* reported
  healthy by `/healthz`; an outside probe alerts after two misses; logs are
  capped.
- [ ] R9 — the DuckDNS record resolves to the public IP; the token appears
  nowhere in `ps` or the journal; the timer re-points the record after an IP
  change.
- [ ] R10 — first boot shows the wizard seeded `Europe/Berlin`; no stdout line in
  the container log contains `token=`; provider keys are entered; the partner
  signs in from her browser on the origin.
- [ ] R11 — a PR builds `linux/arm64` without pushing; a tag pushes to GHCR; the
  host pulls that exact tag and `compose up -d` changes the digest served.
- [ ] R12 — PLAN has a Phase 6 with `P6-*` IDs and the re-cut gate table; every
  listed doc matches shipped behavior or is marked historical; `.env.example`
  reflects the real `PUPKEEP_PUBLIC_ORIGIN` contract.
- [x] R13/R14 — `termux-boot.sh` starts `--access lan`; the installer no longer
  fetches `cloudflared`; the tests that pinned the old modes and the cloudflared
  pin are rewritten; the new negative header tests fail if the old trust returns.
  Pinned by `test/runbook.test.ts` and `test/termux-scripts.test.ts` at the
  source level; no phone run has exercised the scripts since.
- [ ] Restore drill — an archive restores into a throwaway directory with a
  Compose override (second `--data`, loopback port), boots on it, matches the
  durable seq, and cannot sign in until `--reissue-owner`.

## Verification

Authored and run in this container:

```bash
npm run typecheck
npm test          # options, peer trust, auth, security, outbox, backup, CI
```

CI on the pull request: typecheck, suite, and an arm64 image build (no push). On
a tag: the same plus a push to GHCR.

On the host, in this order, by the operator:

```bash
# 0. reachability, before anything is deleted or created
python3 -m http.server 80 --bind 0.0.0.0 &   # and 443
#    open http://<public-ip>/ from a phone on MOBILE DATA; kill both after
dig +short pupkeep.duckdns.org

# 1. directories and secrets
sudo install -d -o 10001 -g 10001 -m 0700 /srv/pupkeep/data
sudo install -d -m 0700 /etc/pupkeep    # passphrase, duckdns token, rclone.conf,
                                        # report topic; 0600 each
# 2. bring it up
cd /srv/pupkeep && docker compose pull && docker compose up -d
docker compose ps
docker compose logs --tail=50 caddy pupkeep

# 3. origin, TLS, cookies, egress
curl -sSI https://pupkeep.duckdns.org/healthz | grep -i strict-transport
curl -sS -o /dev/null -w '%{http_code}\n' https://pupkeep.duckdns.org/
docker compose exec pupkeep node -e 'fetch("https://ntfy.sh").then(r=>console.log(r.status))'

# 4. restart, reboot, timers
docker compose restart && curl -sf https://pupkeep.duckdns.org/healthz
sudo reboot   # then
curl -sf https://pupkeep.duckdns.org/healthz && systemctl list-timers 'pupkeep*'

# 5. backup, off-box copy, and the drill
sudo systemctl start pupkeep-backup.service
rclone lsl <remote>:<path> | tail -3
docker compose -f docker-compose.yml -f deploy/compose.restore.yml up -d
#    restore into /srv/pupkeep/restore-test on 127.0.0.1:8792, compare the seq,
#    confirm sign-in is refused until a link is minted (the boot mints one, or
#    run the launcher with --reissue-owner; restore.ts rejects the bare flag)

# 6. the report and the certificate
sudo systemctl start pupkeep-report.service   # a report line arrives in ntfy
sudo openssl s_client -servername pupkeep.duckdns.org -connect pupkeep.duckdns.org:443 \
  </dev/null | openssl x509 -noout -enddate
docker compose exec caddy ls -l /data/caddy/certificates
```

## Open assumptions

| Assumption | Risk if wrong | Who confirms |
|---|---|---|
| 80/443 are reachable and there is no CGNAT | The public-origin plan needs a tunnel or a different host; R0 is the stopping point, and the `cloudflare` deletion must not happen first | Operator, R0 |
| `pupkeep.duckdns.org` is free and the account can be created | A name change is one env var plus a re-mint; registering late delays TLS | Operator |
| The host runs Compose v2 and can bind 80/443 | Fall back to systemd + host Caddy, or a different box | Operator |
| HTTP-01 (or TLS-ALPN-01) succeeds for the DuckDNS name | Fall back to the pinned DNS-01 Caddy build; a blocked 443 too means a different host | Operator, at first issuance |
| The box is single-tenant (root-only, nothing else on `/srv`, no other docker users) | "Trust the proxy's address" and `/etc/pupkeep` 0600 both rest on it | Operator |
| Nothing will sit in front of Caddy later (CDN, second proxy) | Rightmost-`X-Forwarded-For` is correct for exactly one appending hop; two collapse every client into one bucket | Operator |
| An rclone remote exists and is reachable from a container | The nightly job fails; the archive stays local and `--require-remote` makes that loud | Operator |
| **Oracle's idle reclamation is not mitigated in this phase** | Rule: 7-day 95th-percentile CPU < 20 %, network < 20 %, A1 memory < 20 % → Oracle stops the instance. The app is ~2 % memory, <1 % CPU, negligible network, so it qualifies as idle. No data is lost (boot volume survives) and DuckDNS re-points an ephemeral IP, but the household is offline until someone starts the instance. Deferred by decision; candidates are a 2.5 GB ballast verified against the OCI metrics chart, an OCI-API restart, GCP's `e2-micro`, or ~€4/month | Operator, after this phase |
| The partner's iPhone can receive Web Push as an installed PWA | ntfy stays the fallback; the phase's partner criterion is a browser sign-in, not push | P0-10 |
| The phone's `~/.pupkeep` is disposable | If not, archive it before R0; nothing is migrated by design | Operator (stated) |

## Review changes

What revision 2 corrects, each traceable to an adversarial review or a host probe:

- Oracle's idle reclamation is now an **accepted risk**, not a design: the app
  measures ~2 % memory and <1 % CPU, so it cannot keep the box alive by being
  used, and the "all three under 20 %" rule means only a deliberate consumer
  would — which this phase no longer builds.
- The one-shot backup command used `compose run … node scripts/backup.ts`,
  which `ENTRYPOINT` swallows; `expect` was missing from the image; the
  passphrase and rclone config were unreadable by uid 10001; the archive
  re-armed old auth; runs were unserialised.
- "An internal network" disabled egress; the app image's `CMD --access lan`
  could not be overridden by environment; `lan` survived as a plaintext path.
- CI built amd64 for an arm64 host, had no image reference to pull, and would
  have tripped `test/ci.test.ts` by editing `ci.yml`.
- The configured origin was not exclusive (Host fallback), the proxy was trusted
  by address *class*, the scheme read the leftmost header, cookies and invite
  links came from headers, the limiter charged before validation, session rows
  were never pruned, and `compose up` without `-d` printed the owner link.
- The DuckDNS updater, provider-key re-entry and Caddy's ACME volume were
  missing entirely; `/healthz` could not fail; `test/ci.test.ts`-style docs
  assertions and ten test files that pin the deleted modes were unaccounted for;
  the plan had no Phase 6 and G4's Termux:API requirement was left standing.

## Opening the plan

This spec is not the plan. Implementation's first pull request updates
`docs/PLAN.md` — a Phase 6 with `P6-*` task IDs, §2.1/§6 as hosting, §14.2's
Origin and header rules, §14.4's corrected backup claim, and the re-cut gate
table — because this repository's rule is that a change altering a plan decision
updates the plan in the same change. R0 comes before the plan is committed to:
if the box cannot be reached, the phase's first decision reopens.
