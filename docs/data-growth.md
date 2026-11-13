# Data growth: the numbers, and the policies they chose (P5-07)

The plan left three things to measurement: how big the documents get, how the
checkpoint policy trades disk against replay, and where the retention caps
should sit (§8.5). This is the host half of P5-07. The phone half — commit
latency and WAL behaviour on Termux storage, and battery — is still open and
may be two to four times slower than the numbers below.

## Method

`npm run measure:growth -- --days <n>` (`scripts/measure-growth.ts`) boots the
real app on a throwaway data directory and seeds a household of `n` days:

- **three scheduled feeds a day** through the real `logFeed`, so every sample is
  a real commit (Pi Durable delta, `synchronous = FULL`, WAL);
- **two walks a day** and one weight a week, bulk-seeded in one commit each —
  their commit latency is not the question here; their size and read cost are;
- then it measures the real `readFeeding`/`readWalks`/`readGrowth`, the
  document sizes, the SQLite/WAL files, a cold read after close/reopen (the
  replay the checkpoint policy bounds), and the real `scripts/backup.ts`
  archive (age-encrypted, so its size is the bundle, not an estimate).

Environment: devcontainer, **aarch64**, Node 24.22.1, Node's `node:sqlite`, the
database on the container's overlay (ext4), `synchronous = FULL`, WAL. A raw
360 KiB write + `fsync` on the same filesystem is 4.2 ms, which is the floor a
commit cannot go below.

A household day is 3 feeds + 2 walks + 1/7 weight, so "days" is roughly
"person-days of care": 365 days ≈ one year.

## 1. What the document sizes look like

| Days | Feeds | Walks | Weights | `app.feeding` | `app.walks` | `app.growth` | `app.activity` | `app.commands` |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 0 | 1 | 0.3 KiB | 0.1 KiB | 0.3 KiB | 0.3 KiB | 0.2 KiB |
| 100 | 300 | 200 | 15 | 65 KiB | 67 KiB | 3.0 KiB | 33.6 KiB | 1.4 KiB |
| 500 | 1 500 | 1 000 | 72 | 326 KiB | 339 KiB | 13.9 KiB | 33.6 KiB | 1.4 KiB |
| 1 500 | 4 500 | 3 000 | 215 | 980 KiB | 1 018 KiB | 41.8 KiB | 33.6 KiB | 1.2 KiB |

- Feeding is ~217 bytes/event, walks ~340 bytes/record, growth ~80 bytes/record.
- **Activity's 200-entry cap holds**: 33.6 KiB flat from 100 days on.
- **Commands stay tiny** (1.2–1.4 KiB): the 24 h TTL prunes a day's keys on the
  next day's first commit, so the 1000-entry cap is a safety net, not the
  operative bound.
- Notifications are capped at 500 (unread and undelivered are never pruned);
  a single-member household produces none, so this run measured 0. The cap is
  the operative bound, and it binds long before the plan's 90-day clause for a
  household that reads a notification or two a day — so no 90-day sweep is
  warranted (see §4).

## 2. Commit latency is linear in the document

One feed commit, at `synchronous = FULL`, with the **shipped** checkpoint window
of 100 (the median of the last 100 commits, so the document had reached the
size in the row):

| Days | Feeds | `app.feeding` | Feed commit (median / p95) | Warm `readFeeding` | Cold read after reopen |
|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 0.3 KiB | — | 0.04 ms | 2.3 ms |
| 100 | 300 | 65 KiB | 14.5 / 21.2 ms | 1.27 ms | 38 ms |
| 500 | 1 500 | 326 KiB | **53.0 / 72.7 ms** | 6.3 ms | 147 ms |
| 1 033 | 3 099 | 674 KiB | 111.7 / 133.0 ms | 13.4 ms | 250 ms |
| 1 500 | 4 500 | 980 KiB | 158.9 / 181.1 ms | 21.3 ms | 297 ms |

The commit writes the whole feeding document (plus the activity and commands
documents and the idempotency record in the same commit), so its cost is
`~0.16 ms/KiB + ~5 ms` on this host. At the plan's own limit — 3 meals a day —
1 500 feeds is about **1.4 years**, and one meal log costs 53 ms here and
probably 100–200 ms on the phone. The 3 000-day seed (9 000 feeds) did not
finish inside a ten-minute cap for the same reason: seeding cost grows with
history, so the *total* is quadratic.

## 3. The checkpoint window was costing 26× the disk for nothing

`checkpointWhen` decides whether a change is stored as a base or a delta. In
this storage a **delta is the whole document value**, so the window is a direct
multiplier on the stored bytes and on the cold read — it buys no replay saving
that a base does not. Measured at 300 days (900 feeds, 196 KiB document):

| Window | SQLite after reopen | Cold read | Feed commit (median) |
|---:|---:|---:|---:|
| **1** | **800 KiB** | **8.7 ms** | 32.9 ms |
| 10 | 2.8 MiB | 18.9 ms | 33.6 ms |
| 100 (shipped) | 20.7 MiB | 97.3 ms | 33.8 ms |

And at 500 days (1 500 feeds, 326 KiB), with the real backup job:

| Window | SQLite after reopen | Cold read | Backup archive |
|---:|---:|---:|---:|
| **1** | **1.2 MiB** | **22.5 ms** | **162 KiB** |
| 100 (shipped) | 32.9 MiB | 147 ms | 4.9 MiB |

Commit latency is the same at either window (the value is written whole either
way), so a window of 1 is strictly better: it bounds replay to one document
parse, the file to roughly one copy, and the encrypted backup with it.

**Changed:** `CHECKPOINT_DELTAS` in `src/server/domain/docs.ts` is 1 — at most
one delta between bases — pinned by `test/checkpoint-policy.test.ts`.

## 4. Decisions

1. **Checkpoint window: 1 delta.** Implemented. It is the tightest bound on
   disk and cold start and it costs nothing at commit time (measured above).
2. **Feeding history: archive before ~1 100 events (≈1 year of 3 meals a
   day, ≈240 KiB, ≈40 ms per log on this host).** Not implemented here: it is a
   data-model change (per-month documents, or an export plus a pruned document),
   not a constant, and it must keep the "every acknowledged care action is one
   commit" and "no history is silently lost" rules. Recorded as the carried
   follow-up in PLAN §16 P5-07. Until then the document is unbounded and the
   per-log cost grows as measured.
3. **Growth and walks: keep all, no cap yet.** Growth is ~80 bytes a week (42 KiB
   at 1 500 days); walks are ~340 bytes each and the same size class as feeding
   (1 MiB at 1 500 days) but written twice a day rather than three times, so the
   same archive decision applies later, not sooner. The archive follow-up should
   cover all three histories once it exists.
4. **Retention caps: no change.** Activity's 200 holds (33.6 KiB); commands are
   kept to a day by the TTL (1.4 KiB) with the 1000 cap as a backstop;
   notifications are capped at 500 with unread and undelivered items protected.
   The plan's "or 90 days" for notifications is not implemented because the 500
   cap binds first at a realistic read rate; adding a second bound would prune
   history for no measurable saving.
5. **No tuning without these numbers.** The measured floor is the raw
   write+fsync (4.2 ms); nothing below that is achievable, and everything above
   it is document size.

## What this does not cover

- **The phone** (P5-07's other half): commit latency and WAL behaviour on
  Termux storage, battery/heat, and the same seeds on a device. The script runs
  unchanged there (`npm run measure:growth -- --days 500 --data ~/pupkeep-measure`
  on internal storage, never the workspace mount).
- **The agent/model path**: no model calls are made here.
- **Notification-retention size at 500**: not seeded (a single-member household
  writes no intents); the cap's behaviour is pinned by its own tests.

## 5. The archive, and what it fixes (P5-07b)

The archive is the answer to §2's linear commit: events older than the current
and previous household month move out of the hot document into **one committed
document per month** (`app.feeding.archive` / `app.walks.archive`, a Pi Durable
document family keyed by `YYYY-MM`). The move is one commit, runs on boot, and
is idempotent (a second boot finds nothing and does not commit). Nothing is
dropped: the month document is a committed, backed-up record, and an **open
walk** never moves — it is state a caregiver must resolve (§8.5).

Measured with `npm run measure:growth` (which now archives every 30 seeded days,

- the shipped shape; `--no-archive` reproduces the old curve):

| Days | Hot `app.feeding` | Hot `app.walks` | Feed commit | Windows | SQLite | Cold read | Backup |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 500 | 29.7 KiB | 30.6 KiB | **12.7 ms** | 1 368 feeds, 912 walks | 930 KiB | **1.9 ms** | **120 KiB** |
| 1 500 | 26.5 KiB | 27.3 KiB | **11.1 ms** | 4 383 feeds, 2 922 walks | 2.4 MiB | **2.1 ms** | **326 KiB** |

Against the unbounded document at the same points (53 ms / 159 ms per feed
commit, 33 MiB / 98 MiB, 147 ms / 297 ms cold, 4.9 MiB / 14.7 MiB backup), the
commit cost is now **flat and independent of the household's age** — the point
of the exercise. The archive adds bounded month documents, one per month, each
~30 KiB.

Growth is deliberately **not** archived: a weight a week is ~80 bytes, 42 KiB at
1 500 days (10 years), and the Pup screen's chart and "all measurements" count
read the whole list. Keep all; revisit only if a future feature makes it big.

Boot is the seam because a phone restarts far more often than monthly (Termux
kills, reboots, launcher restarts). Between boots the hot document grows by one
month at most — ~110 feeds, ~24 KiB — which is the same bound the archive keeps.
