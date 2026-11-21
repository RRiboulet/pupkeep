# Pupkeep on the box: operator runbook

This is the deployment half of Phase 6. The spec is
[`docs/specs/2026-11-20-hosting-public-https.md`](../docs/specs/2026-11-20-hosting-public-https.md)
(R-numbers cited below are its requirements); the artifacts are the root
`Dockerfile`, the root `docker-compose.yml` and this directory.

Two containers on the Oracle `VM.Standard.A1.Flex` (arm64, 2 OCPU / 12 GB, free
tier, `eu-frankfurt-1`):

| container | role | host ports |
|---|---|---|
| `pupkeep` | the app; the only writer of one SQLite file | **none** |
| `caddy` | TLS termination and the public origin | 80, 443 |

Data is `/srv/pupkeep/data`; secrets are `/etc/pupkeep`. The DuckDNS updater
script is the host's `/usr/local/bin/pupkeep-dns-update`; its unit and timer ship
in `deploy/systemd/` and keep the one name pointed here (R9).

Do the steps in order. Step 0 is a gate: if it fails, stop and reopen the host
decision rather than building anything (R0).

## 0. Preflight (R0, R9)

Run **before** anything is created or any mode is deleted:

```bash
# On the box: a temporary listener on each public port (both need root).
sudo python3 -m http.server 80 --bind 0.0.0.0
sudo python3 -m http.server 443 --bind 0.0.0.0
```

From a phone on **mobile data** (not the household Wi-Fi, not the tailnet), load
`http://<public-ip>/` and `https://<public-ip>/` and confirm the directory listing
arrives on both. A browser warning on 443 is expected (the throwaway server has
no matching certificate); a timeout is the failure. Then kill both listeners.

If either port does not arrive, stop here. CGNAT or a closed cloud-firewall port
cannot be fixed by Caddy, an image or a unit file; the spec's Open assumptions say
the same, and everything after this step assumes R0 passed.

Also record:

```bash
# The name, once. Every block below uses $NAME; keep this shell for the rest of
# the runbook. A rename starts here; step 4 lists the files that move with it.
NAME=pupkeep.duckdns.org      # the Caddyfile's documented default, same string
export NAME

dig +short "$NAME"                   # must be the box's public IP (R9)
docker --version && docker compose version
df -h /srv                          # archives, Caddy state and logs must fit
systemctl list-timers --all | grep -iE 'pupkeep|duckdns'   # the hand-installed DuckDNS timer (replaced in step 7)
```

The devcontainer on this host owns `127.0.0.1:8787`. Nothing below publishes that
port; the restore drill uses `127.0.0.1:8792` for exactly that reason.

## 1. Checkout and image (R11)

```bash
sudo install -d -m 0755 /srv
sudo git clone https://github.com/RRiboulet/pupkeep.git /srv/pupkeep
cd /srv/pupkeep
sudo git checkout v0.1.1            # a tag, never a branch
```

The compose file names `ghcr.io/rriboulet/pupkeep:0.1.1`. **Until the `image.yml`
workflow has pushed a tag**, build that exact reference once on the box (it is
arm64, so the build is native — no qemu):

```bash
sudo docker build --platform linux/arm64 -t ghcr.io/rriboulet/pupkeep:0.1.1 /srv/pupkeep
```

Once CI publishes, `docker compose pull` replaces this and the local build is
never used again. The compose service has **no `build:` stanza** on purpose: a
pull must fail loudly rather than quietly build something else (R11). If the
GHCR package is private, log the box in first (`docker login ghcr.io` with a
read-only token); if it is public, nothing else is needed.

## 2. Data directories (R1)

```bash
sudo install -d -o 10001 -g 10001 -m 0700 /srv/pupkeep/data
sudo install -d -o 10001 -g 10001 -m 0700 /srv/pupkeep/restore-test
```

`0700` and uid **10001** is not cosmetic: the bind mount hides the image's own
`/data` ownership, so the host directory is what the container's user actually
gets. The proof that uid 10001 can write there is at the end of step 3, once the
secrets the service mounts exist.

## 3. Secrets and host configuration (R7, R8, R9)

Everything lives under `/etc/pupkeep` (directory `0700`, root). The three Compose
secrets are `0400` and owned by **10001** — Compose mounts the file into the
container with the host's owner and mode, so a root-owned `0600` file would be
unreadable by the app (the failure R7 names).

```bash
sudo install -d -m 0700 /etc/pupkeep
```

**Backup passphrase** (seals every archive; keep a copy off this box):

```bash
read -rsp 'backup passphrase: ' PW && echo
sudo sh -c 'umask 077; printf "%s\n" "$1" > /etc/pupkeep/backup-passphrase' sh "$PW"
unset PW
sudo chown 10001:10001 /etc/pupkeep/backup-passphrase
sudo chmod 0400 /etc/pupkeep/backup-passphrase
```

The timer does not read that file directly; it reads a host-encrypted copy, so
the passphrase is not sitting readable while idle. Re-run this whenever the
passphrase changes (then rotate with `scripts/backup.ts --rotate`):

```bash
sudo systemd-creds encrypt --name=backup-passphrase \
  /etc/pupkeep/backup-passphrase /etc/pupkeep/backup-passphrase.cred
sudo chmod 0400 /etc/pupkeep/backup-passphrase.cred
```

**rclone config and SSH host key** (build them where the remote is reachable,
then copy in):

```bash
sudo install -m 0400 -o 10001 -g 10001 ./rclone.conf   /etc/pupkeep/rclone.conf
sudo install -m 0400 -o 10001 -g 10001 ./known_hosts   /etc/pupkeep/known_hosts
```

If the sftp remote authenticates with a private key *file*, the key has to be a
fourth Compose secret — R7 names three, so prefer putting the key inline in
`rclone.conf` (`key_pem`) rather than adding a fourth. A remote without an
`rclone.conf` entry is a failed nightly run, which `--require-remote` makes loud.

**Report topic** (a deployment-level ntfy topic; anyone holding it can read and
post, so treat it as a secret and give it real entropy — 24 random bytes is
192 bits, not a length rule):

```bash
printf 'PUPKEEP_REPORT_TOPIC=%s\nPUPKEEP_REPORT_ORIGIN=https://%s\n' \
  "$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')" "${NAME:?set NAME in step 0}" |
  sudo sh -c 'umask 077; cat > /etc/pupkeep/report.env'
sudo chmod 0600 /etc/pupkeep/report.env
```

Subscribe to that topic in ntfy on the operator's phone, otherwise the daily
report is written to a topic nobody reads. The script reads this file, it does
not source it; the topic is the report channel's bearer secret, so it never
appears in the script's argv, curl's argv, the report line or an error message.

**Backup destination** (host-specific, not secret):

```bash
printf 'PUPKEEP_BACKUP_REMOTE=%s\n' 'sftp:pupkeep-backups' | sudo tee /etc/pupkeep/backup.env
sudo chmod 0644 /etc/pupkeep/backup.env
```

**DuckDNS token** (R9; read as a systemd credential, never from a command line):

```bash
read -rsp 'DuckDNS token: ' DUCKDNS_TOKEN && echo
printf '%s\n' "$DUCKDNS_TOKEN" | sudo sh -c 'umask 077; cat > /etc/pupkeep/duckdns.token'
unset DUCKDNS_TOKEN
sudo chown root:root /etc/pupkeep/duckdns.token
sudo chmod 0400 /etc/pupkeep/duckdns.token
```

`pupkeep-dns-update.service` loads it with
`LoadCredential=duckdns-token:/etc/pupkeep/duckdns.token`, so the script can read
`${CREDENTIALS_DIRECTORY}/duckdns-token`. The hand-installed
`/usr/local/bin/pupkeep-dns-update` predates that contract: before enabling the
timer, check that it reads the credential (or at least this root-only file) and
never takes the token as an argument. The unit cannot fix a script that reads
argv; and because the DuckDNS update URL itself carries the token, the script
must also keep that URL out of curl's argv. This is the R9 check that has to be
made on the host, not in this repository.

With the Compose secrets in place, prove the data mount is writable by the
container's own user (R1's acceptance, as a `compose run`):

```bash
cd /srv/pupkeep
sudo docker compose run --rm -T --entrypoint sh pupkeep -c 'touch /data/.probe && rm /data/.probe && echo writable'
```

## 4. One name, one origin (R2, R3, R9, R10)

The name is `PUPKEEP_HOSTNAME`, with `pupkeep.duckdns.org` as the documented
default. Caddy needs it as a bare host in its site address; the app needs it as
an `https://` origin in `PUPKEEP_PUBLIC_ORIGIN`. Typing those separately is how
the two disagree, so the Caddyfile reads `{$PUPKEEP_HOSTNAME:pupkeep.duckdns.org}`
and the override below passes the same variable into the caddy container while
*building the app's origin from it*. One value moves both.

Compose only injects the variables a service declares, and the base file
declares neither on `caddy`; the override is the wire, not a convenience.
Install it beside the checkout — Compose merges it automatically for commands
without an explicit `-f`, and `git checkout` leaves the operator's copy alone:

```bash
cd /srv/pupkeep
sudo install -m 0644 /srv/pupkeep/deploy/compose.hostname.yml \
  /srv/pupkeep/docker-compose.override.yml

printf 'PUPKEEP_HOSTNAME=%s\n' "${NAME:?set NAME in step 0}" | sudo tee /srv/pupkeep/.env >/dev/null
sudo chmod 0600 /srv/pupkeep/.env

# The two consumers must name one host. The override derives the second from
# the first, so this proves the override is installed rather than doing the
# arithmetic by hand.
sudo docker compose config | grep -E 'PUPKEEP_(HOSTNAME|PUBLIC_ORIGIN)'
# PUPKEEP_HOSTNAME: pupkeep.duckdns.org
# PUPKEEP_PUBLIC_ORIGIN: https://pupkeep.duckdns.org
```

A rename is the one line in `/srv/pupkeep/.env` and the `PUPKEEP_REPORT_ORIGIN`
line in `/etc/pupkeep/report.env` (the daily report probes the certificate on
that name), then `docker compose up -d`. Treat it as a new identity (R9): every
cookie is origin-scoped, so re-mint the owner link and revoke the old sessions.
The Caddyfile's inline default is the fallback for a base-compose run with no
`.env`; the base file's `PUPKEEP_PUBLIC_ORIGIN` fallback is the same name, and
the override replaces it with a value derived from `PUPKEEP_HOSTNAME`. Neither
is a second place to edit for the app or Caddy.

The rest of `docker-compose.yml`'s working values:

- `PUPKEEP_TRUSTED_PROXY: 172.28.0.11` — Caddy's static address on the compose
  network. Forwarded headers from any other peer are ignored (R4).
- `TZ: Europe/Berlin` — the wizard's zone seed reads the runtime zone; the
  household's zone is still confirmed in the wizard (R10).
- The command is set explicitly to `--access public --data /data` (R2): the flag
  beats `PUPKEEP_ACCESS`, so no environment variable can put the process back on
  the plaintext `lan` mode.

## 5. Bring it up (R1)

```bash
cd /srv/pupkeep
sudo docker compose config --quiet          # parses, interpolates, checks mounts
sudo docker compose pull                    # after CI publishes a tag
sudo docker compose up -d
sudo docker compose ps                      # both healthy; pupkeep has NO host port
sudo docker compose logs --tail=50 caddy pupkeep
```

The owner link is **not** printed: in `public` mode it is written `0600` only
(R10). `docker compose logs pupkeep | grep -c token=` must be `0`.

## 6. Verify (R1, R3, R8)

```bash
curl -sSI "https://$NAME/healthz" | grep -i strict-transport-security
curl -sS  -o /dev/null -w '%{http_code}\n' "https://$NAME/healthz"   # 200
curl -sS  -o /dev/null -w '%{http_code}\n' "http://$NAME/"           # 308, not 200

# Egress: the network is not internal (R1). The model provider, Web Push and
# rclone ride the same path.
sudo docker compose exec pupkeep node -e 'fetch("https://ntfy.sh").then(r=>console.log(r.status))'

# Only Caddy owns 80/443; 8787 here is the devcontainer, not this stack.
ss -ltnp | grep -E ':(80|443|8787)\b'

# Certificate issued and stored in the volume.
sudo docker compose logs --since 10m caddy | grep -i 'certificate obtained'
sudo docker compose exec caddy ls -l /data/caddy/certificates

# A restart must reuse it, not re-issue (R1). "obtained" must not appear again.
sudo docker compose restart caddy
sudo docker compose logs --since 2m caddy | grep -ci 'obtained'   # 0
```

Cookie and HSTS evidence (R3) needs the first sign-in from step 7:

```bash
LINK=$(sudo cat /srv/pupkeep/data/owner-link.txt)     # 0600, begins with the configured origin
curl -sS -D- -o /dev/null "$LINK" | grep -iE '^(set-cookie|strict-transport-security)'
# __Host-pupkeep-…=…; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000
```

## 7. First night (R7, R8, R9, R10)

Install the host units and the report script:

```bash
cd /srv/pupkeep
sudo install -m 0644 deploy/systemd/pupkeep-backup.service deploy/systemd/pupkeep-backup.timer \
                    deploy/systemd/pupkeep-report.service deploy/systemd/pupkeep-report.timer \
                    deploy/systemd/pupkeep-dns-update.service deploy/systemd/pupkeep-dns-update.timer \
                    /etc/systemd/system/
sudo install -m 0755 deploy/pupkeep-report.sh /usr/local/bin/pupkeep-report

# If the box still carries the hand-installed DuckDNS timer, stop it first: two
# writers for one A record is what R9 rules out. A same-named unit was just
# overwritten above; this is for a differently named one.
systemctl list-timers --all | grep -i duckdns
# sudo systemctl disable --now <that-unit>.timer

sudo systemctl daemon-reload
sudo systemctl enable --now pupkeep-backup.timer pupkeep-report.timer pupkeep-dns-update.timer
systemctl list-timers 'pupkeep*'     # backup 03:30, report 08:00, DNS every 5 min
```

Then, in a browser on the origin:

1. Open the owner link from `/srv/pupkeep/data/owner-link.txt` — never from a log.
2. Name the household and the puppy; confirm the zone reads **Europe/Berlin**.
3. **Re-enter the provider keys.** `secrets.json` is excluded from archives by
   design and a fresh household has none, so without this the agent is dead on
   day one (R10).
4. Invite the partner from the app; the invite link is built on the configured
   origin (R3). The phase closes on her signing in from her own browser on the
   origin — the iPhone push leg is P0-10 and is not this step's gate.
5. Confirm `pupkeep-dns-update.timer` is the only DuckDNS timer and that
   `dig +short "$NAME"` still returns this box (R9).

Then point an **outside** probe at `https://$NAME/healthz` (R8), alerting after
two consecutive failures. Make sure it does not follow the HTTP redirect: a 308
from the plain-HTTP side is not a healthy answer, and a probe that follows it
would go green while the app is down.

Prove the units by hand before trusting the timers:

```bash
sudo systemctl start pupkeep-backup.service
sudo journalctl -u pupkeep-backup.service -n 40 --no-pager
sudo docker compose run --rm -T --entrypoint rclone --no-deps pupkeep lsl 'sftp:pupkeep-backups' | tail -3

sudo systemctl start pupkeep-report.service
sudo journalctl -u pupkeep-report.service -n 10 --no-pager   # the one line, plus the push result

sudo systemctl start pupkeep-dns-update.service
sudo journalctl -u pupkeep-dns-update.service -n 20 --no-pager   # the update, and no token in it
dig +short "$NAME"
```

The report line carries certificate days, disk, both containers' state/health,
hours since the newest `*.age`, and the last 24 h's `auth_fail`/`rate429`. A
probe that failed shows `unknown` in its own field — the line still arrives. A
report run that exits **78** is a `report.env` problem: the topic or origin is
missing, the file is group/other-readable, or a directive this script does not
know. The message names the file and the key, never the value.

## 8. Restore drill (R7, P5-02)

Restore a real archive into a throwaway copy and boot it. Production keeps
running; **the drill instance must be stopped while `restore.ts` runs** (it
refuses a live `launcher.pid`/`server.pid`, and two writers on one SQLite file
are forbidden).

```bash
sudo install -d -o 10001 -g 10001 -m 0700 /srv/pupkeep/restore-test/backups
NEWEST=$(sudo ls -1t /srv/pupkeep/data/backups/*.age | head -1)
sudo cp "$NEWEST" /srv/pupkeep/restore-test/backups/
sudo chown 10001:10001 "/srv/pupkeep/restore-test/backups/$(basename "$NEWEST")"

cd /srv/pupkeep
F="-f docker-compose.yml -f deploy/compose.restore.yml"
sudo docker compose $F run --rm -T --entrypoint node --no-deps pupkeep-restore \
  scripts/restore.ts --data /data --passphrase-file /run/secrets/backup-passphrase
sudo docker compose $F up -d pupkeep-restore
curl -sf http://127.0.0.1:8792/healthz
```

On a repeat drill, stop the instance first (`sudo docker compose $F stop
pupkeep-restore`) and add `--force`, which moves the previous copy aside instead
of refusing.

Checks:

- the restore prints `(durable seq N)`; `N` must equal the `seq` in
  `/srv/pupkeep/data/backups/status.json` from that same night;
- the drill instance must not be running while `restore.ts` runs (on the first
  drill it never started; on a repeat, stop it and pass `--force`);
- the archived owner link is refused on the drill instance —
  `LINK=$(sudo cat /srv/pupkeep/data/owner-link.txt); curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8792/login?token=${LINK##*token=}"`
  is `401`/`403`, never `303` (R7: the archive carries no live credential);
- a fresh link exists at `/srv/pupkeep/restore-test/owner-link.txt` after the
  drill boots (the boot mints one because the restored hash is null), or mint it
  deliberately with `… run --rm … pupkeep-restore --reissue-owner`. In `lan` mode
  the link names the drill container's own address, so it is for a `curl` on the
  box, not a browser elsewhere;
- the household's care log is present in the drill instance.

Clean up — the copy holds a live database and the push keys:

```bash
sudo docker compose $F stop pupkeep-restore
sudo docker compose $F rm -f pupkeep-restore
sudo rm -rf /srv/pupkeep/restore-test
```

## 9. Updates (R11)

The image tag is part of the release commit, so an update is a checkout and a
pull — never an edit to the compose file:

```bash
cd /srv/pupkeep
sudo git fetch --tags && sudo git checkout vX.Y.Z
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
```

No updater runs automatically. `image.yml` builds on every pull request and
pushes on a tag; the host pulls the tag (R11).

Two exceptions to the no-edit rule, both in the same release PR: the `image:` in
`docker-compose.yml` and in `deploy/compose.restore.yml` must name the same tag.

The hostname override from step 4 is the one untracked file this runbook asks
you to create. If a release changes `deploy/compose.hostname.yml`, re-install
it in the same step; a stale override would keep passing the old wiring to a
newer base file.

## What this does not fix

- **CGNAT or a blocked cloud firewall**: only step 0 can tell, and no artifact
  here can route around it. Caddy's TLS-ALPN-01 fallback covers a blocked 80,
  not a host that receives nothing inbound.
- **Oracle's idle reclamation**: an accepted, unmitigated risk in this phase (the
  spec's Open assumptions). No data is lost and DuckDNS re-points an ephemeral
  IP, but the household is offline until someone starts the instance.
- **A second proxy hop**: the app reads the rightmost `X-Forwarded-*`, which is
  correct for exactly one appending proxy. Nothing may sit in front of Caddy.
- **Device legs**: a real phone's fonts and font-size slider (P5-10), the
  partner's iPhone push (P0-10), and the two-client leg (P5-03) are still
  unproven; nothing here changes that.
