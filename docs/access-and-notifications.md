# Access and notifications — the caregivers' guide

**Status: draft (P4-09), revised by `P6-08`.** This is the copy for the two
people who *use* Pupkeep: how to get onto the app, and how the notifications
reach each phone. It is not the host's install manual — the box's operator
runbook is [`../deploy/README.md`](../deploy/README.md) and the fallback phone's
is [`PHONE-RUNBOOK.md`](PHONE-RUNBOOK.md).

The household's daily path is the public HTTPS origin,
`https://pupkeep.duckdns.org` (PLAN §2.1, §6.6). The old Tailscale daily path and
the Cloudflare quick tunnel were **deleted with their access modes** (`P6-08`):
there is no tailnet to join and no tunnel URL to chase. The phone still serves an
offline fallback on the household LAN (§5), and that path has no PWA and no push.

Two things are deliberately unproven, and this guide does not pretend
otherwise: whether **the partner's iPhone actually receives** Web Push (or ntfy)
is the device check in **P0-10**
([`partner-ios-checklist.md`](partner-ios-checklist.md)), and the box's own
deployment legs — certificate, timers, first boot — are `P6-09`'s.

---

## 1. Who needs what

| | The household server (the box) | You and your partner |
|---|---|---|
| Runs the app | **Yes** — the `pupkeep` container behind Caddy | No |
| Tailscale | No | No — deleted as an access mode (`P6-08`) |
| Browser | — | Yes, on any network; install it as an app (§2) |
| ntfy | No | **Optional**, per person — a nudge when the app is not open |
| Terminal work | Only the operator who runs the box | No |

There is no app to download from a store. The "app" is the web page on the
public origin, installed to the home screen so Web Push works.

## 2. Day one: join the household

The owner does these first, on the box (the operator steps are in
`deploy/README.md`).

1. **Sign in as the owner.** Open the sign-in link from
   `/srv/pupkeep/data/owner-link.txt` on the box (`0600`; the operator reads it,
   it is never printed in a log). It sets a session cookie; keep the link
   private — it is the household's key.
2. **Finish first-run setup** if Today asks: confirm the **timezone**, name the
   **puppy**, set the **meal times**. A wrong timezone moves every date after it,
   so check it against your own clock. Both caregivers can do this, and Settings
   shows the same three steps later.
3. **Invite your partner.** Settings → *Invite your partner* → their name →
   **Create a one-time invite**. The link appears **once**: send it to them over
   a private channel (not a group chat, not email you would not want read). It
   works **once** and expires after **15 minutes**; create another if it lapses.
4. **Your partner joins.** They open the invite link on any network — there is
   nothing to install first and no VPN — sign in, and land in the same household.
   Ask them to install the app (§3) so notifications work.

### On an iPhone: install it, do not just bookmark it

The origin is HTTPS, so Safari can **Share → Add to Home Screen**. Do that: iOS
only delivers Web Push to an installed home-screen app, and on iOS **16.4+**
(Apple's requirement, not this app's). A plain bookmark gets a separate cookie
jar and no push.

## 3. Every day

1. Open `https://pupkeep.duckdns.org` — from a phone on mobile data, a laptop,
   anywhere. There is no tailnet to join and no VPN app to keep connected.
2. Everything is live for both of you: a feed, a walk, an appointment or an
   agent reply appears on the other phone without a reload.
3. If the page does not load, see §6.

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
proposal is an in-app action (see §7).

### 4.2 Web Push (the daily channel)

Because the origin is HTTPS and the app is installed, Web Push is how reminders
reach each phone — the same path on Android and iOS.

1. Install the app (§2/§3). On iOS it must be **16.4+** and installed.
2. Allow notifications when the app asks.
3. Settings → Notifications → **Enable notifications on this device**, then
   **Send a test notification**. The in-app centre gets an item and the phone
   shows it within a minute or so.
4. If push stops after a browser data clear or a reinstall, repeat step 3 — the
   subscription is per device and per installed app.

Web Push needs the public origin. There is **no Web Push on the LAN fallback**
(§5), and there is no host-local Android notification any more: `P6-08` deleted
the Termux:API transport.

### 4.3 ntfy (optional, per person)

ntfy is an extra nudge for someone who wants the app's news outside the app. It
is optional and per person; the in-app centre already has everything. It is a
third-party relay, so the rules below are about what may travel through it.

1. **Install ntfy** from the App Store or Play Store.
2. **Create a topic only you two know.** A topic is a long random name; anyone
   who knows it can read *and* publish to it, so it is the password. Generate
   one rather than typing words — for example on any machine:
   `LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 32`, which is 32 random
   lowercase letters (about 165 bits). Use at least 25 of them (about 128 bits);
   the app refuses anything shorter than 22 characters, and words are not
   random.
3. **Subscribe to it** in the ntfy app (the topic goes in the app's subscribe
   field; keep the server on `ntfy.sh` — that is what gives iOS a real push).
4. **Put the same topic in Pupkeep**: Settings → Notifications → *ntfy* → paste
   it → **Save topic**. It is stored on the server in `push.json` (mode `0600`)
   and Settings shows it back so you can copy it into the app again. That file
   rides in the **encrypted backup** too, so the backup passphrase protects it.
5. **Check it**: Settings → Notifications → **Send a test notification**. The
   in-app centre gets an item; the ntfy app should show *Test notification*
   within a minute or so.

What travels, and what never does:

- **Category-only text** (the app's own labels): "A meal was logged", "A meal is
  overdue", "Appointment reminder", "A confirmation is waiting". No puppy name,
  no vet, no appointment title, no weight, no health remark. `ntfy.sh` stores the
  message for 12 hours.
- **Tap-through only.** The notification is a nudge; open the app to act. On
  iOS there are no action buttons, and no decision may live in a notification
  anyway. The payload carries no link: open the app from your home screen.
- **If the topic leaks** (a screenshot, a shared link), make a new one and save
  it in both places. The old one is still readable by whoever has it.
- **If ntfy is not for you**: the in-app centre and Web Push still have
  everything; there is no email or SMS in this version.

## 5. If the household is running the fallback

When the box is unavailable, the phone fallback can serve the household on the
LAN (`PHONE-RUNBOOK.md`). That path is **plain HTTP** and **offline by design**:

- Both caregivers open the phone's LAN address (for example
  `http://192.168.x.y:8787`) on the same Wi-Fi. No VPN, no tailnet.
- There is **no service worker, no PWA install and no Web Push** on an HTTP
  origin. The in-app centre is the notification record; ntfy still works if a
  topic is saved, because it travels over the relay rather than the origin.
- It is a stopgap, not the daily path: the box's public origin is where the PWA,
  Web Push and the stable links live.

## 6. If something is wrong

| What you see | What to do |
|---|---|
| The page does not load | Check your network, then the household server: is the box up? The operator checklist is `deploy/README.md`, and the fallback is `PHONE-RUNBOOK.md` §12. |
| "Please sign in again" | The session cookie is gone (a cleared browser, a different origin, or a removed member). **Owner:** reissue on the box with `--reissue-owner` and open the new link. **Partner:** there is no self-service re-login yet — ask the owner, who can free the slot (removing the member is an operator step in `config.json`) and invite you again; this is a known gap, not a step you can take. |
| No notifications on the partner's phone | The in-app centre is still authoritative. Is the app installed (not a bookmark)? Did the device allow notifications? Does Settings → Notifications show it enabled? If you rely on ntfy instead, check the topic. |
| The notification arrived but the centre looks empty | The centre shows **your own** items, newest first, with the unread count on the tab; a notification you dismissed on the phone is still an item there until it is read. |
| A test notification works but reminders do not | Check the category switches in Settings → Notifications, and that the reminder time has actually passed. |
| Dates look shifted | The household timezone is wrong. Fix it in Settings (the same setup steps) and re-check the meal times. |
| Push stopped after clearing the browser | Expected: the subscription belonged to that installed app. Enable notifications on this device again (§4.2). |

## 7. What this guide does not claim

- **The partner's delivery is not proven here.** That is P0-10's device check,
  recorded in [`partner-ios-checklist.md`](partner-ios-checklist.md); this guide
  describes the intended, implemented path.
- **The box's deployment legs are `P6-09`'s.** The origin, the certificate, the
  timers and the first boot are documented in `deploy/README.md` and are not
  exercised by this repository.
- **There is no named tunnel any more.** The public origin replaced it (`P6-08`);
  a named tunnel would be a second front door, not an upgrade.
- **No Web Push on the LAN fallback.** It is plain HTTP; the in-app centre is its
  record, and it is a stopgap rather than a daily origin.
- **Three facts about other people's software** are documented, not measured
  here: ntfy.sh's 12-hour message cache, the separate cookie jar an iOS
  home-screen clip gets over plain HTTP, and Apple's iOS 16.4 Web Push
  requirement (including the installed-PWA rule). P0-10 records what the
  partner's phone actually does.
- **No decisions in notifications.** A notification can say a confirmation is
  waiting, but deciding is an in-app action: tap **Confirm** or **Decline** on
  the proposal card on the **Agent** screen. A notification never executes
  anything.
