# Access and notifications — the caregivers' guide

**Status: draft (P4-09).** This is the copy for the two people who *use*
Pupkeep: how to get onto the app, and how the notifications reach each phone.
It is not the phone's install manual — that is
[`PHONE-RUNBOOK.md`](PHONE-RUNBOOK.md), for whoever owns the host phone (the
operator). Where a step needs the host, this guide says so and points there. When a step is host-level, it is the
**owner on the host phone** who does it; "the operator" in the runbooks is that
same person.

Two things are deliberately unproven, and this guide does not pretend
otherwise: whether **the partner's iPhone actually receives** in-app + ntfy
notifications is the device check in **P0-10**
([`partner-ios-checklist.md`](partner-ios-checklist.md)), and Web Push over the
quick tunnel is a **test** path, not the daily one.

---

## 1. Who needs what

| | Host phone (owner) | Partner's phone |
|---|---|---|
| Runs the app | **Yes** — Termux, the server and the agent live here | No |
| Tailscale | Yes (the tailnet address the app binds) | Yes (same tailnet) |
| Browser | Yes, on the host phone too | Yes — Safari on iPhone, or any browser |
| ntfy | Optional (the host has local notifications instead) | **Recommended** — the daily out-of-app signal |
| Termux / install work | Yes — see [`PHONE-RUNBOOK.md`](PHONE-RUNBOOK.md) | No |

There is no app to download from a store. The "app" is a web page the host phone
serves, private to your tailnet; on an iPhone it is a Safari tab or a bookmark
(see §2).

## 2. Day one: join the household

The owner does these first, on the host phone, with Pupkeep already started in
`tailscale` mode (`npm start -- --access tailscale --data ~/.pupkeep`; the
operator steps are in the phone runbook).

1. **Sign in as the owner.** Open the sign-in link from
   `~/.pupkeep/owner-link.txt` (the operator reads it from the phone). It sets a
   session cookie; keep the link private — it is the household's key.
2. **Finish first-run setup** if Today asks: confirm the **timezone**, name the
   **puppy**, set the **meal times**. A wrong timezone moves every date after it,
   so check it against the phone's clock. Both caregivers can do this, and
   Settings shows the same three steps later.
3. **Invite your partner.** Settings → *Invite your partner* → their name →
   **Create a one-time invite**. The link appears **once**: send it to them over
   a private channel (not a group chat, not email you would not want read). It
   works **once** and expires after **15 minutes**; create another if it lapses.
4. **Your partner joins.** They install Tailscale, sign in to **the same
   tailnet**, and open the invite link. It signs them in on the origin it names —
   the same tailnet address you are using — and they land in the same household.
   Ask them to bookmark that page.

### On an iPhone: a Safari tab, not an installed app

Over the daily tailnet origin the page is **plain HTTP**, which iOS does not
treat as a secure context. A home-screen clip made from an HTTP page gets its
own cookie jar (a second sign-in) and no service worker, so it buys nothing over
a bookmark. Use **Safari → Share → Add Bookmark** (or keep the tab). Installing
the app and Web Push are tested only on the HTTPS path in §4.

## 3. Every day

1. Both phones are on the same tailnet (Tailscale on, and on the host phone
   "Always-on VPN" so it reconnects by itself after a reboot).
2. Open the bookmarked tailnet address, e.g. `http://100.x.y.z:8787`. The address
   is stable; the app is private to the tailnet — no DNS, no domain, nothing
   public.
3. Everything is live for both of you: a feed, a walk, an appointment or an
   agent reply appears on the other phone without a reload.
4. If the page does not load, see §6. Do **not** switch to the tunnel URL from
   §4 for daily use.

### The Agent screen

The **Agent** tab is one shared thread for both of you. Use it for what you would
otherwise text each other about: "fed breakfast", "started a walk", "what does
today look like?", "move the vet visit to Friday".

- **One message at a time.** While the assistant is replying, both composers are
  disabled and the thread says who it is answering. Your draft stays in the box;
  send it when the assistant is free.
- **Tool cards** show what the assistant actually did. They start collapsed; tap
  one to see the result it returned, and the arguments when this screen saw the
  call live (a reload keeps the result, not the arguments).
- **A schedule change is proposed, never applied by the assistant.** When it
  wants to add, move or cancel an appointment, or change the meal schedule, a
  card appears under **Waiting for your confirmation** on the Agent screen. Read
  the summary and tap **Confirm** or **Decline**. Both caregivers can decide;
  the first answer wins and the thread records it for both of you. A proposal
  expires after 24 hours, and if someone changed the same appointment in the
  meantime the card refreshes and says so instead of overwriting their change.
- **The model and this month's spend** are at the top of the screen. If it says
  no model is attached, or the monthly cap has blocked a paid model, open
  **Settings → Model and budget** to add a provider key, run the check, choose a
  model or raise the cap. A free model still answers at the cap.

## 4. Notifications

There are three paths. Only the first is authoritative.

### 4.1 The in-app notification centre (both caregivers)

The **Alerts** tab — the notification centre, with the unread count on it — opens
every item for *you*, newest first, with a reading state. It is the record — a
notification a phone never showed is still here. Settings → Notifications lets
each of you choose which categories you get and sends a test.

Categories you can expect: appointments, missed meals, meals logged by the other
caregiver, a **confirmation** when the agent asks for approval of a change, and
your own test. A decision is **never** taken from a notification — approving a
proposal is an in-app action (see §7 for where that screen stands today).

### 4.2 The host phone: local notifications (owner)

Where the app runs in Termux with **Termux:API** installed, reminders due on the
host phone also appear as ordinary Android notifications, with generic text
(e.g. *A meal is overdue*). Nothing to set up in the app; if they stop, check
that the Termux:API companion app is installed and allowed to notify — the phone
runbook covers the host side.

### 4.3 The partner's iPhone: ntfy (recommended)

ntfy is how the partner hears about things when the app is not open. It is a
third-party relay, so the rules below are about what may travel through it.

1. **Install ntfy** from the App Store.
2. **Create a topic only you two know.** A topic is a long random name; anyone
   who knows it can read *and* publish to it, so it is the password. Generate
   one rather than typing words — for example on the host phone:
   `LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 32`, which is 32 random
   lowercase letters (about 165 bits). Use at least 25 of them (about 128 bits);
   the app refuses anything shorter than 22 characters, and words are not
   random.
3. **Subscribe to it** in the ntfy app (the topic goes in the app's subscribe
   field; keep the server on `ntfy.sh` — that is what gives iOS a real push).
4. **Put the same topic in Pupkeep**: Settings → Notifications → *ntfy* → paste
   it → **Save topic**. It is stored on the host phone in `push.json` (mode
   `0600`) and Settings shows it back so you can copy it into the app again.
   That file also rides in the **encrypted backup** the host makes, so the backup
   passphrase protects it too.
5. **Check it**: Settings → Notifications → **Send a test notification**. The
   in-app centre gets an item; the ntfy app should show *Test notification*
   within a minute or so.

What travels, and what never does:

- **Category-only text** (the app's own labels): "A meal was logged", "A meal is
  overdue", "Appointment reminder", "A confirmation is waiting". No puppy name,
  no vet, no
  appointment title, no weight, no health remark. `ntfy.sh` stores the message
  for 12 hours.
- **Tap-through only.** The notification is a nudge; open the app to act. On
  iOS there are no action buttons, and no decision may live in a notification
  anyway.
- **If the topic leaks** (a screenshot, a shared link), make a new one and save
  it in both places. The old one is still readable by whoever has it.
- **If ntfy is not for you**: the in-app centre still has everything; there is
  no email or SMS in this version.

## 5. Trying the installed app and Web Push (testing only)

Web Push, the installable app and the service worker need **HTTPS**. Tailscale
gives you HTTP, not HTTPS: the app works fine over the tailnet, but those three
features do not. This is therefore a separate, temporary test path using a
Cloudflare quick tunnel. **You start it on the host phone** (the exact command is
in the phone runbook, §9); the rest is the device steps below.

1. On the host phone, stop the daily launcher and start it with
   `--access cloudflare`; it prints `pupkeep: quick tunnel at
   https://<random>.trycloudflare.com`. That URL is not a secret, but it is
   **test only**.
2. **Sign in on that URL.** The owner link is minted before the tunnel exists, so
   it cannot be printed for a tunnel origin. Do **not** reissue it: a reissue
   rotates the token, signs the owner out on the daily address and voids any
   invite still outstanding. Instead, take the existing link from
   `~/.pupkeep/owner-link.txt` and open it on the tunnel origin — the same path
   and token with the tunnel's host — on the host phone (phone runbook §9).
   Sessions are per origin, so your daily sign-in does not carry over; the token
   is not origin-bound, which is why the same link signs you in here.
3. **The test device signs in with that same owner link.** There is no separate
   test invite: the household has **two** places and both are taken by the
   caregivers, and an invite is refused while the household is full. A test
   session on the tunnel origin is therefore an **owner** session — use a device
   you would trust with that, and when the test is over remove the session from
   that browser (or rotate the owner token with `--reissue-owner` if the device
   was not yours). A partner-account session on a *different* origin is not
   possible today; this is recorded as a limitation in §7.
4. On the test device, open the URL and sign in with the owner link, then:
   - **Android/Chrome**: install the app (menu → *Install app*), allow
     notifications when asked, then Settings → Notifications → **Enable
     notifications on this device**, and send a test.
   - **iPhone**: only with **iOS 16.4+**, and only after **Share → Add to Home
     Screen**; open the installed app, allow notifications, subscribe, send a
     test. (iOS gating is Apple's, not this app's.)
5. **The URL changes whenever the tunnel restarts**, and a push subscription is
   bound to the origin. After a restart, open the new URL and subscribe again.

There is **no named tunnel and no domain yet**, so there is no stable HTTPS
address to make this the daily path. When a domain exists, a named tunnel
replaces the quick one — until then, do not work around it.

## 6. If something is wrong

| What you see | What to do |
|---|---|
| The page does not load | Check Tailscale on **both** phones. On the host phone, is the app running (`~/.pupkeep/server.log`)? The operator checklist is the phone runbook, §12. |
| "Please sign in again" | The session cookie is gone (a cleared browser, a different origin, or a removed member). **Owner:** reissue from the host phone with `--reissue-owner` and open the new link. **Partner:** there is no self-service re-login yet — ask the owner, who can free the slot (removing the member is an operator step in `config.json`) and invite you again; this is a known gap, not a step you can take. |
| No notifications on the partner's phone | The in-app centre is still authoritative. In the ntfy app: is it subscribed to the topic, and is the topic still the one saved in Settings? iOS may background ntfy — open it once. |
| The notification arrived but the centre looks empty | The centre shows **your own** items, newest first, with the unread count on the tab; a notification you dismissed on the phone is still an item there until it is read. |
| A test notification works but reminders do not | Check the category switches in Settings → Notifications, and that the reminder time has actually passed. |
| Dates look shifted | The household timezone is wrong. Fix it in Settings (the same setup steps) and re-check the meal times. |
| Push stopped after a test session | Expected: the tunnel URL changed. Reopen the new URL and subscribe again. |

## 7. What this guide does not claim

- **The partner's delivery is not proven here.** That is P0-10's device check,
  recorded in [`partner-ios-checklist.md`](partner-ios-checklist.md); this guide
  describes the intended, implemented path.
- **Tailscale HTTP has no Web Push, PWA install or service worker.** Those come
  only with HTTPS (§5, test path).
- **No domain, no named tunnel.** The quick tunnel is testing only.
- **No second account on a test origin.** The household's two places are both
  taken, and no route removes a member, so the tunnel test signs the test device
  in as the **owner** (see §5.3) rather than as the partner. A partner-side Web
  Push test on a different origin therefore waits for member re-login or
  remove-member (PLAN §14.1, carried to P5-06).
- **Three facts about other people's software** are documented, not measured
  here: ntfy.sh's 12-hour message cache, the separate cookie jar an iOS
  home-screen clip gets over plain HTTP, and Apple's iOS 16.4 Web Push
  requirement. P0-10 records what the partner's phone actually does.
- **No decisions in notifications.** A notification can say a confirmation is
  waiting, but deciding is an in-app action: tap **Confirm** or **Decline** on
  the proposal card on the **Agent** screen. A notification never executes
  anything.
