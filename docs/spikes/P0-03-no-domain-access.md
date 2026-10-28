# P0-03 — No-domain access: Tailscale daily, quick tunnel test

**Task:** P0-03. **Date:** 2026-10-28. **Status:** partial — host-side access
verified; the partner phone has not been tested. P0-03 is **not** checked in
PLAN §16.

**Verdict:** the host phone has a visible Tailscale address, a scratch HTTP
server bound only to that address is reachable from another tailnet node, and
the no-Tailscale path fails closed instead of binding `0.0.0.0`. The Termux
`cloudflared` package does not exist, but Cloudflare’s arm64 release binary runs
under `termux-chroot` with `SSL_CERT_FILE` and produces a working HTTPS quick
tunnel; restarting it changes the URL. A test PWA on that HTTPS origin accepted a
Web Push subscription from the host phone’s Chrome. The Windows desktop on the
same tailnet reached the host over Tailscale, but the partner phone itself was
not used; that remaining check keeps P0-03 open.

## Environment

| Field | Value |
|---|---|
| Host phone | Samsung `SM-G998B`, Android `15` / SDK `35`, `arm64-v8a` |
| Termux | `0.118.3` from F-Droid |
| Node | `v26.12.1` |
| Tailscale interface in Termux | `tun1` = `100.x.x.61` (`wlan0` = `192.168.x.20`) |
| Tailscale Android app | `com.tailscale.ipn` `1.104.2-tc3430f0d2-gb01fa89d5` |
| Other tailnet peers seen | devcontainer `100.x.x.63`, Windows desktop `100.x.x.25` |
| PWA test device | **host phone Chrome** (not the partner phone) |
| Tailscale reach test | Windows desktop `100.x.x.25`; partner phone still pending |

## Results

| # | Check | Evidence | Result |
|---|---|---|---|
| 1 | Termux sees the Tailscale address | `os.networkInterfaces()`: `tun1` `100.x.x.61/32`; `ifconfig tun1` same | **pass** |
| 2 | Scratch server binds the Tailscale address only | server on `100.x.x.61:8787`; from devcontainer `curl http://100.x.x.61:8787/` = 200; from the phone, `127.0.0.1:8787` and `192.168.x.20:8787` both refused | **pass** |
| 3 | Missing Tailscale address fails closed | simulated no-Tailscale interface list: `prepare(tailscale)=false`, `bindHost(tailscale)=127.0.0.1` (never `0.0.0.0`); explicit `lan` is the only `0.0.0.0` path | **pass** |
| 4 | Termux `cloudflared` package source | `pkg show cloudflared` → `E: No packages found` | **fail (package absent)** |
| 5 | arm64 `cloudflared` binary fallback | `~/.pupkeep/bin/cloudflared` 36 MB, version `2026.10.5`; direct run fails DNS on `[::1]:53`, `termux-chroot` alone fails CA verification; `SSL_CERT_FILE=/etc/tls/cert.pem termux-chroot …` works | **pass with a wrapper** |
| 6 | Quick tunnel serves HTTPS | `https://<random-1>.trycloudflare.com` and `https://<random-2>.trycloudflare.com` returned HTTP/2 200 from the devcontainer and the phone | **pass** |
| 7 | Tunnel restart changes the URL | first URL `<random-1>`, after restart `<random-2>` | **pass** |
| 8 | PWA install and Web Push subscription | host phone Chrome opened the HTTPS page, installed it, and subscribed; server `/status`: one subscription, `endpoint` scheme `https`, `p256dh` length 87, `auth` length 22 | **pass on host phone** |
| 9 | Partner phone reaches the host over Tailscale | Windows desktop `100.x.x.25` opened `http://100.x.x.61:8787/` and got `p0-03 scratch server` (user-confirmed); the partner phone itself has not been tested | **partial — Windows desktop** |
| 10 | Android Tailscale app exposes Serve/Funnel | app `1.104.2`; `aapt dump strings` has `Run as exit node` / `Now running as exit node` but no Funnel or Serve feature label; tailnet reports `ExitNodeOption=false` (exit-node approval pending) | **no** |

## Commands and evidence

Tailscale interface and bind:

```text
tun1 100.x.x.61/32
wlan0 192.168.x.20/24
```

Scratch server:

```text
from devcontainer: curl http://100.x.x.61:8787/ -> 200 "p0-03 scratch server"
on phone: 127.0.0.1:8787 -> connection refused
on phone: 192.168.x.20:8787 -> connection refused
```

Fail-closed simulation (`~/p0-03/failclosed.mjs` on the phone):

```text
{"realTailscale":"100.x.x.61"}
prepare(tailscale)=true bindHost=100.x.x.61
prepare(tailscale)=false: Tailscale is not connected; refuse to start
bindHost(tailscale, fakeNoTailscale)=127.0.0.1
bindHost(lan, real)=0.0.0.0 (explicit LAN only)
```

Cloudflared:

```text
pkg show cloudflared -> E: No packages found
~/.pupkeep/bin/cloudflared --version -> cloudflared version 2026.10.5
direct: failed to request quick Tunnel: ... lookup api.trycloudflare.com on [::1]:53 ... connection refused
termux-chroot: ... tls: failed to verify certificate: x509: certificate signed by unknown authority
working: SSL_CERT_FILE=/etc/tls/cert.pem termux-chroot ~/.pupkeep/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8788
```

The working command reached `Registered tunnel connection` and passed the
Cloudflare pre-checks. `termux-chroot` provides `$PREFIX/etc/resolv.conf`
(`8.8.8.8`, `8.8.4.4`) at `/etc/resolv.conf`; `SSL_CERT_FILE=/etc/tls/cert.pem`
uses Termux’s CA bundle. **P1-04 cannot `spawn` the raw binary on Termux**: it
must use this wrapper (or run cloudflared on the VPS/devcontainer instead).

PWA test page:

- Scratch files at `~/p0-03/pwa` on the phone; not in the repository.
- Served `/`, `/manifest.webmanifest`, `/sw.js`, `/icon-192.png`,
  `/icon-512.png` over the quick tunnel.
- The page asked Chrome for notification permission and called
  `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.
- Server recorded subscription #1 at `2026-10-28T17:35:32.438Z`; it deliberately
  did **not** log or return the endpoint or keys, only their lengths.
- The quick tunnel and PWA server were stopped after the test. The public URL is
  no longer live.

## URL change and re-subscribe

The quick tunnel URL is new for every cloudflared process. The two URLs above
were both HTTP 200; the second was used for the PWA test. A PWA and its push
subscription are bound to the origin, so after a restart the test device must
open the new URL, reinstall the PWA, and subscribe again. This spike observed
the URL change and performed the subscription on the second URL; it did not
repeat install/subscribe across a third URL.

## Tailscale Serve/Funnel vs exit node

The Android app exposes **exit node** controls, not Serve/Funnel. The host phone
was set to `Run as exit node`, and the app strings confirm that mode
(`Run as exit node`, `Now running as exit node`, `Stop running as exit node`).
But the tailnet seen from the devcontainer still reports
`ExitNode: false`, `ExitNodeOption: false` for the phone; the app says the exit
node must be approved in the admin console before other devices can use it.
That is a different feature from Serve/Funnel: an exit node routes internet
traffic, while Serve/Funnel publishes a local service. The app has no Funnel or
Serve control, so Tailscale HTTPS is not available from this host.

## Blockers and fallback

- **Partner phone:** the second-device reach check used the Windows desktop,
  not the partner phone. That proves the host’s Tailscale bind works from a real
  tailnet node, but the partner-phone check is still open, so P0-03 stays
  unchecked. To close it, sign the partner phone into the same tailnet, open
  `http://100.x.x.61:8787/`, then open the live quick-tunnel URL in the partner
  browser, install the test PWA and subscribe to Web Push. Re-subscribe after a
  tunnel restart. (The host-phone PWA/subscription test is not a partner-phone
  substitute.)
- **Cloudflared on Termux:** package absent; the arm64 binary needs
  `termux-chroot` + `SSL_CERT_FILE`, which the production launcher must either
  implement or avoid by running the tunnel on a VPS/devcontainer. This is a
  P1-04 implementation constraint, not a reason to bind publicly.
- **Serve/Funnel:** the Android app does not expose it, so the plan’s
  Tailscale-HTTPS alternative is not available. Tailscale stays HTTP; the quick
  tunnel stays testing-only. If a domain appears, a named tunnel is the upgrade.
- **Exit node:** the app’s `Run as exit node` switch is not readable from
  Termux. The tailnet reports the phone as `ExitNodeOption=false` (not
  advertising); the owner should confirm the app switch is off after the test.
  Exit node is not Serve/Funnel.
- **Quick tunnel is public and temporary.** It is not a daily access path, and
  the PWA/push subscription must not be treated as stable across restarts.

If Tailscale binding fails entirely, PLAN §6.10 says use LAN or the quick tunnel
explicitly; never silently bind `0.0.0.0`.

## What P1-04/P1-13 can rely on

- `tailscaleAddress()` can detect the Android `tun1` address; `tailscale` mode
  can bind it and is reachable from another tailnet node.
- The fail-closed rule is testable without stopping Tailscale: an injected
  no-Tailscale interface list must refuse to start, and the fallback bind is
  loopback, not `0.0.0.0`.
- Cloudflared on Termux needs a wrapper: package absent, raw binary has no
  `/etc/resolv.conf`, and CA verification needs `SSL_CERT_FILE=/etc/tls/cert.pem`
  under `termux-chroot`.
- HTTPS quick tunnels work on this phone and change URL on restart; PWA/Web Push
  subscription works on Android Chrome over that origin.
- The daily Tailscale path is reachable from a second tailnet device; the
  partner phone itself remains the open P0-03 check. Tailscale Serve/Funnel is
  not available on the Android app, so the plan’s HTTP/HTTPS split stands.

## Not verified

- The partner phone’s own Tailscale client, browser and PWA install. The reach
  test used the Windows desktop.
- Reinstall/re-subscribe after a third tunnel URL; the URL change was observed,
  but the PWA subscription was created on the second URL only.
- A real push delivery after subscription; P0-03 proves the subscription, not
  delivery (P0-08/P4-05).
