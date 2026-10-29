# P0-08 — No-domain notification path: host Termux:API local + partner ntfy

**Task:** P0-08. **Date:** 2026-10-29. **Status:** partial — the host-local
notification and the ntfy publish/receive mechanism are measured on the host
phone; no partner phone was used, so P0-08 is **not** checked in PLAN §16. The
partner device is an **iPhone**, and the iOS-specific rows below are taken from
upstream documentation, not measured here. The partner-device rows are carried
by **P0-10** (`docs/partner-ios-checklist.md`).

**Verdict:** `termux-notification` delivers a host-local notification, including
a custom high-importance channel, sound and pinning, and
`termux-notification-list` proves delivery without anyone watching the screen —
which also exposed the one real trap: an invalid channel id is **silently
dropped and still exits 0**. A per-user ntfy topic with 192 bits of entropy
receives category-only messages published from the phone over ntfy's own HTTPS
endpoint (~0.4 s per publish, ~0.4 s to a second subscriber), and ntfy's
`Click`/`Actions` fields point the partner at the **private Tailscale URL**. So
the partner path carries neither a public app URL nor any care specific. The
partner phone itself was not exercised; that row keeps P0-08 open.

## Environment

| Field | Value |
|---|---|
| Host phone | Samsung `SM-G998B`, Android `15` / SDK `35`, `arm64-v8a` |
| Termux | `0.118.3`; `termux-api` `0.60.0`; `com.termux.api` and `com.termux.boot` installed |
| Node | `v26.12.1` |
| Notification service | `ntfy.sh`, free tier, **no account, no token** |
| Second device (receipt) | this devcontainer, `curl` SSE subscriber |
| Partner phone | **iPhone, not used** — the receipt row is a second tailnet/devcontainer device, not the partner's phone |
| App server during the test | **not running** — no Pupkeep server exists yet (P1) |

## Results

| # | Check | Evidence | Result |
|---|---|---|---|
| 1 | Host-local notification, default channel | `termux-notification --title --content` exit `0`; visible on the phone (user-confirmed) | **pass** |
| 2 | Custom notification channel | `termux-notification-channel pupkeep-alerts "Pupkeep alerts"` (positional args) then `--channel pupkeep-alerts`; notification visible (user-confirmed) | **pass** |
| 3 | Invalid channel id | `--channel pupkeep-ghost` exit `0`, but the notification is absent from `termux-notification-list` — dropped, not posted | **pass (failure mode found)** |
| 4 | Sound and priority | `--sound --priority high` on the channel notification; visible (user-confirmed) | **pass** |
| 5 | Pinning and max priority | `--ongoing --priority max --group pupkeep` exit `0`; in the active list. Pinning is not readable from outside | **partial — posted, pinning not observed** |
| 6 | Tap action | `--action "termux-open-url http://100.x.x.61:8787/today"` exit `0`, present in the active list; the tap itself was not exercised | **partial — posted, tap not exercised** |
| 7 | Programmatic delivery proof | `termux-notification-list` returns JSON per active API notification: `id`, `tag` (the `--id` value), `title`, `content`, `packageName: com.termux.api`, `when`. No `priority`/`ongoing`/channel fields | **pass (this is the verification hook)** |
| 8 | Removal | `termux-notification-remove <id>`, **positional**; `--id` fails with `illegal option --` and exit `1` | **pass (API shape recorded)** |
| 9 | ntfy publish from the phone | four category-only messages, `HTTP/2 200` each from the phone with no app server running | **pass** |
| 10 | Second-device receipt | 4/4 messages over the ntfy SSE stream, all titles and priorities as sent | **pass** |
| 11 | Delivery latency | devcontainer publish → devcontainer SSE receipt: **377 ms**; phone `curl` publish `time_total` **0.386 / 0.400 / 0.371 s** | **pass** |
| 12 | Topic entropy and storage | `crypto.randomBytes(24)` → 32-char base64url = **192 bits**; stored at `~/.pupkeep/ntfy-topic`, mode `0600` in a `0700` dir | **pass** |
| 13 | Unauthenticated publish to any topic | a never-used 192-bit topic accepted a publish with `200`; no account, no token | **pass (see privacy note)** |
| 14 | Unknown topic reads empty | fresh topic polled before any publish: 0 messages | **pass** |
| 15 | Cache and backlog | after publishing, a *new* subscriber polling `?poll=1&since=all` received the backlog; ntfy.sh caches messages 12 h | **pass** |
| 16 | Tap target without exposing the app | `Click:` and `Actions: view, Open Today, <url>, clear=true` arrive intact in the subscriber payload, pointing at `http://100.x.x.61:…` | **pass** |
| 17 | Priority and tag mapping | `default` → `3`, `high` → `4`, `max` → `5`; `Tags: bell` arrives as `["bell"]` | **pass** |
| 18 | Payload hygiene | the four messages below; no dog name, vet name, appointment title, weight or health text | **pass** |
| 19 | **Partner phone receives** the messages | not attempted: no partner phone this session. The partner's device is an iPhone, so this row is **P0-10**, run from `docs/partner-ios-checklist.md` | **open — P0-10** |
| 20 | ntfy delivery while the phone dozes / app killed | ntfy docs describe a foreground-service connection on the F-Droid build and FCM on the Play build; not measured here | **documented, not measured** |

## Payload policy (the four categories, as published)

| Category | Title | Body | ntfy priority | Recipient |
|---|---|---|---|---|
| `fed` | `Pupkeep` | `Someone logged a feed` | `default` (3) | the other caregiver |
| `feed_overdue` | `Pupkeep` | `A meal is overdue` | `high` (4) | both |
| `appointment` | `Pupkeep` | `An appointment reminder` | `default` (3) | both |
| `approval` | `Pupkeep` | `The agent needs your confirmation` | `high` (4) | both |

Rules this fixes for P4-05/P4-06:

- **Category-only is a property of the payload, not of the reader.** ntfy.sh is
  a third-party server that stores the text for 12 h; anything rich enough to
  leak a dog name, a vet clinic, an appointment title or a health remark leaks
  it to that server and to anyone who learns the topic.
- **The topic name is the whole authentication.** Publishing to *any* topic is
  unauthenticated (row 13), so a leaked topic is both a read and a write
  capability. It belongs in `~/.pupkeep` at `0600`, and logs may record a prefix
  and length only — never the topic.
- **The tap target is the private path.** `Click`/`Actions` point at the
  Tailscale URL, so the notification itself travels over a public relay while
  the app stays tailnet-only. Nothing about the app URL needs to be public for
  the partner to act on a notification.
- **The title is constant** (`Pupkeep`); urgency rides on `priority`, not on
  extra words in the title.
- **The in-app centre stays the source of truth**; ntfy and the host-local
  notification are best-effort mirrors (in-app mirror is P4-06).

## Commands and evidence

Channel creation is positional — the `--id/--name` form prints usage and
**exits 0 without creating anything**, which is why the first channel test
produced a dropped notification:

```text
$ termux-notification-channel pupkeep-alerts "Pupkeep alerts"     # correct
$ termux-notification-channel --id pupkeep-alerts --name "…"      # prints usage, exit 0, no channel
```

Posting, and the drop that a zero exit code hides:

```text
termux-notification --title "Pupkeep" --content "A meal is overdue" \
  --channel pupkeep-alerts --priority high --id p0-08-overdue --sound   # exit 0, visible

termux-notification --title "P0-08 bad channel" --content "…" \
  --channel pupkeep-ghost --id p0-08-ghost                              # exit 0, NOT in the list
```

`termux-notification-list` is the only trustworthy delivery check:

```json
{"id":0,"tag":"p0-08-overdue","key":"0|com.termux.api|0|p0-08-overdue|10178",
 "packageName":"com.termux.api","title":"Pupkeep","content":"A meal is overdue"}
```

Publishing from the phone (no app server running, no account):

```sh
pub() { curl -sS -o /dev/null -w "%{http_code}\n" \
  -H 'Title: Pupkeep' -H "Priority: $1" -H 'Tags: bell' \
  -d "$2" "https://ntfy.sh/$(cat ~/.pupkeep/ntfy-topic)"; }
pub high 'A meal is overdue'            # 200
```

What a subscriber receives, including the private tap target:

```json
{"event":"message","topic":"<192-bit topic>","title":"Pupkeep",
 "message":"A meal is overdue","priority":4,"tags":["bell"],
 "click":"http://100.x.x.61:8787/today",
 "actions":[{"action":"view","label":"Open Today","clear":true,"url":"http://100.x.x.61:8787/today"}]}
```

## Failure modes

- **Invalid channel id drops the notification with exit `0`.** The production
  sender must create the channel at startup and must not treat a `0` as proof of
  delivery; either verify with `termux-notification-list` or don't use
  `--channel` at all.
- **`termux-notification-remove` takes a positional id**, and rejects `--id`.
  Cancelling a reminder (P4-04) has to call it correctly or the reminder stays in
  the shade.
- **No Termux process, no new notification.** The command is a proxy into
  `com.termux.api`; the *posted* notification survives a Termux kill, but the
  *ability to post* dies with the server (P0-06 covers the restart path).
- **Doze/battery optimisation can delay delivery**, and the Play-store ntfy
  build delivers through FCM, which its own documentation describes as delayed;
  the F-Droid build keeps its own connection. This is a recommendation to the
  partner, not something v1 can enforce — and it is **not measured here**.
- **A leaked topic is a read *and* write capability.** Rotation means minting a
  new topic, updating `~/.pupkeep`, and re-subscribing the partner app; the old
  name is not revocable on the free tier, only expirable (12 h cache).
- **No server-side dedupe.** ntfy will happily deliver the same category twice;
  the dedupe key stays in `app.notifications` (PLAN §12.3), not in ntfy.
- **The relay is a third party.** Message text sits on ntfy.sh for 12 h; the
  category-only rule above is what makes that acceptable.

## The partner device is iOS

Upstream-documented, **not measured** — there was no iPhone in this session.
Everything the Android client does natively is either absent or degraded on iOS,
and one claim that would have been true on Android is false here:

| Question | Answer | Source |
|---|---|---|
| Instant delivery | **not supported on iOS**; foreground services don't exist there, so delivery depends on Apple push plus background tasks | ntfy-ios `FEATURE_PARITY.md` (last updated 2023-05-23), `TECHNICAL_LIMITATIONS.md` |
| How the App Store app gets pushed | topics on the **default server** are relayed through ntfy.sh's Firebase credentials; that is what makes an ntfy.sh topic arrive without the app running | ntfy-ios `TECHNICAL_LIMITATIONS.md` |
| **Self-hosted** ntfy on iOS | reliable delivery only with [`upstream_base_url`](https://docs.ntfy.sh/config/#ios-instant-notifications), i.e. the self-hosted server relays to ntfy.sh. Without the relay the app relies on background polling, which the author measured as running *once in a day* — and a poll slower than the 12 h cache loses messages outright | ntfy-ios `TECHNICAL_LIMITATIONS.md` |
| ntfy `Actions` buttons (`view, Open Today, …`) | **not available** — iOS lists `Click` as “only direct notification click” | `FEATURE_PARITY.md` |
| ntfy priority filtering | not on iOS (“no priority filtering”); the priority is carried, its iOS presentation is unverified | `FEATURE_PARITY.md` |
| Web Push | needs HTTPS **and** Add to Home Screen **and** iOS 16.4+. Over Tailscale HTTP there is no push on iOS at all | [WebKit: web push for web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) |
| Add to Home Screen over HTTP | a web clip with its **own storage and cookie jar** and **no service worker** (insecure context): the partner would log in a second time and gain no offline or push | Apple/WebKit |
| SSE while backgrounded | iOS suspends background tabs; live updates are foreground-only and the stream reconnects on return | Apple |

Consequences for the daily path, which are what P0-03's and P0-08's remaining
rows have to be re-expressed as — the runnable procedure is
`docs/partner-ios-checklist.md` (P0-10):

- The partner's daily UI is a **Safari tab or bookmark**, not an installed PWA.
  A2HS on iOS over HTTP buys a separate login and nothing else.
- A notification is **tap-through only**: the `Click` target still works (open
  the tailnet URL in Safari), but there are no action buttons, so no approval or
  feed-cancel flow may depend on one. Approvals stay in-app (PLAN §9.3).
- Keeping topics on **ntfy.sh** is what gives the iPhone a real push. The
  self-hosting upgrade is not free of consequence on iOS: it either relays
  back to ntfy.sh (`upstream_base_url`) and keeps the third-party dependency it
  was meant to remove, or it accepts lossy background polling.

## Fallback and upgrade path

- **If the partner rejects ntfy:** in-app only (no reliable out-of-app signal on
  HTTP), or buy a domain and use Web Push over HTTPS. Do not pretend Tailscale
  HTTP has Web Push (PLAN §6.10, §12.4).
- **Self-hosted upgrade:** ntfy is a single binary (or a container) that can run
  on the VPS fallback of PLAN §6.9; it then needs its own HTTPS front and topic
  ACLs, and the partner's app points at the custom server URL. **On iOS this is
  not a free swap** — see the table above: either configure `upstream_base_url`
  (self-hosted, but still pushed through ntfy.sh) or accept background polling
  that can silently drop reminders. Take this path only if the 12 h third-party
  cache or the unauthenticated-publish model is unacceptable *and* the relay
  caveat is accepted.
- **Do not** put ntfy behind the Cloudflare quick tunnel: the URL changes on
  restart, and the partner client would lose its server on every restart.

## What P4-05/P4-06 can rely on

- `termux-notification --title --content --id --priority --sound [--ongoing]`
  works on this phone; `--id` per `(category, subject)` makes an update replace
  the previous notification instead of stacking.
- Create the channel once with the positional
  `termux-notification-channel <id> <name>`; treat a `0` exit as "the API was
  reachable", never as "the notification was shown".
- `termux-notification-list` / `termux-notification-remove <id>` are the
  measurable cancel/verify hooks for P4-04's reminder cancellation.
- The partner path is one per-user topic in `~/.pupkeep/ntfy-topic` (`0600`),
  category-only text from a shared constants module, `Click` at the Tailscale
  URL, and priority `max` reserved for `approval`/`feed_overdue`. Design for
  **tap-through only**: `Actions` buttons are Android-only, so a flow that needs
  a decision from the notification itself does not exist for an iOS partner.
- The transport is independent of the app origin: the app can stay
  tailnet-only, unexposed, and still notify the partner.

## Not verified

- The partner phone: ntfy app install, permission, notification rendering and
  actual arrival. The receipt row was this devcontainer.
- **Every iOS row** in the iOS section above is upstream documentation, not a
  measurement. Nothing here was tested on an iPhone: push timeliness, the
  `Click` tap, priority presentation, background behaviour.
- Delivery while the host phone is dozing, and the Play-vs-F-Droid ntfy build
  difference in practice.
- Tapping a notification (`--action` / ntfy `Click`) — posted, not exercised.
- Pinning (`--ongoing`) from the device's point of view.
- A notification posted while the Termux app is killed, then restored.
- The in-app mirror itself — that is P4-06, not Phase 0.
- Real Web Push delivery over the quick tunnel — P0-03's remaining row, P4-05.
