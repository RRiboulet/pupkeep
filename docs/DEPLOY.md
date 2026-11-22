# Deploying Pupkeep

Two targets, one server. The **box** — the free Oracle arm64 instance behind
Caddy on `https://pupkeep.duckdns.org` — is the household's daily host (PLAN
§2.1, §6). The **phone** is the offline fallback: Termux on the household LAN,
started with `--access lan`. Both run the same `bin/pupkeep.js`, the same
`node:sqlite` file and the same encrypted backup.

This file is the *deployment* half. The box's numbered operator sequence is
[`../deploy/README.md`](../deploy/README.md); the fallback's day-to-day copy is
[`PHONE-RUNBOOK.md`](PHONE-RUNBOOK.md); the caregivers' copy is
[`access-and-notifications.md`](access-and-notifications.md).

## What v0.1.0 ships

| | |
|---|---|
| Version | `0.1.0` (`package.json`), tag `v0.1.0` |
| Runtime | Node **24 or newer** (`engines.node >= 24`; the phone runs 26) |
| Native modules | none — `node:sqlite` only (PLAN §7.1) |
| Build step on the host | none (PLAN §3.5); `web/` is served by the same process |
| Data | one directory (0700): SQLite, `config.json`, `secrets.json`, `push.json`, `owner-link.txt` |
| Deployable unit | a git tag on `main`, or the `linux/arm64` image `image.yml` builds |

`v0.1.0` predates Phase 6 and shipped the phone host with `--access tailscale`.
That mode is now deleted (`P6-08`): deploying `v0.1.0` today means deploying the
**fallback**, which must be started with `--access lan`. The box's artifacts
(`Dockerfile`, `docker-compose.yml`, `deploy/`) are on `main` and are not part of
a released tag yet; they are `P6-09`'s to prove on the host.

Deploy a **tag**, not a branch: `main` is the integration branch and a tag is
what the release was verified at.

## The box (the household's host)

The design and the acceptance list are PLAN §6 and
[`specs/2026-11-20-hosting-public-https.md`](specs/2026-11-20-hosting-public-https.md)
(R0–R14). The operator's numbered sequence is
[`../deploy/README.md`](../deploy/README.md); the shape is:

```bash
git clone <repo> pupkeep && cd pupkeep
git checkout <tag>              # or a commit on main until a Phase 6 tag exists
# 0. R0 first: a temporary listener on 80/443, probed from mobile data.
# 1. the image: compose pull once CI publishes the tag, or a one-off local build
# 2. /srv/pupkeep/data (0700, uid 10001) and /etc/pupkeep (root, 0700)
# 3. docker-compose.override.yml (the hostname), then:
docker compose up -d
docker compose ps               # both services up; no host port on the app
docker compose logs             # the owner link's PATH is logged, never the token
```

- **One configured origin.** The app's command is `--access public
  --data /data`; `PUPKEEP_PUBLIC_ORIGIN` is the only origin it accepts, and only
  Caddy can reach the app's bind. The owner link and the invite are minted on
  that origin.
- **No host port on the app.** Only Caddy publishes 80/443. Publishing the app
  directly would put a plaintext sign-in screen on the internet — `lan` says the
  same thing and refuses a public interface.
- **The volume is the household.** The data bind mount holds the database, the
  owner link and the push keys. Without it, every redeploy starts a new household
  and every push subscription is gone.
- **Restore first, then start**, from the latest encrypted archive
  (`npm run restore -- --data <dir> --archive <file.age>` with the app stopped).
  The archive carries no live credential (P6-05): the next start mints a fresh
  owner link, and each caregiver signs in again. The passphrase stays off the
  host that holds the archive (PLAN §7.5).

### Not verified

**Nothing in `Dockerfile`, `docker-compose.yml` or `deploy/` has been built or
run.** The coding container has no Docker daemon; no certificate was issued, no
timer fired, and the app has never been reached through Caddy. `P6-09` is the
operator's leg on the box, and its checklist is the spec's acceptance list. Until
it passes, treat the box as the intended host and the fallback as the only
path this repository has actually exercised.

## The phone (offline fallback)

```bash
cd ~/pupkeep
git fetch --tags
git checkout v0.1.0            # detached is fine: the tag is the deploy
npm ci --omit=dev
# stop the old launcher and its server, then start the tag
for f in launcher.pid server.pid; do
  p=$(cut -d' ' -f1 "$HOME/.pupkeep/$f" 2>/dev/null); [ -n "$p" ] && kill "$p"
done
~/pupkeep-start.sh --access lan --port 8791
curl -s -o /dev/null -w '%{http_code}\n' "http://$(ifconfig | awk '/wlan0/{f=1} f && /inet /{print $2; exit}'):8791/healthz"
```

Port 8791, not 8787: `8787` is where an operator's own `ssh` `LocalForward` lands
on this phone (Finding 3 in [`kill-restart-matrix.md`](kill-restart-matrix.md)).
The launcher also logged the exact URL as `listening url=…` in
`~/.pupkeep/server.log`, which is the reliable way to read it.

First install on a fresh Termux is `scripts/termux-install.sh`, and the runbook
covers it: it upgrades the package index before installing, refuses a `node` that
cannot run, installs the package allowlist, and writes the Termux:Boot wrapper.
It no longer fetches `cloudflared` (`P6-08`). **Do not run that script to deploy
a release** — it is the *install* path and it upgrades the whole device.

The boot path takes over from there: `~/.termux/boot/pupkeep.sh` writes a `boot:`
line with the `boot_id`, takes a wake lock, attempts the operator `sshd` once and
starts the app with `--access lan --boot`. It does not wait for a tailnet — the
180 s wait went with the `tailscale` mode (`P6-08`).

## What a release must have passed

`npm run typecheck` and `npm test` (the CI workflow runs both on every pull
request and every push to `main`), and the tag is put on a commit that passed.
Phase 6 adds `image.yml`: every pull request builds the `linux/arm64` image
without pushing, and a tag pushes it to GHCR. The rest of the gate is PLAN §15.6's
G5: restore on the box, TLS/HSTS/`__Host-` on the public origin, two-client E2E,
the security review, and the release — `P6-09` and `P6-10` are the legs that can
close it. See `CHANGELOG.md` for which of those are still open at this version.
