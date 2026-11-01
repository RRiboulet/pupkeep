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

import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
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
import { dataPaths, dataStores, ensureDataDir, type AppConfig, type DataDir } from "./config.ts";
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
import { createProfileTools } from "./agent/tools.ts";
import {
  configureSharedThread,
  readHousehold,
  type ThreadRef,
} from "./agent/thread.ts";

/** Long enough to let task code notice its abort, short enough to beat the
 * launcher's 3 s SIGTERM -> SIGKILL ladder (src/launcher/supervisor.ts). */
export const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

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
  /** Extensions to install; the app always adds the profile tools. */
  registry?: Registry<ToolRegistration>;
  settings?: HarnessSettings | (() => HarnessSettings | undefined);
  now?: () => number;
  setTimer?: OpenHarnessOptions["setTimer"];
  /** Additional report sink; the server's logging is always installed. */
  onReport?: (error: unknown, info: ReportInfo) => void;
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
   * Run a parked task again. P1-09/P4 expose this through the owner UI/API; it
   * exists here so a park is never terminal with no way out.
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
  const household = await readHousehold(thread);
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
  registry.install(createProfileTools());

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
      ...(options.models !== undefined ? { models: options.models } : {}),
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
  const shutdown = (reason: "closed" | "failed"): Promise<AppEnd> => {
    if (stopping) return stopping;
    stopping = (async () => {
      logger.info(reason === "failed" ? "the harness failed; shutting down for a restart" : "shutting down");
      // Tell the attached browsers to reattach before the sockets disappear;
      // they restart on a fresh connection instead of waiting out a dead SSE.
      profileState?.stop();
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

  // If the storage failed while resuming or inspecting, do not open a port for
  // a process that is already leaving. `deps.thread === "scaffold"` keeps the
  // P1-07 scaffold listener for the harness-level contract tests.
  if (!stopping && deps.thread !== "scaffold") {
    const auth = new Auth({ config: stores.config });
    const thread: ThreadRef = {
      harness: opened.harness,
      context,
      // The household document is mirrored from auth at boot; a partner who
      // joins later is mirrored by this getter on the next read (§7.1).
      config: () => stores.config.read(),
    };

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
    profileState = watchProfileState({ harness: opened.harness, context, bus, logger });

    try {
      const household = await readHousehold(thread);
      const model = pickInitialModel(await stores.models.read(), options.models);
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
        submitLimiter: new RateLimiter(SUBMIT_LIMIT, SUBMIT_WINDOW_MS, options.now ?? Date.now),
        signInLimiter: new RateLimiter(SIGNIN_LIMIT, SIGNIN_WINDOW_MS, options.now ?? Date.now),
        allowedOrigins: () => bindOrigins(options.host, boundPort),
        logger,
      });
      listener = await (deps.listen ?? listenHttp)(options.host, options.port, handler);
      const bound = Number(new URL(listener.url).port);
      if (Number.isInteger(bound) && bound > 0) boundPort = bound;
      logger.info("listening", { url: listener.url });
    } catch (error) {
      logger.error("could not bind the HTTP listener", { error });
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
