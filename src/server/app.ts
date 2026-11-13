// The server process the launcher supervises: one data directory, one harness,
// one HTTP listener, and an exit that tells the supervisor what happened.
//
// P1-07 wired the harness half; P1-09 wires the real HTTP handler behind it:
// the shared household thread, its snapshots, and its SSE fanout
// (src/server/http.ts, src/server/agent/). P1-10 adds the static PWA shell and
// the care routes. A storage failure still exits instead of idling as a
// "running" process with a dead database.
//
// The exit contract, from PLAN §7.1:
//   * `harness.closed` with `reason:"failed"` -> close with a timeout, exit 1;
//     the launcher's supervisor is the thing that restarts the process.
//   * a second server on the same data directory -> exit 3, never a second writer;
//   * a normal signal -> close the listener, then the harness, then release the
//     `server.pid` lock; the lock is released last.

import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  type Harness as HarnessType,
  type HarnessSettings,
  type Registry,
  type ReportInfo,
  type ReportTask,
  type TaskId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createLogger, type Logger } from "./log.ts";
import { activeMembers, dataPaths, dataStores, ensureDataDir, type AppConfig, type DataDir } from "./config.ts";
import type { JsonFileStore } from "./json-file.ts";
import { Auth, RateLimiter } from "./auth.ts";
import { acquireLock, SERVER_LOCK_FILE, type LockHandle } from "./lock.ts";
import { closeHarness, openHarness, type OpenedHarness, type OpenHarnessOptions } from "./harness.ts";
import { bootstrapSession, type BootstrapResult } from "./domain/bootstrap.ts";
import {
  bindOrigins,
  createAppHandler,
  SIGNIN_LIMIT,
  SIGNIN_WINDOW_MS,
  SUBMIT_LIMIT,
  SUBMIT_WINDOW_MS,
} from "./http.ts";
import { ThreadBus } from "./agent/bus.ts";
import { pickInitialModel, SHARED_THREAD_INSTRUCTIONS } from "./agent/model.ts";
import { watchProfileState, type ProfileStateWatch } from "./agent/state.ts";
import { createFeedTools } from "./agent/feed-tools.ts";
import { createWalkTools } from "./agent/walk-tools.ts";
import { createGrowthTools } from "./agent/growth-tools.ts";
import { createTrainingTools } from "./agent/training-tools.ts";
import { createShowerTools } from "./agent/shower-tools.ts";
import { createCalendarTools } from "./agent/calendar-tools.ts";
import { createApprovalTools } from "./agent/approval-tools.ts";
import { reconcileFeedReminders } from "./reminders/feed-planner.ts";
import { archiveOldFeeds } from "./domain/feeding.ts";
import { archiveOldWalks } from "./domain/walks.ts";
import { reconcileUsageMonth } from "./domain/usage.ts";
import { createAppModels, providersWithKeys, type AppModels } from "./models/collection.ts";
import { PROBE_FRESH_MS, probeAndCache } from "./models/probe-run.ts";
import { ensureVapid } from "./push/vapid.ts";
import { startNotificationOutbox, type NotificationOutboxWatch } from "./notifications/watch.ts";
import {
  ensureTermuxChannel,
  termuxAvailable,
  TERMUX_TIMEOUT_MS,
  type ExecFile,
} from "./notifications/termux.ts";
import { createProfileTools } from "./agent/tools.ts";
import { createReminders } from "./reminders/feed-reminder.ts";
import {
  configureSharedThread,
  readHousehold,
  type ThreadRef,
} from "./agent/thread.ts";

/** Long enough to let task code notice its abort, short enough to beat the
 * launcher's 3 s SIGTERM -> SIGKILL ladder (src/launcher/supervisor.ts). */
export const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

/** The host notification command; a hung command must not hold the outbox. */
const execFileAsync = promisify(execFile);
const hostExec = async (file: string, args: readonly string[]): Promise<void> => {
  await execFileAsync(file, [...args], { timeout: TERMUX_TIMEOUT_MS });
};

export const EXIT_SESSION_FAILED = 1;
export const EXIT_BAD_CONFIG = 2;
export const EXIT_LOCKED = 3;
export const EXIT_OPEN_FAILED = 5;

/**
 * A task the restart limit parked. `task_parked` reports these while the
 * process runs; `inspect()` finds the ones parked by an earlier process, which
 * would otherwise be silently dead after a reboot.
 */
export interface ParkedTask {
  readonly id: TaskId;
  readonly kind: string;
  readonly reason: "restart_limit";
}

export interface AppOptions {
  dataDir: string;
  host: string;
  port: number;
  /** Cap for `harness.close()`; see DEFAULT_CLOSE_TIMEOUT_MS. */
  closeTimeoutMs?: number;
  models?: Models | (() => Models);
  /**
   * Run §11.2's startup probe once this boot. Defaults to **true only when the
   * catalog was built from `secrets.json`**: an injected catalog is a test's
   * scripted one, where a probe would spend the fixture's responses.
   */
  startupProbe?: boolean;
  /** Extensions to install; the app always adds the profile tools. */
  registry?: Registry<ToolRegistration>;
  settings?: HarnessSettings | (() => HarnessSettings | undefined);
  now?: () => number;
  setTimer?: OpenHarnessOptions["setTimer"];
  /** Additional report sink; the server's logging is always installed. */
  onReport?: (error: unknown, info: ReportInfo) => void;
  /**
   * `--retry-parked`: retry, once, the tasks a previous process parked at the
   * restart limit. A parked task stays blocked across restarts and nothing else
   * calls `harness.retryTask()`, so without this the only way out of a park is a
   * code change (P5-01). Off by default: retrying blindly is what the restart
   * limit exists to prevent.
   */
  retryParked?: boolean;
  context?: Context;
}

/** Set to skip the shared-thread wiring; the harness-level tests use it. */
export type ThreadWiring = "scaffold" | undefined;

export type AppEndReason = "closed" | "failed" | "close_timeout";

export interface AppEnd {
  code: number;
  reason: AppEndReason;
}

export interface AppHandle {
  readonly app: HarnessType;
  /** Bound origin of the scaffold listener, or "" when it never opened. */
  readonly url: string;
  /**
   * The shared-thread event fanout, exposed only for diagnostics (the waiter
   * test). Absent when the scaffold listener is wired instead.
   */
  readonly threadBus?: ThreadBus;
  /** Resolves when the app has stopped; a healthy app never resolves it. */
  readonly done: Promise<AppEnd>;
  close(): Promise<AppEnd>;
  parkedTasks(): readonly ParkedTask[];
  /**
   * Run a parked task again. The operator reaches this through `--retry-parked`
   * (P5-01), which retries on boot in the process that owns the database; there
   * is deliberately no second-process CLI and no HTTP route, because only one
   * process may open the harness (§3.2).
   */
  retryTask(id: TaskId): Promise<void>;
}

export type StartAppResult =
  | { ok: true; app: AppHandle }
  | { ok: false; code: number; message: string };

export interface HttpListener {
  readonly url: string;
  close(): Promise<void>;
}

export interface BootstrapInput {
  dataDir: string;
  opened: OpenedHarness;
  context: Context;
  now: () => Date;
  /** The auth authority, shared with the HTTP layer's `Auth`. */
  config: JsonFileStore<AppConfig>;
}

/** Creates/repairs the session documents; injected in lifecycle tests. */
export type BootstrapRunner = (input: BootstrapInput) => Promise<BootstrapResult | void>;

export interface AppDeps {
  openHarness?: (options: OpenHarnessOptions) => Promise<OpenedHarness>;
  /** Default: wire the P1-09 shared thread. `"scaffold"` keeps the old listener. */
  thread?: ThreadWiring;
  bootstrap?: BootstrapRunner;
  acquireLock?: (
    dataDir: string,
    pid?: number,
    startedAt?: Date,
    file?: string,
  ) => Promise<
    | { ok: true; lock: LockHandle }
    | { ok: false; reason: "held"; path: string; pid: number; alive: true }
    | { ok: false; reason: "error"; message: string }
  >;
  ensureDataDir?: (path: string) => Promise<DataDir>;
  listen?: (host: string, port: number, handler: RequestListener) => Promise<HttpListener>;
  logger?: Logger;
  /** Injected so tests can observe the 0700-before-open rule without racing it. */
  setUmask?: (mode: number) => void;
}

/**
 * The scaffold listener. It exists so the harness-level contract tests run
 * without a household: `/healthz` answers, everything else refuses.
 */
function scaffoldRequestHandler(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  let pathname = "";
  try {
    // A probe may append a query string; compare the path, not the raw URL.
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    // A malformed request target falls through to the 503.
  }
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/healthz" || pathname === "/health")) {
    res.statusCode = 200;
    res.end(req.method === "HEAD" ? undefined : '{"ok":true}\n');
    return;
  }
  res.statusCode = 503;
  res.end('{"error":"the HTTP layer arrives with P1-09/P1-10"}\n');
}

/** Bind the scaffold listener and report the address actually bound (port 0 in tests). */
export async function listenHttp(
  host: string,
  port: number,
  handler: RequestListener,
): Promise<HttpListener> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${displayHost}:${boundPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        // SSE connections arrive with P1-09; until then nothing holds a socket,
        // but closing them here keeps a placeholder from becoming a shutdown bug.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * The extensions every server process installs: the care tools the agent may
 * call and the reminder tasks. They ship with the app, never with a
 * conversation: a registry the phone's process does not build is a registry the
 * agent cannot call, and a task kind it does not install can never run.
 */
export function installAppExtensions(registry: Registry<ToolRegistration>): void {
  registry.install(createProfileTools());
  registry.install(createFeedTools());
  registry.install(createWalkTools());
  registry.install(createGrowthTools());
  registry.install(createTrainingTools());
  registry.install(createShowerTools());
  // P4-02: the free calendar reads.
  registry.install(createCalendarTools());
  // P4-07: the proposing tools. They write an `app.approvals` record and change
  // nothing else; the caregiver's confirm route executes the stored action, so
  // the agent has no way to book, move or cancel an appointment itself.
  registry.install(createApprovalTools());
  // P2-09: the feeding reminder task definition. Installing it is what lets a
  // task armed by the meal schedule sleep and wake; the hidden system
  // conversation owns it and never selects an extension of its own (§9.1).
  registry.install(createReminders());
}

async function defaultBootstrap(input: BootstrapInput): Promise<BootstrapResult> {
  // config.json is the auth authority and the seed for profiles; the launcher
  // ensures it exists before spawning the server. A missing config here is a
  // partial restore or a direct server start, and must fail loudly.
  const config = await input.config.read();
  return bootstrapSession(input.opened.harness, {
    config,
    context: input.context,
    now: input.now,
  });
}

/**
 * The run policy P1-09 needs on every process that hosts the shared thread:
 * a failed run must not strand the next caregiver's message (§9.1). A caller's
 * own settings win per remaining field, object or function alike.
 */
export const THREAD_FAILED_RUN_POLICY: HarnessSettings = { afterFailedRun: "continue" };

function threadSettings(options: AppOptions): HarnessSettings | (() => HarnessSettings | undefined) {
  const given = options.settings;
  if (typeof given === "function") {
    return () => ({ afterFailedRun: THREAD_FAILED_RUN_POLICY.afterFailedRun, ...(given() ?? {}) });
  }
  if (given !== undefined) return { afterFailedRun: THREAD_FAILED_RUN_POLICY.afterFailedRun, ...given };
  return THREAD_FAILED_RUN_POLICY;
}
/**
 * Attach the event fanout to the shared conversation. The conversation id comes
 * from the bootstrapped household document; no other conversation is ever
 * watched, so a bus participant cannot see another thread's events.
 */
async function attachThreadBus(
  thread: ThreadRef,
  logger: Logger,
): Promise<ThreadBus> {
  const household = await readHousehold(thread.harness, thread.context);
  const bus = new ThreadBus({
    harness: thread.harness,
    conversationId: household.conversationId,
    context: thread.context,
    onEnded: (reason) => {
      logger.warn("the shared thread stream ended; browsers will reattach", { reason });
    },
  });
  await bus.start();
  return bus;
}

async function releaseQuietly(lock: LockHandle | undefined, logger: Logger): Promise<void> {
  if (!lock) return;
  try {
    await lock.release();
  } catch (error) {
    logger.error("could not release the server lock", { error });
  }
}

function describeReport(info: ReportInfo): Record<string, unknown> {
  // `ReportInfo` is a union where only some members name a task; `in` alone does
  // not narrow an optional-looking field, so read it through the shared shape.
  const task = (info as ReportInfo & { task?: ReportTask }).task;
  if (task) return { taskId: task.id, kind: task.kind, report: info.type };
  return { report: info.type };
}

export async function startApp(options: AppOptions, deps: AppDeps = {}): Promise<StartAppResult> {
  const logger = deps.logger ?? createLogger({ scope: "server" });
  const context = options.context ?? BACKGROUND_CONTEXT;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const setUmask = deps.setUmask ?? ((mode: number) => void process.umask(mode));
  // PLAN §7.1: set umask before opening the DB, so a file the server creates is
  // private even if the data-directory mode is corrected later.
  setUmask(0o077);

  let directory: DataDir;
  try {
    directory = await (deps.ensureDataDir ?? ensureDataDir)(options.dataDir);
  } catch (error) {
    const message = (error as Error).message;
    logger.error("refusing to start", { error: message });
    return { ok: false, code: EXIT_OPEN_FAILED, message };
  }
  if (directory.fixedMode) logger.warn(`tightened the data directory mode to 0700: ${directory.path}`);

  const acquired = await (deps.acquireLock ?? acquireLock)(
    directory.path,
    process.pid,
    new Date(),
    SERVER_LOCK_FILE,
  );
  if (!acquired.ok) {
    const held = acquired.reason === "held";
    const message = held
      ? `another server already owns ${directory.path} (pid ${acquired.pid}); one process per SQLite file`
      : `could not take the server lock in ${directory.path}: ${acquired.reason}`;
    logger.error("refusing to start", { error: message });
    return { ok: false, code: held ? EXIT_LOCKED : EXIT_OPEN_FAILED, message };
  }
  const lock = acquired.lock;

  // One store set for the process: auth, the household reconciliation the HTTP
  // layer triggers, and the bootstrap all read the same files.
  const stores = dataStores(directory.path);
  // The care tools ship with the app, never with a conversation: a registry the
  // phone's process does not build is a registry the agent cannot call.
  const registry = options.registry ?? createRegistry<ToolRegistration>();
  installAppExtensions(registry);

  // P4-08: the provider catalog and its credentials. Keys come from
  // secrets.json through a CredentialStore (never the environment), and an
  // injected catalog is a test's: every provider it names counts as configured.
  let catalog: AppModels | undefined;
  try {
    if (options.models === undefined) {
      catalog = await createAppModels(stores.secrets);
    } else {
      const injected = typeof options.models === "function" ? options.models() : options.models;
      catalog = {
        models: injected,
        configured: new Set(injected.getModels().map((model) => model.provider)),
      };
    }
  } catch (error) {
    logger.warn("could not build the provider catalog; the thread will start without a model", { error });
  }

  const parked = new Map<string, ParkedTask>();
  const report = (error: unknown, info: ReportInfo): void => {
    if (info.type === "task_parked") {
      parked.set(String(info.task.id), { id: info.task.id, kind: info.task.kind, reason: "restart_limit" });
      logger.error("a task is parked until retryTask() runs it again", describeReport(info));
    } else if (info.type === "task_faulted") {
      logger.error("a task faulted", { ...describeReport(info), fault: info.reason, error });
    } else if (info.type === "session_failed") {
      logger.error("the harness storage failed", { report: info.type, error });
    } else {
      logger.error("the harness reported a failure", { ...describeReport(info), error });
    }
    options.onReport?.(error, info);
  };

  let opened: OpenedHarness;
  try {
    opened = await (deps.openHarness ?? openHarness)({
      path: dataPaths(directory.path).database,
      // The harness needs the same catalog the routes use: in production it is
      // the one built from `secrets.json` above, and an injected catalog is a
      // test's. Without it no configured model could ever be called.
      ...(options.models !== undefined
        ? { models: options.models }
        : catalog !== undefined
          ? { models: catalog.models }
          : {}),
      registry,
      settings: threadSettings(options),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.setTimer !== undefined ? { setTimer: options.setTimer } : {}),
      onReport: report,
      context,
    });
  } catch (error) {
    const message = `could not open the harness: ${(error as Error).message}`;
    logger.error("refusing to start", { error: message });
    await releaseQuietly(lock, logger);
    return { ok: false, code: EXIT_OPEN_FAILED, message };
  }

  let listener: HttpListener | undefined;
  let resolveDone: ((end: AppEnd) => void) | undefined;
  const done = new Promise<AppEnd>((resolve) => {
    resolveDone = resolve;
  });
  let stopping: Promise<AppEnd> | undefined;

  let bus: ThreadBus | undefined;
  let profileState: ProfileStateWatch | undefined;
  let outbox: NotificationOutboxWatch | undefined;
  const shutdown = (reason: "closed" | "failed"): Promise<AppEnd> => {
    if (stopping) return stopping;
    stopping = (async () => {
      logger.info(reason === "failed" ? "the harness failed; shutting down for a restart" : "shutting down");
      // Tell the attached browsers to reattach before the sockets disappear;
      // they restart on a fresh connection instead of waiting out a dead SSE.
      profileState?.stop();
      outbox?.stop();
      bus?.stop();
      // Stop accepting work before waiting for task code to return.
      if (listener) {
        try {
          await listener.close();
        } catch (error) {
          logger.error("could not close the HTTP listener", { error });
        }
      }
      let closeResult: "closed" | "timeout" = "closed";
      try {
        closeResult = await closeHarness(opened, closeTimeoutMs);
      } catch (error) {
        // closeHarness only rejects for an error other than "already closed";
        // either way the process is leaving and the file is SQLite's to recover.
        logger.error("the harness did not close cleanly", { error });
        closeResult = "timeout";
      }
      // A close that timed out means task code may still be running and the
      // database may still be open. Releasing the lock before this process
      // exits would let a new server open the same file while the old one can
      // still write. Keep the lock; the next start sees a dead pid and clears
      // it, which is the same takeover a crash leaves behind.
      if (closeResult === "closed") {
        await releaseQuietly(lock, logger);
      } else {
        logger.warn("harness close did not finish; keeping the server lock until this process exits");
      }

      const end: AppEnd =
        reason === "failed"
          ? { code: EXIT_SESSION_FAILED, reason: "failed" }
          : closeResult === "timeout"
            ? { code: EXIT_SESSION_FAILED, reason: "close_timeout" }
            : { code: 0, reason: "closed" };
      if (closeResult === "timeout") {
        logger.error(`harness close exceeded ${closeTimeoutMs} ms; exiting so a supervisor can restart`, {
          timeoutMs: closeTimeoutMs,
        });
      }
      resolveDone?.(end);
      return end;
    })();
    return stopping;
  };

  // Bootstrap the household before scheduling starts: the first boot creates the
  // two conversations and four documents in one commit, and every later boot
  // only repairs what is missing. A failure here is a startup failure, not a
  // half-open server.
  let bootstrapped: BootstrapResult | void;
  try {
    bootstrapped = await (deps.bootstrap ?? defaultBootstrap)({
      dataDir: directory.path,
      opened,
      context,
      now: () => new Date(options.now?.() ?? Date.now()),
      config: dataStores(directory.path).config,
    });
  } catch (error) {
    const message = `session bootstrap failed: ${(error as Error).message}`;
    logger.error("refusing to start", { error: message });
    const closeResult = await closeHarness(opened, closeTimeoutMs).catch(() => "timeout" as const);
    if (closeResult === "closed") await releaseQuietly(lock, logger);
    return { ok: false, code: EXIT_OPEN_FAILED, message };
  }
  if (bootstrapped) {
    logger.info("session bootstrap", {
      created: bootstrapped.created,
      members: bootstrapped.household.members.length,
      profilesCreated: bootstrapped.profilesCreated,
      profilesRemoved: bootstrapped.profilesRemoved,
      docsCreated: bootstrapped.docsCreated.length,
      nameDrift: bootstrapped.nameDrift.length,
      clearedSystemModel: bootstrapped.clearedSystemModel,
    });
    if (bootstrapped.nameDrift.length > 0) {
      logger.warn("household display names differ from config; the household name is kept", {
        count: bootstrapped.nameDrift.length,
      });
    }
  }

  // P4-05: the VAPID pair is generated once, before any subscription can ask
  // for it. Failing to write push.json is reported; the app still serves, and a
  // later request retries.
  try {
    await ensureVapid(stores.push);
  } catch (error) {
    logger.warn("could not prepare the Web Push key pair; push is unavailable until push.json is writable", {
      error,
    });
  }

  // P4-04: one commit that repairs the day's reminders and makes sure exactly
  // one planner exists. After bootstrap (the household is there) and before
  // scheduling starts. A failure is not fatal — the next boot and the next
  // schedule write both arm — but it is reported, never swallowed.
  try {
    const reconciliation = await reconcileFeedReminders(
      opened.harness,
      context,
      new Date(options.now?.() ?? Date.now()),
    );
    logger.info("feed planner reconciliation", {
      createdPlanner: reconciliation.createdPlanner,
      armedReminders: reconciliation.armedReminders,
    });
  } catch (error) {
    logger.warn("could not reconcile the feed planner; reminders may wait for the next schedule save", {
      error,
    });
  }

  // P5-07: feed events older than the hot window move to their month's archive
  // in one commit, so `app.feeding` stays bounded (every feed commit rewrites
  // it whole). After the household exists and after the planner has read the
  // day. A failure is not fatal: the events stay in the hot document and the
  // next boot retries.
  try {
    const archived = await archiveOldFeeds(opened.harness, context, new Date(options.now?.() ?? Date.now()));
    if (archived.moved > 0) {
      logger.info("archived feed events", { moved: archived.moved, months: archived.months.length });
    }
  } catch (error) {
    logger.warn("could not archive old feed events; they stay in the hot document until the next boot", { error });
  }

  // P5-07: the same move for closed walks. An open walk never moves, whatever
  // its age; it is state a caregiver must resolve.
  try {
    const archived = await archiveOldWalks(opened.harness, context, new Date(options.now?.() ?? Date.now()));
    if (archived.moved > 0) {
      logger.info("archived walks", { moved: archived.moved, months: archived.months.length });
    }
  } catch (error) {
    logger.warn("could not archive old walks; they stay in the hot document until the next boot", { error });
  }

  // P4-08: the monthly baseline is repaired from `harness.usage()` — the ledger —
  // before anything reads it. A rollover, a restore that reported less spend, or
  // a database from before `app.usage` all land here; the read is outside a
  // commit, so this must not be inside the bootstrap.
  try {
    const usage = await reconcileUsageMonth(opened.harness, context, new Date(options.now?.() ?? Date.now()));
    logger.info("usage baseline", { month: usage.snapshot.month, baselineCostUsd: usage.snapshot.baselineCostUsd });
  } catch (error) {
    logger.warn("could not read the usage baseline; the budget will read it on first use", { error });
  }

  // A failed Session closes itself; this is the only place the process learns
  // that it must exit rather than keep a dead harness behind a live port.
  void opened.harness.closed.then(
    (end) => {
      if (end.reason === "failed") void shutdown("failed");
    },
    (error: unknown) => {
      logger.error("the harness ended without a reason", { error });
      void shutdown("failed");
    },
  );

  try {
    opened.harness.resume();
  } catch (error) {
    logger.error("the harness could not resume", { error });
    await shutdown("failed");
    return { ok: false, code: EXIT_SESSION_FAILED, message: "the harness could not resume" };
  }

  // A park from a previous process has no `onReport`; `inspect()` is where it is
  // found. Missing definitions and failed migrations are logged but are not
  // retryable, so they stay out of `parkedTasks()`.
  try {
    const inspection = await opened.harness.inspect(context);
    for (const task of inspection.tasks) {
      if (task.state.kind !== "blocked") continue;
      if (task.state.reason === "restart_limit") {
        parked.set(String(task.record.id), {
          id: task.record.id,
          kind: task.record.kind,
          reason: "restart_limit",
        });
        logger.error("a task was parked before this process started; retryTask() runs it again", {
          taskId: task.record.id,
          kind: task.record.kind,
        });
      } else {
        logger.warn("a task is blocked and cannot run here", {
          taskId: task.record.id,
          kind: task.record.kind,
          blocked: task.state.reason,
        });
      }
    }
  } catch (error) {
    logger.error("could not inspect live tasks", { error });
  }

  // P5-01: the operator's way out of a park. Only the process that owns the
  // harness may do this (§3.2), so it rides a start rather than a second
  // command. Each task is deleted from `parked` *before* the retry: `retryTask`
  // can park it again and `onReport` re-inserts it, and deleting afterwards would
  // erase exactly that fresh report (the same rule as `AppHandle.retryTask`).
  if (options.retryParked && !stopping) {
    if (parked.size === 0) {
      logger.info("--retry-parked: no task is parked");
    }
    for (const task of [...parked.values()]) {
      parked.delete(String(task.id));
      logger.warn("retrying a parked task on the operator's request", { taskId: task.id, kind: task.kind });
      try {
        await opened.harness.retryTask(task.id, context);
      } catch (error) {
        parked.set(String(task.id), task);
        logger.error("the parked task could not be retried", { taskId: task.id, kind: task.kind, error });
      }
    }
    // `retryTask` re-runs one task; the scheduler still has to be running for
    // anything the retry queues behind it.
    try {
      opened.harness.resume();
    } catch (error) {
      logger.error("the harness could not resume after retrying a parked task", { error });
    }
  }

  // If the storage failed while resuming or inspecting, do not open a port for
  // a process that is already leaving. `deps.thread === "scaffold"` keeps the
  // P1-07 scaffold listener for the harness-level contract tests.
  if (!stopping && deps.thread !== "scaffold") {
    // The auth authority owns session removal; giving it the push store means a
    // removed caregiver's subscriptions, prefs and ntfy topic go with them
    // (P4-05). The launcher already wires the same pair for owner reissue.
    const auth = new Auth({ config: stores.config, push: stores.push });
    const thread: ThreadRef = { harness: opened.harness, context };

    try {
      bus = await attachThreadBus(thread, logger);
    } catch (error) {
      const message = `could not attach the shared thread: ${(error as Error).message}`;
      logger.error("refusing to start", { error: message });
      const closed = await closeHarness(opened, closeTimeoutMs).catch(() => "timeout" as const);
      if (closed === "closed") await releaseQuietly(lock, logger);
      return { ok: false, code: EXIT_OPEN_FAILED, message };
    }

    // Live care state over the stream that already exists (P1-11): both
    // caregivers see a profile edit without reloading. Registering a commit
    // listener cannot fail; the first publish reports its own failures.
    profileState = watchProfileState({
      harness: opened.harness,
      context,
      bus,
      logger,
      // The care view's `today` and the growth staleness derive from this
      // clock; a frame built on the wall clock would disagree with every read
      // on a process with an injected clock (P3-03).
      now: options.now ? () => new Date(options.now!()) : undefined,
    });

    // P4-06: the host phone's Termux:API transport. Only the owner's intents go
    // to it (the host is the owner's phone); outside Termux it is absent and
    // those intents fall back to push/ntfy/in-app. The channel is created once;
    // an invalid channel would make Android drop the notification silently.
    let termux: { memberId: string; exec: ExecFile; channelReady: boolean } | undefined;
    if (termuxAvailable()) {
      try {
        const config = await stores.config.read();
        const host = activeMembers(config).find((member) => member.role === "owner");
        if (host) {
          const channelReady = await ensureTermuxChannel(hostExec);
          termux = { memberId: host.id, exec: hostExec, channelReady };
          logger.info("host notifications use Termux:API", { channel: channelReady, member: host.id });
        }
      } catch (error) {
        logger.warn("could not prepare the host notification channel; falling back to push and ntfy", { error });
      }
    }

    // P4-05/P4-06: drain the intents committed by care actions and reminder
    // tasks, once at boot and on every notification commit, with a retry timer
    // for failed sends. It never fails a care write.
    outbox = startNotificationOutbox({
      harness: opened.harness,
      context,
      push: stores.push,
      logger,
      now: options.now ? () => new Date(options.now!()) : undefined,
      ...(termux !== undefined ? { termux } : {}),
    });

    try {
      const household = await readHousehold(thread.harness, thread.context);
      const model = pickInitialModel(
        await stores.models.read(),
        catalog?.models,
        catalog?.configured,
      );
      const configured = await configureSharedThread(thread, {
        instructions: SHARED_THREAD_INSTRUCTIONS,
        ...(model ? { model: { provider: model.provider, modelId: model.modelId } } : {}),
      });
      logger.info("the shared thread is configured", {
        changed: configured.changed,
        model: configured.model,
      });
    } catch (error) {
      const message = `could not configure the shared thread: ${(error as Error).message}`;
      logger.error("refusing to start", { error: message });
      profileState?.stop();
      bus.stop();
      bus = undefined;
      const closed = await closeHarness(opened, closeTimeoutMs).catch(() => "timeout" as const);
      if (closed === "closed") await releaseQuietly(lock, logger);
      return { ok: false, code: EXIT_OPEN_FAILED, message };
    }

    try {
      // The actual bound port can differ from `options.port` (port 0 in tests);
      // the origin list follows whatever the listener really bound.
      let boundPort = options.port;
      const handler = createAppHandler({
        auth,
        thread,
        bus,
        ...(catalog !== undefined
          ? {
              models: catalog.models,
              // Read live, not the boot snapshot: a key saved from Settings must
              // count for the next probe without a restart. An injected catalog
              // is a test's, so its providers count as configured there.
              modelProviders: async () =>
                options.models === undefined
                  ? providersWithKeys(stores.secrets)
                  : catalog!.configured,
            }
          : {}),
        secrets: stores.secrets,
        modelCache: stores.models,
        submitLimiter: new RateLimiter(SUBMIT_LIMIT, SUBMIT_WINDOW_MS, options.now ?? Date.now),
        signInLimiter: new RateLimiter(SIGNIN_LIMIT, SIGNIN_WINDOW_MS, options.now ?? Date.now),
        notificationLimiter: new RateLimiter(5, 60_000, options.now ?? Date.now),
        // A probe spends a provider call; a loop must not burn the budget.
        probeLimiter: new RateLimiter(5, 60_000, options.now ?? Date.now),
        allowedOrigins: () => bindOrigins(options.host, boundPort),
        logger,
        push: stores.push,
        // The same clock the boot and the limiters use: a route's local date and
        // a test's fixed instant must come from one source (§8.1).
        now: options.now ?? Date.now,
      });
      listener = await (deps.listen ?? listenHttp)(options.host, options.port, handler);
      const bound = Number(new URL(listener.url).port);
      if (Number.isInteger(bound) && bound > 0) boundPort = bound;
      logger.info("listening", { url: listener.url });

      // P4-08: §11.2's bounded startup probe, once per boot and never on the
      // critical path. It caches `models.json` for the next pick and the Settings
      // screen; the attached model is not switched mid-session (a picker change
      // is the owner's decision, and the next boot reads the fresh allowlist).
      //
      // Only a catalog built from real keys is probed: an injected one is a
      // test's scripted catalog, where a probe would spend the fixture's scripted
      // responses and change what the suite is asserting.
      if ((options.startupProbe ?? options.models === undefined) && catalog !== undefined && catalog.configured.size > 0) {
        void probeAndCache(stores.models, {
          models: catalog.models,
          configured: catalog.configured,
          // Frequent reboots must not re-spend a provider call per paid
          // candidate: a verified verdict is trusted for a few hours.
          freshWithinMs: PROBE_FRESH_MS,
          ...(options.now !== undefined ? { now: options.now } : {}),
        })
          .then((run) => {
            logger.info("model probe", {
              probed: run.results.length,
              allowed: run.allowlist.allowed.map((entry) => entry.id),
              dropped: run.allowlist.dropped.map((entry) => entry.id),
              skippedProviders: run.skipped.length,
            });
          })
          .catch((error: unknown) => {
            logger.warn("the startup model probe failed; the cached allowlist stands", { error });
          });
      }
    } catch (error) {
      logger.error("could not bind the HTTP listener", { error });
      profileState?.stop();
      outbox?.stop();
      bus.stop();
      bus = undefined;
      const closeResult = await closeHarness(opened, closeTimeoutMs).catch(() => "timeout" as const);
      if (closeResult === "closed") await releaseQuietly(lock, logger);
      return {
        ok: false,
        code: EXIT_OPEN_FAILED,
        message: `could not bind ${options.host}:${options.port}: ${(error as Error).message}`,
      };
    }
  } else if (!stopping) {
    try {
      listener = await (deps.listen ?? listenHttp)(options.host, options.port, scaffoldRequestHandler);
      logger.info("listening", { url: listener.url });
    } catch (error) {
      logger.error("could not bind the HTTP listener", { error });
      const closeResult = await closeHarness(opened, closeTimeoutMs).catch(() => "timeout" as const);
      if (closeResult === "closed") await releaseQuietly(lock, logger);
      return {
        ok: false,
        code: EXIT_OPEN_FAILED,
        message: `could not bind ${options.host}:${options.port}: ${(error as Error).message}`,
      };
    }
  }

  const app: AppHandle = {
    app: opened.harness,
    url: listener?.url ?? "",
    ...(bus !== undefined ? { threadBus: bus } : {}),
    done,
    close: () => shutdown("closed"),
    parkedTasks: () => [...parked.values()],
    retryTask: async (id: TaskId): Promise<void> => {
      const key = String(id);
      const previous = parked.get(key);
      // Remove before the call, not after: `retryTask` can park the task again
      // and emit `task_parked`, which re-inserts it. Deleting afterwards would
      // erase exactly that fresh report.
      parked.delete(key);
      try {
        await opened.harness.retryTask(id, context);
      } catch (error) {
        if (previous) parked.set(key, previous);
        throw error;
      }
      opened.harness.resume();
    },
  };
  return { ok: true, app };
}
