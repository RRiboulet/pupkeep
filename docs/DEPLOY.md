# Deploying Pupkeep

Two targets, one server. The **phone** is the product; the **VPS/Docker** image
is the fallback (PLAN §6.9) and the place a restore is drilled. Both run the same
`bin/pupkeep.js`, the same `node:sqlite` file and the same encrypted backup.

This file is the *deployment* half. The day-to-day operator copy is
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
| Deployable unit | a git tag on `main`, or the image built from `Dockerfile` |

Deploy a **tag**, not a branch: `main` is the integration branch and a tag is
what the release was verified at.

## The phone (primary)

```bash
cd ~/pupkeep
git fetch --tags
git checkout v0.1.0            # detached is fine: the tag is the deploy
npm ci --omit=dev
# stop the old launcher and its server, then start the tag
for f in launcher.pid server.pid; do
  p=$(cut -d' ' -f1 "$HOME/.pupkeep/$f" 2>/dev/null); [ -n "$p" ] && kill "$p"
done
~/pupkeep-start.sh --access tailscale --port 8791
curl -s -o /dev/null -w '%{http_code}\n' "http://$(ifconfig | awk '/^tun1/{f=1} f && /inet /{print $2; exit}'):8791/healthz"
```

Port 8791, not 8787: `8787` is where an operator's own `ssh` `LocalForward` lands
on this phone (Finding 3 in [`kill-restart-matrix.md`](kill-restart-matrix.md)).

First install on a fresh Termux is `scripts/termux-install.sh`, and the runbook
covers it: it upgrades the package index before installing, refuses a `node` that
cannot run, pins cloudflared, and writes the Termux:Boot wrapper. **Do not run
that script to deploy a release** — it is the *install* path and it upgrades the
whole device.

The boot path takes over from there: `~/.termux/boot/pupkeep.sh` writes a `boot:`
line with the `boot_id`, takes a wake lock, and waits up to 180 s for the tailnet
before starting the app (`PUPKEEP_BOOT_TAILNET_WAIT`). Android's **Always-on
VPN** is what makes that wait end without anyone opening the app.

## The VPS / Docker fallback

```bash
git clone <repo> pupkeep && cd pupkeep
git checkout v0.1.0
docker compose up -d
docker compose logs -f          # the owner link path is printed, never the token
```

- **Loopback only, by default.** `docker-compose.yml` publishes
  `127.0.0.1:8787`; TLS and the public name belong to Caddy or Tailscale in
  front (PLAN §6.9). Publishing `0.0.0.0:8787` puts a plain-HTTP sign-in screen
  on the internet — the launcher's own `lan` warning says the same thing.
- **The unit is `--access lan`.** That binds every interface *inside* the
  container, which is what a published port needs; the outer scope is the
  proxy's. The health check uses `/healthz`, which answers without a household.
- **Preserve `Host` in the proxy.** The app's origin check accepts the
  same-origin `Host` fallback and nothing else, which is what lets Caddy or a
  tunnel work without a domain (the security review proves this both ways on the
  care and invite routes). A proxy that rewrites `Host` breaks sign-in.
- **The volume is the household.** `pupkeep-data:/data` holds the database, the
  owner link and the push keys. Without it, every redeploy starts a new
  household and every push subscription is gone.
- **Restore first, then start**, from the latest encrypted archive
  (`npm run restore -- --in <archive> --data <dir>` with the server stopped).
  The passphrase stays off the host that holds the archive (PLAN §7.5).

### Not verified

**The Dockerfile and compose file in this repository have never been built.** The
coding container has no Docker daemon, and nothing in the release was exercised
through them. They exist so the fallback is a real artifact rather than a
paragraph, and P5-02's clean-host restore drill is where they get proven. Until
then, treat the phone path as the only verified deployment and this one as
"should work, untested".

## What a release must have passed

`npm run typecheck` and `npm test` (the CI workflow runs both on every pull
request and every push to `main`), and the tag is put on a commit that passed.
The rest of the gate is PLAN §15.6's G5: restore on a clean host, phone reboot
recovering, two-client E2E, and the security review — see `CHANGELOG.md` for
which of those are still open at this version.
