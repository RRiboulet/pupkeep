# Partner iPhone acceptance checklist (P0-10)

**Status:** scheduled, never run. **Owner:** the household owner, on the partner's
iPhone. This is the only Phase 0 work that needs a second phone.

It carries the partner-phone rows that P0-03 and P0-08 could not close, re-expressed
for an **iPhone** (the partner's device) instead of the Android phone they were
written against. Everything else in Phase 0 is measured on the host phone and this
devcontainer and does not wait for this.

## What this proves, and what it does not

| Proves | Does not prove |
|---|---|
| The partner's iPhone reaches the host over Tailscale and can log in | Anything about the real app — there is no app code until P1 |
| Live updates work while the tab is foreground, and recover after iOS suspends it | That a backgrounded Safari tab updates live (it will not; §12.4) |
| Whether an ntfy notification arrives **promptly while the phone is locked** | Android behaviour (already measured, P0-08) |
| The notification's tap target opens the tailnet URL | Any push path over Tailscale HTTP (there is none on iOS) |
| The quick-tunnel PWA/Web Push test path, and that it dies with the tunnel URL | A daily HTTPS origin (no domain, no named tunnel) |

## Before the session — host side (~10 minutes)

**Already on the phone from P0-03/P0-08 — reuse, don't rebuild:**

| Path | What it is |
|---|---|
| `~/p0-03/pwa/server.mjs` | scratch PWA server, binds `127.0.0.1:8788`, serves the page, manifest, service worker and icons, plus `POST /subscribe` and `GET /status` |
| `~/p0-03/pwa/{index.html,sw.js,manifest.webmanifest,icon-192.png,icon-512.png}` | the test PWA itself |
| `~/.pupkeep/bin/cloudflared` | arm64 binary; only works as `SSL_CERT_FILE=/etc/tls/cert.pem termux-chroot ~/.pupkeep/bin/cloudflared …` |
| `~/.pupkeep/ntfy-topic` | the **P0-08 spike topic** — do not reuse it; mint a fresh one |

**What P0-10 needs and does not exist yet:** a scratch server bound to the
**tailnet address** with an **SSE endpoint**. P0-03 only had a trivial `:8787`
responder bound that way, and the PWA server above binds loopback for the tunnel.
Smallest path: copy `server.mjs` to `~/p0-10/`, take the bind address from argv
(`100.x.x.61`, never `0.0.0.0`), and add a `/sse` route that emits a tick every
few seconds. Roughly 30 lines; without it, A3 and A4 cannot be checked.

```bash
# 1. phone reachable? (expected: "OK")
timeout 20 ssh phone 'echo OK'

# 2. fresh ntfy topic (192 bits) — store it 0600 on the phone
node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))'

# 3. scratch server on the tailnet address + the tunnel pointed at loopback
ssh phone 'node ~/p0-10/server.mjs 100.x.x.61 8787'
ssh phone 'SSL_CERT_FILE=/etc/tls/cert.pem termux-chroot ~/.pupkeep/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8788'
```

Have ready, and **do not paste them into this file or into any issue**: the ntfy
topic, the invite link, the owner token if the scratch server mints one.

## Setup on the iPhone (once)

1. **Tailscale** from the App Store → sign in to the same tailnet → VPN on.
   Leave it on; the daily path depends on it. After 10 minutes, confirm it is
   still on (Control Center), because an iOS VPN that silently drops is the
   partner's most likely "the app is broken" report.
2. **Safari** → `http://100.x.x.61:<port>/` (P0-03's tailnet address) → follow the
   invite link → land on the Today screen.
3. **Bookmark it** (Share → Add Bookmark). **Do not Add to Home Screen:** over
   HTTP the clip gets its own cookie jar — a second login — and no service worker,
   so it is strictly worse than a bookmark (§12.4).
4. **ntfy** from the App Store → Subscribe → `https://ntfy.sh/<topic>` → allow
   notifications when asked.

## Checks

Record each result as **pass**, **fail**, or **fail — fallback taken**, with the
evidence named. Timings matter only on the locked-phone row.

### Access over Tailscale (P0-03's partner rows)

| # | Check | How | Pass means |
|---|---|---|---|
| A1 | Tailnet reach | Safari opens the tailnet URL | page renders; no `0.0.0.0` or LAN address is used |
| A2 | Login and session | log in via the invite link, force-quit Safari, reopen the bookmark | still logged in |
| A3 | Live update, foreground | from the host, append to a domain document; watch the tab | the Today view updates without a manual refresh |
| A4 | Recovery after suspension | background Safari (switch apps) 5 minutes, return | state is current; no duplicate entries; no stale banner |
| A5 | Wrong network | iPhone on cellular with Tailscale **off** | the app is unreachable (expected); note the error the partner sees |

### Notifications (P0-08's partner rows)

| # | Check | How | Pass means |
|---|---|---|---|
| N1 | Baseline arrival | ntfy app open; host publishes `fed` | arrives, correct constant title and category text |
| N2 | **Locked-phone latency** | lock the iPhone, put it down; host publishes `feed_overdue` (priority `high`, then `max`) | arrives; record seconds for each priority |
| N3 | Tap-through | tap the notification with Tailscale on | Safari opens the tailnet URL at the relevant screen |
| N4 | Content hygiene | read N1–N3 payloads on the phone | constant title + category text only; no dog, vet, appointment or health detail |
| N5 | No action buttons | inspect the notification | none (upstream says iOS has none; confirm, since no flow may depend on one — §9.3) |
| N6 | Tailscale off, notification arrives | turn Tailscale off, publish `appointment`, tap it | notification still arrives; tapping cannot open the app — this is the partner's real-world failure mode and must match what the in-app copy tells them |

### Test-only PWA/Web Push path (P0-03's remaining rows)

Only meaningful over the **HTTPS quick tunnel**; iOS needs HTTPS **and** Add to
Home Screen **and** 16.4+.

| # | Check | How | Pass means |
|---|---|---|---|
| W1 | A2HS over HTTPS | open the tunnel URL, Share → Add to Home Screen, launch from the icon | runs standalone, not as a Safari tab |
| W2 | Permission and subscribe | in the installed web app, tap a subscribe button (a user gesture is required) | `/status` on the host shows one subscription with an `https` endpoint |
| W3 | **Re-subscribe after a tunnel restart** | restart cloudflared → new URL → open, A2HS again, subscribe | explained as expected: the subscription is origin-bound, so the partner must reinstall on a new URL. Record how much of that is manual. |

## Failure routing

| Failing check | What it means | What to do |
|---|---|---|
| A1 | Tailscale or bind | `tailscale status` from the devcontainer; confirm the `100.x` address on both sides. **Never** fall back to `0.0.0.0`; LAN or loopback is the explicit fallback (§6.10) |
| A2 | Cookie/session problem on iOS Safari | record it; if a home-screen clip was used by mistake, redo with a bookmark |
| A3/A4 | `EventSource` or snapshot/resume bug | this is a P1-09 defect, not a device limit — file it against §9.4 |
| N1 | ntfy setup | re-check the topic string and notification permission |
| **N2 late by > 15 min or absent** | iOS push is not prompt enough for `feed_overdue` | **fallback:** in-app only for the partner, host-local keeps the host informed, and the domain/Web Push decision moves up in P0-09 |
| N3 | tap target | check `Click` carries the tailnet URL (P0-08 verified it arrives), then that Tailscale is on |
| W1/W2 | the test-only push path | the partner device has no Web Push path; Web Push stays host-only and §12.4's wording changes |
| ntfy unavailable in the App Store region | the recommended partner path does not exist | in-app only, or a domain plus Web Push |

## Evidence to capture

- iOS version, ntfy version, Tailscale version — from Settings, not guessed.
- Screenshots: the notification (N1), the locked-phone arrival (N2), the tapped
  result (N3), the installed web app (W1).
- Seconds for N2 at `high` and at `max`.
- The ntfy topic **prefix only** (6 chars) — never the whole topic, never the
  invite link, never an owner token.
- The tunnel URL only as `<random>.trycloudflare.com`; it is dead after the test.

## Where the result lands

- P0-03's and P0-08's notes get their partner rows filled in, or marked as the
  fallback taken.
- PLAN §16: P0-03/P0-08 are checked only if the rows pass; the fallback goes into
  §2.2 and §12.4 instead of a silent pass.
- P0-09 records the outcome for the notification split.

## If the iPhone stays unavailable

Phase 0 does **not** wait for it: G0 accepts "a measured answer **or a documented
fallback**", and the fallback for the partner path is *in-app only* — a real,
shippable v1 for one household, with the host caregiver still notified locally.

What does wait is the claim that the partner is reached out-of-app. Concretely:
P0-10 must run before P4-06's notification centre is called done, and before P5-03's
two-client E2E. P1's host-side work is unblocked.
