# Partner iPhone acceptance checklist (P0-10)

**Status:** harness built and smoke-tested on 2026-10-29; the phone checks have
**not** been run. **Owner:** the household owner, on the partner's iPhone. This is
the only Phase 0 work that needs a second phone.

It carries the partner-device rows that P0-03 and P0-08 could not close,
re-expressed for an **iPhone** (the partner's device) instead of the Android phone
they were written against. Everything else in Phase 0 is measured on the host
phone and this devcontainer and does not wait for this.

## What this proves, and what it does not

| Proves | Does not prove |
|---|---|
| The partner's iPhone reaches the host over Tailscale and can hold a session | Anything about the real app — the harness is a counter and a fake cookie, not P1's auth, snapshots or UI |
| Whether Safari keeps an `EventSource` alive, recovers it, or needs the page to rebuild it after iOS suspends the tab | That the real snapshot/resume design works (P1-09) |
| Whether an ntfy notification arrives **promptly while the phone is locked** | Android behaviour (measured, P0-08) |
| That a notification's tap target opens the tailnet URL | Any push path over Tailscale HTTP (there is none on iOS) |
| The quick-tunnel PWA/Web Push path, and what a tunnel restart costs the partner | A daily HTTPS origin (no domain, no named tunnel) |

## The harness (built, at `~/p0-10/server.mjs` on the phone)

Throwaway scratch code, not product code, and not a precedent for P1-06 or P1-09.
It exists so the checks below have something to talk to instead of deferring them
to Phase 1:

| Route | Behaviour |
|---|---|
| `GET /login?key=<token>` | correct key → `302 /` with `p010=<token>; HttpOnly; SameSite=Lax; Max-Age=86400`; wrong key → `403` |
| `GET /` , `GET /today` | require the cookie, else `401`; both render a live SSE counter and a "signed in" line |
| `GET /sse` | `text/event-stream`, one immediate frame then a free-running 2 s ticker |
| `GET /status` | `{"ticks":N,"clients":M}` — no secrets |

Deliberate limits: the cookie is the literal invite token from `argv` (no hashing,
no expiry logic, **not** a P1-06 design), and the "Today" screen is a counter, not
a domain view. The page also reports `opens=` and `scriptResumes=` so A4 can tell
an automatic reconnect from one the page had to force on `visibilitychange`.

**The source exists only on the phone**, like P0-03's scratch PWA. If the phone is
reset before P0-10 runs, it has to be rewritten — the behaviour table above is the
spec, and it is deliberately small enough (~140 lines) to rebuild from it.

## Before the session — host side

**Already on the phone from P0-03/P0-08:**

| Path | What it is |
|---|---|
| `~/p0-10/server.mjs` | the harness above |
| `~/p0-03/pwa/server.mjs` | scratch PWA server, binds `127.0.0.1:8788`: page, manifest, service worker, icons, `POST /subscribe`, `GET /status` |
| `~/.pupkeep/bin/cloudflared` | arm64 binary; only runs as `SSL_CERT_FILE=/etc/tls/cert.pem termux-chroot ~/.pupkeep/bin/cloudflared …` |
| `~/.pupkeep/ntfy-topic` | the P0-08 spike topic — **mint a fresh one** for this session |

Read the phone's tailnet address first; call it `<tailnet-ip>` below:

```bash
ssh phone 'ifconfig tun1 | grep "inet "'        # e.g. inet 100.x.x.61
```

Start the three processes (each in its own `tmux` window, or a separate shell —
they are foreground processes and must not be nested in one command line):

```bash
# 1. harness bound to the tailnet address ONLY — never 0.0.0.0
ssh phone 'cd ~/p0-10 && node server.mjs <tailnet-ip> 8790'
#    prints the invite link once: http://<tailnet-ip>:8790/login?key=<token>
#    Do not paste that link anywhere. If it is lost, restart the server.

# 2. the P0-03 PWA server on loopback (the tunnel's target)
ssh phone 'cd ~/p0-03/pwa && node server.mjs'

# 3. the quick tunnel, through the wrapper
ssh phone 'SSL_CERT_FILE=/etc/tls/cert.pem termux-chroot ~/.pupkeep/bin/cloudflared \
  tunnel --no-autoupdate --url http://127.0.0.1:8788'
```

Fresh ntfy topic, stored where the host will publish from:

```bash
T=$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')
ssh phone "umask 077; printf '%s' '$T' > ~/.pupkeep/ntfy-topic"

pub() { curl -sS -o /dev/null -w "%{http_code}\n" -H 'Title: Pupkeep' \
  -H "Priority: ${2:-default}" -d "$1" \
  "https://ntfy.sh/$(ssh phone 'cat ~/.pupkeep/ntfy-topic')"; }
```

**Smoke-test the harness before blaming the phone.** From this devcontainer,
through the tailnet (`~/.pi/bin/tailscale` is not on `PATH`; use the full path with
`--socket=$HOME/.pi/tailscale/tailscaled.sock`):

```bash
IP=<tailnet-ip>
curl -s -o /dev/null -w "%{http_code}\n" --socks5-hostname 127.0.0.1:1055 "http://$IP:8790/"            # 401
curl -s -o /dev/null -w "%{http_code}\n" --socks5-hostname 127.0.0.1:1055 "http://$IP:8790/login?key=x" # 403
curl -s --socks5-hostname 127.0.0.1:1055 "http://$IP:8790/status"                                        # {"ticks":…,"clients":…}
```

Expected (verified 2026-10-29): `401`, `403`, and a JSON status. If those fail,
stop and fix the host side.

## Setup on the iPhone (once)

1. **Tailscale** from the App Store → sign in to the same tailnet → VPN on.
   After 10 minutes confirm it is still on (Control Center): an iOS VPN that
   silently drops is the partner's most likely "the app is broken" report.
2. **Safari** → the invite link `http://<tailnet-ip>:8790/login?key=<token>` → it
   should redirect to `/` and show "signed in".
3. **Bookmark `http://<tailnet-ip>:8790/`** (Share → Add Bookmark). **Do not Add to
   Home Screen:** over HTTP the clip gets its own cookie jar — a second login —
   and no service worker, so it is strictly worse than a bookmark (§12.4).
   (The exception is W1–W3, which deliberately use A2HS over the HTTPS tunnel.)
4. **ntfy** from the App Store → Subscribe → `https://ntfy.sh/<topic>` → allow
   notifications when asked.

## Checks

Record each as **pass**, **fail**, or **fail — fallback taken**, with the
evidence named. Only N2 needs a stopwatch.

### Access over Tailscale (P0-03's partner rows)

| # | Check | How | Pass means |
|---|---|---|---|
| A1 | Tailnet reach and login | open the invite link in Safari | lands on `/` signed in; no `0.0.0.0` or LAN address involved (the host bind is checked by the smoke test, not by the iPhone) |
| A2 | Session survives a force-quit | swipe Safari away from the app switcher, reopen the bookmark | still signed in — no second invite-link round trip |
| A3 | Live update, foreground | watch the counter on `/` | it advances every ~2 s without a manual refresh |
| A4 | **What suspension does to the stream** | note `opens=`/`scriptResumes=`, switch apps 5 minutes, return | record which happened: counter already current (`opens` unchanged, stream survived), or `opens` incremented (browser reconnected by itself), or `scriptResumes` incremented (the page had to rebuild it). All three are results; the value that matters is *which*, because §9.4's snapshot/resume depends on it |
| A5 | Tailscale off | turn Tailscale off, reload | unreachable — record the exact error the partner sees, since it is what the runbook's copy must explain |

### Notifications (P0-08's partner rows)

| # | Check | How | Pass means |
|---|---|---|---|
| N1 | Arrival and content | ntfy app open; `pub 'Someone logged a feed' fed` | arrives; title is the constant `Pupkeep`, body is the category text, and nothing else: no dog, vet, appointment or health detail. This single inspection also covers "no care specifics" — do not check it twice |
| N2 | **Locked-phone latency** | lock the iPhone, put it down; `pub 'A meal is overdue' high`, then once with `max` | **pass: arrives in under 60 s at either priority.** **fail: absent, or later than 15 min** — that is not a reminder. Between 60 s and 15 min, record the seconds and **amend PLAN §2.3** (P0-09 is already recorded) rather than deciding alone. The per-priority sweep is only to see whether `max` earns anything on iOS, which its parity table says it does not filter on |
| N3 | Tap-through, and no action buttons | tap the notification with Tailscale on; also inspect it for buttons | Safari opens the tailnet URL (the harness `/today` is enough); **no action buttons exist**, so no flow may depend on one (§9.3) |
| N4 | Tailscale off, notification still arrives | turn Tailscale off, `pub 'An appointment reminder'`, tap it | notification arrives (it travels over ntfy's HTTPS, not the tailnet); tapping cannot open the app. This is the partner's real-world failure mode and must match what the in-app copy says |

### Test-only PWA/Web Push path (P0-03's remaining rows)

Only meaningful over the **HTTPS quick tunnel**: iOS needs HTTPS **and** Add to
Home Screen **and** 16.4+.

| # | Check | How | Pass means |
|---|---|---|---|
| W1 | A2HS over HTTPS | open the tunnel URL, Share → Add to Home Screen, launch from the icon | runs standalone, not as a Safari tab |
| W2 | Permission and subscribe | in the installed web app, tap a subscribe button (a user gesture is required) | the PWA server's `/status` shows one subscription with an `https` endpoint; note that this is a **separate storage context** from Safari, so it is a second sign-in |
| W3 | Cost of a tunnel restart | restart cloudflared → new URL → open it, A2HS again, subscribe again | record the **wall-clock minutes and the exact steps** the partner had to perform. The URL change itself is expected (§12.4); what is being measured is the cost, which is the input to P4-09's runbook and to any argument for a domain |

## Failure routing

| Failing check | What it means | What to do |
|---|---|---|
| smoke test, A1 | Tailscale or bind | check the bind address and that the phone is on the tailnet; **never** fall back to `0.0.0.0`; LAN or loopback is the explicit fallback (§6.10) |
| A2 | cookie/session on iOS Safari | record it; if a home-screen clip was used by mistake, redo with a bookmark |
| A3 | SSE delivery | host-side problem first: is `/sse` serving? then a Safari problem; file against §9.4 |
| A4 | suspension handling | this is the finding P1-09 needs: whatever the result, it decides whether the client relies on automatic `EventSource` reconnect or rebuilds the stream on `visibilitychange` |
| **A5 still loads** | the host is reachable without the tailnet — a bind violation, not an iOS quirk | stop, check what the process bound to (`ss -ltn` on the phone), and fix it before anything else; `0.0.0.0` is never acceptable |
| N1 | ntfy setup | re-check the topic string and notification permission |
| **N2 fail** | iOS push is not prompt enough for `feed_overdue` | **fallback:** in-app only for the partner, host-local keeps the host informed, and the domain/Web Push question reopens in P0-09 (if P0-09 is already written, amend it — do not wait for a later phase) |
| N3 | tap target | confirm `Click` carries the tailnet URL (P0-08 verified it leaves the host), then that Tailscale is on |
| N4 | notification absent with Tailscale off | the ntfy path is broken for another reason (topic, permission, app not running) — this one is independent of the tailnet, so recheck N1 rather than blaming iOS |
| W1/W2 | the test-only push path | the partner device has no Web Push path; keep Web Push host-only and change §12.4's wording |
| ntfy unavailable in the App Store region | the recommended partner path does not exist | in-app only, or a domain plus Web Push |

## Evidence to capture

- iOS version, ntfy version, Tailscale version — from Settings, not guessed.
- Screenshots: the notification (N1), the locked-phone arrival (N2), the tapped
  result (N3), the installed web app (W1).
- Seconds for N2 at `high` and at `max`; the A4 `opens=`/`scriptResumes=` values.
- The ntfy topic **prefix only** (6 chars) — never the whole topic, never the
  invite link, never an owner token.
- Tunnel URL only as `<random>.trycloudflare.com`; it is dead after the test.

## Where the result lands

- P0-03's and P0-08's notes get their partner rows filled in, or marked with the
  fallback taken.
- PLAN §16: P0-03/P0-08 are checked only if the rows pass; otherwise the fallback
  goes into §2.2 and §12.4 rather than a silent pass.
- P0-09 records the outcome for the notification split.

## If the iPhone stays unavailable

Phase 0 does **not** wait for it: G0 accepts "a measured answer **or** a documented
fallback", and the fallback for the partner path is *in-app only* — a shippable v1
for one household, with the host caregiver still notified locally.

What waits: P4-06's notification centre is not done, and P5-03's two-client E2E
does not run, until this passes. P1's host-side work is unblocked.
