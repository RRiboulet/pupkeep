# P0-02 — Pi Pocket host reuse audit

**Task:** P0-02. **Date:** 2026-10-28. **Status:** complete (reuse decision recorded).

**Source:** [`TannerMidd/pi-pocket`](https://github.com/TannerMidd/pi-pocket) at
commit `e984c60b4060ba5c5856a2d3413d6d6d6e0eb522` (`v0.26.0-2-ge984c60`),
package version `0.26.0`. Licence: MIT, copyright (c) 2026 Tanner Middleton.

The plan pins Pi Pocket `0.26.0`; this audit used the two commits after the tag
because that is the checkout available in the environment. P1-04/P1-05/P1-06/
P4-05 must copy from this exact commit, keep the MIT notice, and record the
adapted file in `NOTICE.md`.

## Decision

Do **not** fork Pi Pocket and do not reuse its coding-agent domain. Reuse the
host plumbing only, with these classifications:

| Classification | Files | Why |
|---|---|---|
| **Near-direct reuse** (copy + attribution + small path/name edits) | `src/server/lock.ts` (275 lines), `src/server/push.ts` (503 lines), `web/sw.js` (169 lines), `src/launcher/access.ts` (354 lines) | Self-contained host concerns; little or no dependency on Pi Pocket's server/UI |
| **Adapt** (copy the structure, replace Pi Pocket types/store) | `src/server/auth.ts` (193), `src/server/config.ts` (515), `web/notify.js` (251), `web/index.html` import-map/vendor pattern (123) | Coupled to Pi Pocket's roles, store, Preact store/UI, or coding-agent UI |
| **Reference only** (read for patterns, do not copy) | `src/launcher/main.ts` (918), `docs/systemd.md`, `docs/docker.md`, `src/server/collab.ts` | Launcher is coupled to Pi Pocket updates/terminal UI; presence is out of scope; service docs are operational patterns |
| **Reject** | sessions, subagents, files, browser panel, design mode, PiP, gallery, extensions, update system, coding-agent tools | Not part of Pupkeep |

## Reuse notes

### `src/server/lock.ts` — near-direct

- One process per data directory, pid + process identity, boot id, start time,
  stale/incomplete lock handling.
- No Pi Pocket imports; only Node built-ins.
- Adapt: export `takeLock(dataDir/harness.lock)` for Pupkeep; record the pid in
  the same data dir; keep the existing close/release path. Rename the hardcoded
  "Pi Pocket" error strings. **P1-05 owns the lock; P1-04 calls it.**
- This is the guard against two servers writing the same SQLite file.

### `src/server/push.ts` — near-direct

- Zero-dependency RFC 8291 (`aes128gcm`) encryption, RFC 8292 VAPID, RFC 8030
  POST, `PushStore` for VAPID keys/subscriptions/prefs, `push.json` mode 0600.
- No external npm dependency; good for Termux.
- Adapt: notification categories (`appointment`, `feed_overdue`, `fed`,
  `approval`, `test`), per-user/device subscriptions, server-side dedupe keys,
  and a `tag` for display collapse. Keep the `PushMessage` shape and the
  `sendPush`/`PushStore` seam.
- `PushStore.save()` has the same non-fsynced temp+rename as `ConfigStore`;
  apply the serialized write queue before reuse.
- Add `ntfy` publishing beside Web Push in the outbox, not inside `push.ts`.
- Cosmetic renames when copying: `pocket_auth` → `pupkeep_auth`, lock error
  strings, `DEFAULT_SUBJECT`, `X-Pocket`.

### `web/sw.js` — near-direct

- Push display, notification click/deep link, approval action; the share-target
  path is removed.
- Adapt: Pupkeep URLs/categories, no approval action from the notification in
  v1 (approvals are in-app cards), static shell cache only. **Drop the share
  target** (`receiveShare`, `SHARE_CACHE`, fetch handler) and its `share.js` /
  `/share` server dependencies; it is not in the Pupkeep plan.
- Keep the notification `tag`/`renotify` behaviour. Rename `X-Pocket`.

### `src/launcher/access.ts` — near-direct

- `local` / `lan` / `cloudflare` / `tailscale`, Tailscale `100.64.0.0/10`
  detection, `cloudflared` find/download/run, quick-tunnel event parsing.
  Fail-closed bind is in the launcher main, not this file (see below).
- No Pi Pocket imports; only Node built-ins.
- Adapt: Pupkeep names/paths, `pupkeep` data dir, keep the quick tunnel
  testing-only. **Fail-closed lives in the launcher main (`prepareAccess`), not
  `access.ts`:** `bindHost("tailscale")` falls back to `127.0.0.1`; P1-04 must
  reimplement the refusal. Confirm the Termux `cloudflared` package (P0-03); if
  missing, use the arm64 binary download path.
- Do not copy the quick-tunnel-per-user cookie logic from Pi Pocket; Pupkeep
  uses origin-scoped cookies and a separate test invite.

### `src/server/auth.ts` + `src/server/config.ts` — adapt

Pi Pocket's auth is a good shape but not our model:

- It stores the **raw owner token** in `config.json` to reprint the login link.
  Pupkeep stores only the owner token **hash**; physical Termux access and
  `--reissue-owner` are the recovery path.
- It has `owner` / `guest` / `viewer` roles, per-session invites, and per-user
  `tunnel`/`sessions` fields. Pupkeep has exactly `owner` / `member`, one
  household, max two members, and no per-session invites.
- `ConfigStore.save()` is atomic temp + rename but not serialized; Pupkeep adds
  a per-file write queue (`fsync(temp)` + `rename` + `fsync(dir)`).
- The user token hash is sha256 of a high-entropy token; keep that approach for
  sessions, but store owner/invite/session **hashes only**.
- Keep the `SameSite=Lax` cookie, Origin check, hashed invites and one-time
  expiry. **Add** request rate limiting: Pi Pocket has no auth/HTTP rate limiter;
  its 429s are provider-limit, webhook and artifact-save handling.
- **Harden forwarded-header trust.** Pi Pocket's `isHttps()`/`origin()` trust
  `X-Forwarded-Proto`/`X-Forwarded-Host` from any peer. Pupkeep must trust them
  only from a loopback peer and derive origins from the active access mode.
- **Owner-link file only at mint/reissue.** Pi Pocket stores the raw owner token
  so it can reprint the same link every boot. Pupkeep stores only the hash, so
  `owner-link.txt` is written when a token is minted or reissued, not on every
  boot; ordinary boots log only its path.

### `web/notify.js` — adapt

- The push subscription flow (secure-context check, permission, key comparison,
  subscribe/unsubscribe, device list) is the right shape.
- It imports Pi Pocket's Preact store/UI; replace with Pupkeep's small store and
  Settings sheet. Keep `isSecureContext`, service-worker registration, key
  comparison, and the iPhone home-screen guidance.
- The partner's daily path is ntfy, not this flow; this flow is for the host
  localhost and the HTTPS quick-tunnel test.

### `web/index.html` — adapt the pattern

- Import map to vendored `preact`, `preact/hooks`, `htm`, `marked`, `dompurify`.
  Pi Pocket serves them from `node_modules` through `/vendor/*` and `modulesWith()`
  (`src/server/http/assets.ts`); Pupkeep instead checks in the vendor files with
  versions/checksums in `NOTICE.md`. No CDN at runtime. No build step.

### `src/launcher/main.ts`, `docs/systemd.md`, `docs/docker.md` — reference only

- The launcher's server-child/restart/tunnel-supervision pattern is useful, but
  the file is coupled to Pi Pocket's update system, terminal UI, and server
  entry point. Reimplement a smaller Pupkeep launcher (P1-04) using
  `access.ts` and the lock, not a copy.
- `systemd.md`/`docker.md` are good operational checklists for the VPS fallback
  (P5/P6 docs), not code to copy.

## Security deviations from Pi Pocket

1. **Owner token at rest:** hash only; reissue from physical Termux. Pi Pocket
   keeps the raw token to print the link.
2. **Roles:** owner/member, max two; no guest/viewer, no per-session authority.
3. **Invites:** ≥128-bit one-time token/link; no short code; origin-agnostic
   token, origin-scoped cookie; separate test invite for the quick tunnel.
4. **Config writes:** serialized queue, fsync temp and directory; no lost
   updates under concurrent invite/session/subscription writes.
5. **Sessions:** hashed at rest; member removal purges sessions; owner rotation
   does not silently keep old owner sessions.
6. **Agent domain:** none of Pi Pocket's coding-agent tools are copied. Pupkeep's
   product agent remains app-tools-only.

## Risks

- Upstream drift: pin the commit and adapt; do not track Pi Pocket `main`.
- `auth.ts`/`config.ts` are the most coupled files; budget extra review.
- `push.ts` is security-sensitive; keep its tests/fixtures and add Pupkeep
  notification/dedupe tests.
- `access.ts` is host-sensitive; re-test Tailscale fail-closed and cloudflared
  on Termux.
- MIT attribution must stay beside copied files and in `NOTICE.md`.

## Next tasks

- P1-04 (launcher) uses `access.ts`; **P1-05 owns `lock.ts`** and P1-04 calls the lock.
- P1-05/P1-06 (data/config/auth) adapt `config.ts`/`auth.ts` with the deviations
  above.
- P4-05/P4-06 (push/outbox/ntfy) use `push.ts` + `sw.js` + `notify.js` patterns.
- P0-03 confirms the Termux `cloudflared` source and Tailscale Serve/Funnel.
