#!/usr/bin/env node
// `npm run measure:growth -- --days 500` — P5-07's host half.
//
// PLAN §8.5 leaves three thresholds open ("cap or archive by month if the doc
// grows past a measured threshold") and asks for the checkpoint policy and the
// SQLite/WAL footprint to be decided from numbers rather than taste. This
// script produces those numbers on a throwaway data directory:
//
//   * the feeding history is seeded through the **real `logFeed`**, so every
//     sample is a real commit (Pi Durable delta, `synchronous = FULL` fsync)
//     and the checkpoint policy in `docs.ts` runs as it does on the phone;
//   * walks and growth are bulk-seeded in one commit each — their commit
//     latency is not the question; their *size* and their *read* cost are, and
//     a real writer would spend an hour to produce the same documents;
//   * the read cost is the real `readFeeding`/`readWalks`/`readGrowth`, which
//     validates the whole document on every care read;
//   * the cold read after a close/reopen measures the replay the checkpoint
//     policy bounds (≤100 deltas per document);
//   * the backup is the real `scripts/backup.ts`, so the archive size is the
//     real age-encrypted bundle and not an estimate.
//
// AGENTS.md: the SQLite file must never live on the workspace mount. The data
// directory is a fresh `mkdtemp` under the OS temp directory (override with
// `--data`), and `--keep` leaves it for inspection.
//
// Usage:
//   npm run measure:growth -- --days 500 [--json out.json] [--keep] [--no-backup]
//
// `--days` is household days: three scheduled feeds and two walks per day, plus
// a weekly weight. 0 measures the empty documents (the bootstrap's own cost).

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startApp } from "../src/server/app.ts";
import { dataStores } from "../src/server/config.ts";
import { closeHarness, openHarness } from "../src/server/harness.ts";
import { createLogger } from "../src/server/log.ts";
import {
  ActivityDoc,
  CommandsDoc,
  FeedingDoc,
  GrowthDoc,
  NotificationsDoc,
  WalksDoc,
} from "../src/server/domain/docs.ts";
import { archiveOldFeeds, logFeed, readFeeding, updateMealSlots } from "../src/server/domain/feeding.ts";
import { readGrowth } from "../src/server/domain/growth.ts";
import { archiveOldWalks, readWalks } from "../src/server/domain/walks.ts";
import { parseGrowthMeasurements } from "../src/shared/growth.ts";
import { parseWalkList } from "../src/shared/walks.ts";
import type { MealSlot, Walk, GrowthMeasurement } from "../src/shared/domain.ts";

const USAGE = `pupkeep measure:growth — P5-07's host measurements

Usage: npm run measure:growth -- [options]

  --days <n>        household days to seed: 3 feeds + 2 walks/day + a weekly weight (default 500)
  --data <dir>      data directory; default a fresh temp dir (never the workspace mount)
  --json <path>     also write the result row as JSON
  --keep            keep the data directory after measuring
  --no-backup       skip the backup/archive measurement (needs age)
  --no-archive      measure the old unbounded document (no monthly move)
  -h, --help        show this help
`;

const ACTOR = { id: "owner", label: "Owner" } as const;
const SLOTS: MealSlot[] = [
  { id: "slot-breakfast", label: "Breakfast", timeLocal: "07:00", active: true },
  { id: "slot-lunch", label: "Lunch", timeLocal: "12:00", active: true },
  { id: "slot-dinner", label: "Dinner", timeLocal: "18:00", active: true },
];
/** The app's clock (boot, tasks). Fixed so a day boundary never fires mid-run. */
const CLOCK = Date.parse("2026-01-01T12:00:00.000Z");
/** The first seeded day; before the app clock so no reminder task looks back. */
const FIRST_DAY = Date.parse("2024-01-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

interface Row {
  days: number;
  feeds: number;
  /** Feed events that the monthly archive moved out of the hot document. */
  archivedFeeds: number;
  /** Closed walks the monthly archive moved out of the hot document. */
  archivedWalks: number;
  walks: number;
  weights: number;
  documents: {
    feedingBytes: number;
    walksBytes: number;
    growthBytes: number;
    activityBytes: number;
    activityEntries: number;
    commandsBytes: number;
    commandRecords: number;
    notificationsBytes: number;
    notifications: number;
  };
  reads: {
    feedingMs: { median: number; p95: number };
    walksMs: { median: number; p95: number };
    growthMs: { median: number; p95: number };
  };
  commits: {
    feedMs: { median: number; p95: number; max: number };
    lastHundredMs: { median: number; p95: number };
  };
  storage: {
    sqliteBytes: number;
    walBytes: number;
    /** After a close + reopen: the WAL is checkpointed and the file settles. */
    reopenedSqliteBytes: number;
    reopenedWalBytes: number;
  };
  coldReadMs: number;
  backup?: { ms: number; archiveBytes: number };
  dataDir: string;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}

function summary(values: readonly number[]): { median: number; p95: number } {
  return { median: round(median(values)), p95: round(percentile(values, 95)) };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** One warm read loop: the median and p95 of `iterations` real reads. */
async function readCost(read: () => Promise<unknown>, iterations: number): Promise<{ median: number; p95: number }> {
  // Warm the zone/format caches and the snapshot path once, then measure.
  await read();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await read();
    samples.push(performance.now() - started);
  }
  return summary(samples);
}

function docBytes(doc: unknown): number {
  return doc === undefined ? 0 : Buffer.byteLength(JSON.stringify(doc));
}

async function size(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** The real backup job, in a child process (it owns the passphrase prompt path). */
async function measureBackup(dataDir: string): Promise<{ ms: number; archiveBytes: number }> {
  const passphraseFile = `${dataDir}.pass`;
  await writeFile(passphraseFile, randomBytes(32).toString("base64url"), { mode: 0o600 });
  const started = performance.now();
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve(import.meta.dirname, "backup.ts"),
        "--data",
        dataDir,
        "--backup-dir",
        join(dataDir, "backups"),
        "--passphrase-file",
        passphraseFile,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`backup exited ${code}: ${stderr.trim().split("\n").slice(-2).join(" ")}`));
    });
  });
  const ms = performance.now() - started;
  const archives = (await readdir(join(dataDir, "backups"))).filter((name) => name.endsWith(".age"));
  const names = await Promise.all(archives.map(async (name) => ({ name, size: await size(join(dataDir, "backups", name)) })));
  const newest = names.sort((a, b) => b.size - a.size)[0];
  if (!newest) throw new Error("backup wrote no .age archive");
  return { ms: round(ms), archiveBytes: newest.size };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      days: { type: "string", default: "500" },
      data: { type: "string" },
      json: { type: "string" },
      keep: { type: "boolean", default: false },
      "no-backup": { type: "boolean", default: false },
      "no-archive": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 0) {
    process.stderr.write(`pupkeep measure:growth: --days must be a non-negative integer\n`);
    process.exitCode = 2;
    return;
  }

  const keep = values.keep;
  const dataDir = values.data !== undefined ? resolve(values.data) : await mkdtemp(join(tmpdir(), "pupkeep-growth-"));
  // A data dir that already holds a database would measure someone else's
  // history; the measurement always starts from the bootstrap.
  const existing = await readdir(dataDir).catch(() => [] as string[]);
  if (existing.length > 0) {
    process.stderr.write(`pupkeep measure:growth: ${dataDir} is not empty; use a fresh --data\n`);
    process.exitCode = 2;
    return;
  }

  // The app refuses an uninitialised data directory: a household is stored in
  // `config.json` before the harness opens, exactly as the launcher's setup does.
  const stores = dataStores(dataDir);
  await stores.config.ensure();
  await stores.config.update((current) => ({
    ...current,
    members: [
      {
        id: "owner",
        role: "owner" as const,
        displayName: "Owner",
        createdAt: new Date(CLOCK - 86_400_000).toISOString(),
        sessions: [],
      },
    ],
  }));

  const logger = createLogger({ scope: "measure", sink: () => undefined, level: "error" });
  const started = await startApp(
    {
      dataDir,
      host: "127.0.0.1",
      port: 0,
      models: createModels(),
      now: () => CLOCK,
    },
    { logger },
  );
  if (!started.ok) {
    process.stderr.write(`pupkeep measure:growth: the app did not start (${started.code}): ${started.message}\n`);
    process.exitCode = started.code;
    return;
  }
  const app = started.app;
  const store = app.app;
  const context = BACKGROUND_CONTEXT;

  try {
    await updateMealSlots(store, context, {
      actor: async () => ACTOR,
      actionId: "seed:slots",
      rev: 0,
      slots: SLOTS,
      now: new Date(CLOCK),
    });

    // --- feeding: real commits, one per meal ------------------------------
    // P5-07b: a phone boots far more often than monthly, so the default run
    // archives every 30 seeded days — the shipped shape. `--no-archive`
    // measures the unbounded document the archive replaced.
    const archive = !values["no-archive"];
    let archivedFeeds = 0;
    const commitMs: number[] = [];
    let feeds = 0;
    for (let day = 0; day < days; day += 1) {
      for (const [index, slot] of SLOTS.entries()) {
        const now = new Date(FIRST_DAY + day * DAY_MS + index * 3 * 60 * 60 * 1000 + 5 * 60 * 1000);
        const began = performance.now();
        await logFeed(store, context, {
          actor: async () => ACTOR,
          actionId: `seed:feed:${day}:${index}`,
          slotId: slot.id,
          amount: "40 g",
          source: "ui",
          now,
        });
        commitMs.push(performance.now() - began);
        feeds += 1;
      }
      if (archive && (day + 1) % 30 === 0) {
        const moved = await archiveOldFeeds(store, context, new Date(FIRST_DAY + day * DAY_MS + 12 * 60 * 60 * 1000));
        archivedFeeds += moved.moved;
      }
    }
    if (archive) {
      const moved = await archiveOldFeeds(
        store,
        context,
        new Date(FIRST_DAY + Math.max(0, days - 1) * DAY_MS + 12 * 60 * 60 * 1000),
      );
      archivedFeeds += moved.moved;
    }

    // --- walks and growth: one commit each, built by their parsers --------
    const walks: Walk[] = [];
    for (let day = 0; day < days; day += 1) {
      for (const hour of [9, 17]) {
        const at = FIRST_DAY + day * DAY_MS + hour * 60 * 60 * 1000;
        walks.push({
          id: randomUUID(),
          startedAt: new Date(at).toISOString(),
          endedAt: new Date(at + 25 * 60 * 1000).toISOString(),
          startedActionId: `seed:walk:${day}:${hour}`,
          endActionId: `seed:walk-end:${day}:${hour}`,
          startedBy: ACTOR.id,
          startedByLabel: ACTOR.label,
          endedBy: ACTOR.id,
          endedByLabel: ACTOR.label,
          pee: 1,
          poop: 1,
          notes: "Seeded walk for the growth measurement",
        });
      }
    }
    if (!parseWalkList(walks)) throw new Error("seeded walks do not parse");
    await store.commit(async (tx) => {
      const draft = await tx.doc(WalksDoc);
      draft.walks = walks;
    }, context);

    // The shipped shape also bounds the walk history (P5-07b); archive it at the
    // last seeded day so sizes and the file reflect a boot on that date.
    let archivedWalks = 0;
    if (archive) {
      const moved = await archiveOldWalks(
        store,
        context,
        new Date(FIRST_DAY + Math.max(0, days - 1) * DAY_MS + 12 * 60 * 60 * 1000),
      );
      archivedWalks = moved.moved;
    }

    const measurements: GrowthMeasurement[] = [];
    for (let week = 0; week < Math.floor(days / 7) + 1; week += 1) {
      const at = FIRST_DAY + week * 7 * DAY_MS + 8 * 60 * 60 * 1000;
      measurements.push({
        id: randomUUID(),
        localDate: new Date(at).toISOString().slice(0, 10),
        at: new Date(at).toISOString(),
        weightKg: Math.round((6 + week * 0.05) * 1000) / 1000,
        byUserId: ACTOR.id,
        byLabel: ACTOR.label,
        source: "ui",
        actionId: `seed:growth:${week}`,
      });
    }
    if (!parseGrowthMeasurements(measurements)) throw new Error("seeded measurements do not parse");
    await store.commit(async (tx) => {
      const draft = await tx.doc(GrowthDoc);
      draft.measurements = measurements;
    }, context);

    // --- read cost, sizes, storage ----------------------------------------
    const feedingDoc = await store.snapshot(FeedingDoc, context);
    const walksDoc = await store.snapshot(WalksDoc, context);
    const growthDoc = await store.snapshot(GrowthDoc, context);
    const activityDoc = await store.snapshot(ActivityDoc, context);
    const commandsDoc = await store.snapshot(CommandsDoc, context);
    const notificationsDoc = await store.snapshot(NotificationsDoc, context);

    const feedingReads = await readCost(() => readFeeding(store, context), 50);
    const walksReads = await readCost(() => readWalks(store, context), 50);
    const growthReads = await readCost(() => readGrowth(store, context), 50);

    const sqlite = join(dataDir, "pupkeep.sqlite");
    const wal = `${sqlite}-wal`;
    const sqliteBytes = await size(sqlite);
    const walBytes = await size(wal);

    await app.close();

    // --- cold read: the replay the checkpoint policy bounds ---------------
    const reopened = await openHarness({ path: sqlite });
    let coldReadMs = 0;
    try {
      const began = performance.now();
      await readFeeding(reopened.harness, reopened.context);
      coldReadMs = round(performance.now() - began);
    } finally {
      await closeHarness(reopened, 5_000);
    }
    const reopenedSqliteBytes = await size(sqlite);
    const reopenedWalBytes = await size(wal);

    const lastHundred = commitMs.slice(-100);
    const row: Row = {
      days,
      feeds,
      archivedFeeds,
      archivedWalks,
      walks: walks.length,
      weights: measurements.length,
      documents: {
        feedingBytes: docBytes(feedingDoc),
        walksBytes: docBytes(walksDoc),
        growthBytes: docBytes(growthDoc),
        activityBytes: docBytes(activityDoc),
        activityEntries: activityDoc?.entries.length ?? 0,
        commandsBytes: docBytes(commandsDoc),
        commandRecords: commandsDoc?.entries.length ?? 0,
        notificationsBytes: docBytes(notificationsDoc),
        notifications: notificationsDoc?.items.length ?? 0,
      },
      reads: { feedingMs: feedingReads, walksMs: walksReads, growthMs: growthReads },
      commits: {
        feedMs: { ...summary(commitMs), max: round(Math.max(0, ...commitMs)) },
        lastHundredMs: summary(lastHundred),
      },
      storage: { sqliteBytes, walBytes, reopenedSqliteBytes, reopenedWalBytes },
      coldReadMs,
      dataDir,
    };

    if (!values["no-backup"]) {
      try {
        row.backup = await measureBackup(dataDir);
      } catch (error) {
        // `age` is a devcontainer tool; a host without it still gets the rest.
        process.stderr.write(`pupkeep measure:growth: backup skipped: ${(error as Error).message}\n`);
      }
    }

    process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
    if (values.json !== undefined) await writeFile(resolve(values.json), `${JSON.stringify(row, null, 2)}\n`);
  } finally {
    await app.close().catch(() => undefined);
    if (!keep) {
      await rm(dataDir, { recursive: true, force: true });
      await rm(`${dataDir}.pass`, { force: true });
    }
  }
}

await main();
