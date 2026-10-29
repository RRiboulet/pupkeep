# P0-08 — No-domain notification path: host Termux:API local + partner ntfy

**Task:** P0-08. **Date:** 2026-10-29. **Status:** partial — the host-local
notification and the ntfy publish/receive mechanism are measured on the host
phone; no partner phone was used, so P0-08 is **not** checked in PLAN §16. The
partner device is an **iPhone**, and the iOS-specific rows below are taken from
upstream documentation, not measured here. The partner-device rows are carried
by **P0-10** (`docs/partner-ios-checklist.md`).

**Verdict:** `termux-notification` delivers a host-local notification, including
a custom channel plus sound and priority at the notification level, and
`termux-notification-list` proves delivery without anyone watching the screen —
which also exposed the one real trap: an invalid channel id is **silently dropped
and still exits 0**. A per-user ntfy topic with 192 bits of entropy receives
category-only messages published from the phone over ntfy's own HTTPS endpoint
(~0.4 s per publish), a second subscriber in this devcontainer received all four
in 377 ms, and ntfy's `Click`/`Actions` fields point the partner at the **private
Tailscale URL**. So the partner path carries neither a public app URL nor any care
specific. The partner's own device was not exercised; that row keeps P0-08 open.

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
| 2 | Custom notification channel | `termux-notification-channel pupkeep-alerts "Pupkeep alerts"` (positional args) then `--channel pupkeep-alerts`; notification visible (user-confirmed). The channel's **importance is not settable**: the command sends only `--es id` and `--es name` | **pass (custom channel, default importance)** |
| 3 | Invalid channel id | `--channel pupkeep-ghost` exit `0`, but the notification is absent from `termux-notification-list` — dropped, not posted | **pass (failure mode found)** |
| 4 | Sound and priority | `--sound --priority high` posted on that channel; the notification was visible (user-confirmed). Audibility and heads-up presentation were not independently verified | **partial — posted, presentation unverified** |
| 5 | Pinning and max priority | `--ongoing --priority max --group pupkeep` exit `0`; in the active list. Pinning is not readable from outside | **partial — posted, pinning not observed** |
| 6 | Tap action | `--action "termux-open-url http://100.x.x.61:8787/today"` exit `0`, present in the active list; the tap itself was not exercised | **partial — posted, tap not exercised** |
| 7 | Programmatic delivery proof | `termux-notification-list` returns JSON for **every active notification**, not just this app's: the sample below also contained `android` and `com.termux` entries. Fields per entry: `id`, `tag` (the `--id` value), `title`, `content`, `packageName`, `group`, `when`. No `priority`/`ongoing`/channel fields. **Any P4-06 check must filter `packageName === "com.termux.api"` (and its `tag`), or it will read other apps' notification text** | **pass (this is the verification hook, with a filter)** |
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

Channel creation is positional, and its failure mode is exit 0. `$PREFIX/bin/termux-notification-channel`
accepts only `-d <id>` or `<id> <name>`, sends **only** `--es id`/`--es name`, and
its `show_usage` function ends in `exit 0` — so a wrong invocation looks like
success and creates nothing:

```text
$ termux-notification-channel pupkeep-alerts "Pupkeep alerts"     # correct
$ termux-notification-channel --id pupkeep-alerts --name "…"      # prints usage, exit 0, no channel
```

Because no importance is sent, `pupkeep-alerts` is a **default-importance**
channel; `--priority high` is a notification-level flag and does not raise it.
That is the one thing this note originally got wrong.

Posting, and the drop that a zero exit code hides:

```text
termux-notification --title "Pupkeep" --content "A meal is overdue" \
  --channel pupkeep-alerts --priority high --id p0-08-overdue --sound   # exit 0, visible

termux-notification --title "P0-08 bad channel" --content "…" \
  --channel pupkeep-ghost --id p0-08-ghost                              # exit 0, NOT in the list
```

`termux-notification-list` is the only trustworthy delivery check, and it lists
every active notification on the device — five were active at the peak, two of
them belonging to `android` and `com.termux`, and `p0-08-ghost` was absent from
all of them:

```json
{"id":0,"tag":"p0-08-overdue","key":"0|com.termux.api|0|p0-08-overdue|10178",
 "group":"","packageName":"com.termux.api","title":"Pupkeep",
 "content":"A meal is overdue","when":"2026-10-29 09:27:26"}
```

Removal is positional too — `--id` is rejected:

```text
$ termux-notification-remove p0-08-overdue      # removes it; positional
tag=p0-08-overdue, p0-08, p0-08-listprobe, p0-08-action, p0-08-ongoing → removed
active afterwards: 2 (both unrelated: android, com.termux)
$ termux-notification-remove --id x             # termux-notification-remove: illegal option --  ; exit 1
```

Publishing from the phone, with no app server running and no account:

```sh
pub() { curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" \
  -H 'Title: Pupkeep' -H "Priority: $1" -H 'Tags: bell' \
  -d "$2" "https://ntfy.sh/$(cat ~/.pupkeep/ntfy-topic)"; }
```

```text
fed             "Someone logged a feed"                  200
feed_overdue    "A meal is overdue"                       200
appointment     "An appointment reminder"                 200
approval        "The agent needs your confirmation"       200
phone publish time_total (3 samples): 0.386s  0.400s  0.371s
```

A second subscriber — this devcontainer — received all four over SSE, with the
sent titles and priorities:

```text
message | Pupkeep | 3 | "Someone logged a feed"
message | Pupkeep | 4 | "A meal is overdue"
message | Pupkeep | 3 | "An appointment reminder"
message | Pupkeep | 4 | "The agent needs your confirmation"
```

Delivery latency was measured **devcontainer → ntfy.sh → devcontainer: 377 ms**.
The phone's 0.37–0.40 s is publish time only; no phone-to-phone latency was
measured.

Priority and tag mapping, and that the message outlives the publisher (a *new*
subscriber polled the backlog):

```text
Priority: default → priority 3     Priority: high → 4     Priority: max → 5
Tags: bell → tags ["bell"]
?poll=1&since=all  → 5 cached messages, then 11 after later publishes
```

Topic secrecy is the whole access control:

```text
topic: crypto.randomBytes(24) → 32-char base64url = 192 bits
~/.pupkeep 0700, ntfy-topic 0600, 32 bytes
fresh 192-bit topic, never used → 0 messages; publish to it → 200
the real topic afterwards → unaffected (6 messages)
```

The private tap target, as the subscriber sees it:

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
The parts this plan depends on are absent or degraded on iOS; the client itself
is not (the parity table marks subscribe, unsubscribe, delete, tags and dark mode
as supported). Both upstream documents are old — `FEATURE_PARITY.md` says “last
updated 2023-05-23”, and `TECHNICAL_LIMITATIONS.md` predates it — so treat every
row as **as of 2022–2023, confirm in P0-10**, not as current fact:

| Question | Answer | Source |
|---|---|---|
| Instant delivery | **not supported on iOS**; foreground services don't exist there, so delivery depends on Apple push plus background tasks | ntfy-ios `FEATURE_PARITY.md` (last updated 2023-05-23), `TECHNICAL_LIMITATIONS.md` |
| How the App Store app gets pushed | topics on the **default server** are relayed through ntfy.sh's Firebase credentials; that is what makes an ntfy.sh topic arrive without the app running | ntfy-ios `TECHNICAL_LIMITATIONS.md` |
| **Self-hosted** ntfy on iOS | reliable delivery only with [`upstream_base_url`](https://docs.ntfy.sh/config/#ios-instant-notifications), i.e. the self-hosted server relays to ntfy.sh. Without the relay the app relies on background polling, which the author measured as running *once in a day*; if a poll is slower than the 12 h cache, the upstream doc says notifications “would never make it” | ntfy-ios `TECHNICAL_LIMITATIONS.md` |
| ntfy `Actions` buttons (`view, Open Today, …`) | **not listed in the parity table**, which records only `Click action` as “only direct notification click”. Read as: no action buttons to rely on — the checklist's N3 confirms it on the device | `FEATURE_PARITY.md` |
| ntfy priority filtering | not on iOS (“no priority filtering”); the priority is carried, its iOS presentation is unverified | `FEATURE_PARITY.md` |
| Web Push | needs HTTPS **and** Add to Home Screen **and** iOS 16.4+. Over Tailscale HTTP there is no push on iOS at all | [WebKit: web push for web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) |
| Add to Home Screen over HTTP | a web clip with **no service worker** (insecure context), so no offline and no push. It is also reported to have its **own storage and cookie jar** — a second sign-in — but the linked WebKit post covers Web Push and A2HS, *not* storage isolation; that half is hearsay until P0-10 observes it | [WebKit: web push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) for the SW/HTTPS half; storage isolation **unsourced** |
| SSE while backgrounded | iOS suspends background tabs, so live updates are foreground-only. Whether an `EventSource` **reconnects by itself** on return is **not** established: the client may have to rebuild it on `visibilitychange`. P0-10's A4 measures exactly this, and the harness reports `opens=` vs `scriptResumes=` | Apple's background execution rules; behaviour **unverified** |

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
- **Every iOS row** in the iOS section above is upstream documentation (2022–
  2023 vintage), not a measurement. Nothing here was tested on an iPhone: push
  timeliness, the `Click` tap, priority presentation, background behaviour, and
  whether a home-screen clip really gets its own cookie jar.
- Delivery while the host phone is dozing, and the Play-vs-F-Droid ntfy build
  difference in practice.
- Tapping a notification (`--action` / ntfy `Click`) — posted, not exercised.
- Pinning (`--ongoing`) from the device's point of view.
- A notification posted while the Termux app is killed, then restored.
- The in-app mirror itself — that is P4-06, not Phase 0.
- Real Web Push delivery over the quick tunnel — P0-03's remaining row, P4-05.

Since this note was written, P0-10 gained a scratch harness
(`~/p0-10/server.mjs`, 2026-10-29) and was smoke-tested from the devcontainer:
`401` unauthenticated, `403` on a wrong invite key, `302` + `HttpOnly` cookie on
the right one, `/sse` ticking on a 2 s free-running grid, `/status` reporting the
count. That makes the checklist's A2/A3/A4/N3 runnable in Phase 0 instead of
deferred to P1 — but none of it has been seen on an iPhone.
