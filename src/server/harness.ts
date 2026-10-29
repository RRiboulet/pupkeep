// The one way Pupkeep opens its SQLite file.
//
// PLAN §7.1 fixes the sequence, and P0-01 measured it on the phone:
//
//   openNodeSqliteDatabase(path)          WAL + synchronous = NORMAL
//     → PRAGMA synchronous = FULL         the plan's setting, per connection
//     → SqliteStorage.open({prefix:"pi_"})
//     → Harness.open(storage, ...)
//
// `synchronous` is a property of the *connection*, not of the file: reopening
// the database silently returns to the adapter's NORMAL unless this module
// raises it again. So the pragma is applied and asserted on every open, and a
// connection that will not report 2 fails closed rather than committing with a
// weaker guarantee than the plan promises.
//
// `busy_timeout` is set explicitly even though the Node adapter already defaults
// to 5000 ms: the default is the adapter's, and the plan wants the behaviour
// stated where the connection is made.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type {
  Harness as HarnessType,
  HarnessOptions,
  RegistryReader,
  ReportInfo,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  openNodeSqliteDatabase,
  type NodeSqliteDatabase,
} from "@earendil-works/pi-durable/storage/sqlite/node";

/** Prefix for every Pi Durable table and index (PLAN §7.1). */
export const TABLE_PREFIX = "pi_";
/** SQLite's value for `PRAGMA synchronous` = FULL. */
export const SYNCHRONOUS_FULL = 2;
export const BUSY_TIMEOUT_MS = 5000;

export interface DatabaseOptions {
  /** SQLite's own page threshold; injected only by tests. */
  busyTimeoutMs?: number;
  walAutoCheckpointPages?: number;
}

function pragmaNumber(value: unknown, name: string): number {
  if (typeof value !== "object" || value === null) {
    throw new Error(`PRAGMA ${name} returned no value`);
  }
  const number = (value as Record<string, unknown>)[name];
  if (typeof number !== "number") {
    throw new Error(`PRAGMA ${name} did not return a number`);
  }
  return number;
}

function pragmaString(value: unknown, name: string): string {
  if (typeof value !== "object" || value === null) {
    throw new Error(`PRAGMA ${name} returned no value`);
  }
  const text = (value as Record<string, unknown>)[name];
  if (typeof text !== "string") {
    throw new Error(`PRAGMA ${name} did not return a string`);
  }
  return text;
}

/**
 * Open the SQLite file and raise this connection to the durability PLAN §7.1
 * requires. The caller owns the returned database and must close it (directly
 * or through the Harness, which closes its storage).
 */
export async function openDurableDatabase(
  path: string,
  options: DatabaseOptions = {},
): Promise<NodeSqliteDatabase> {
  const db = await openNodeSqliteDatabase(path, {
    busyTimeoutMs: options.busyTimeoutMs ?? BUSY_TIMEOUT_MS,
    ...(options.walAutoCheckpointPages !== undefined
      ? { walAutoCheckpointPages: options.walAutoCheckpointPages }
      : {}),
  });

  try {
    // Reapply, never assume: the adapter sets NORMAL on every open.
    await db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? BUSY_TIMEOUT_MS}`);
    await db.exec("PRAGMA synchronous = FULL");
    await db.exec("PRAGMA foreign_keys = ON");

    const synchronous = pragmaNumber(await db.get("PRAGMA synchronous"), "synchronous");
    if (synchronous !== SYNCHRONOUS_FULL) {
      throw new Error(
        `refusing to use ${path}: PRAGMA synchronous reads ${synchronous}, expected ${SYNCHRONOUS_FULL}`,
      );
    }
    const journal = pragmaString(await db.get("PRAGMA journal_mode"), "journal_mode");
    if (journal.toLowerCase() !== "wal") {
      throw new Error(`refusing to use ${path}: journal_mode is ${journal}, expected wal`);
    }
    return db;
  } catch (error) {
    // An unconfigured connection is not a harness; closing it here means a
    // failed open cannot leave a second handle on the file to be forgotten.
    await db.close().catch(() => undefined);
    throw error;
  }
}

export interface OpenHarnessOptions {
  /** Absolute path to `pupkeep.sqlite`. */
  path: string;
  /** Pi AI model catalog/credentials. A Harness with no runs may start with none. */
  models?: Models | (() => Models);
  /** Installed extensions and built-in tasks. Empty until P1-08/P1-09. */
  registry?: RegistryReader<ToolRegistration>;
  settings?: HarnessOptions["settings"];
  /** Receives failures that do not fail the caller; the server wraps it to log. */
  onReport?: (error: unknown, info: ReportInfo) => void;
  /** Harness clock; every process opening one storage must agree (PLAN §7.2). */
  now?: () => number;
  setTimer?: HarnessOptions["setTimer"];
  context?: Context;
}

/** An open Harness plus the handles its owner needs to close it and inspect it. */
export interface OpenedHarness {
  readonly harness: HarnessType;
  readonly storage: SqliteStorage;
  readonly database: NodeSqliteDatabase;
  readonly path: string;
  /** The context every call on this Harness uses. */
  readonly context: Context;
}

/**
 * Open the full stack in the plan's order. `SqliteStorage.open` runs the
 * `pi_`-prefixed migrations; `Harness.open` then reuses them.
 */
export async function openHarness(options: OpenHarnessOptions): Promise<OpenedHarness> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const database = await openDurableDatabase(options.path);

  let storage: SqliteStorage;
  try {
    storage = await SqliteStorage.open(database, { prefix: TABLE_PREFIX });
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }

  try {
    const harness = await Harness.open(
      storage,
      {
        models: options.models ?? createModels(),
        registry: options.registry ?? createRegistry(),
        ...(options.settings !== undefined ? { settings: options.settings } : {}),
        ...(options.onReport !== undefined ? { onReport: options.onReport } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.setTimer !== undefined ? { setTimer: options.setTimer } : {}),
      },
      context,
    );
    return { harness, storage, database, path: options.path, context };
  } catch (error) {
    // Harness.open closed nothing; the storage and its database are ours.
    await storage.close(context).catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Close a Harness with a wall-clock cap. `close()` waits for running task code
 * to return, so an uncooperative task can otherwise hold the HTTP port forever
 * (PLAN §7.1). A timed-out close is not retried here; the caller exits and the
 * OS closes the file, which SQLite recovers from on the next open.
 */
export async function closeHarness(
  opened: Pick<OpenedHarness, "harness" | "context">,
  timeoutMs: number,
): Promise<"closed" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
    // The timer must not keep a process alive by itself; the close promise does.
    timer.unref?.();
  });

  const closed = opened.harness.close(opened.context).then(
    () => "closed" as const,
    (error: unknown) => {
      // A failed Session has already closed itself internally. `close()` on it
      // may reject with "already closed" or the stored error; neither changes
      // the outcome the caller needs (the process must exit), and the error has
      // already been reported through `harness.closed` / `onReport`.
      if (isAlreadyClosed(error)) return "closed" as const;
      throw error;
    },
  );

  try {
    return await Promise.race([closed, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isAlreadyClosed(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("closed") || message.includes("not open");
}
