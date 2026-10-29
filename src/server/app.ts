// The server process the launcher supervises: one data directory, one harness,
// one HTTP listener, and an exit that tells the supervisor what happened.
//
// P1-07's job is the harness half. There is deliberately no application route
// here yet — P1-09 adds the shared thread and SSE, P1-10 the static shell — so
// the listener answers `/healthz` and refuses everything else. That is enough
// for this task to be honest: `npm start` really starts a server, the port is
// really bound, and a storage failure really exits instead of idling as a
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
import type {
  Harness as HarnessType,
  HarnessSettings,
  ReportInfo,
  ReportTask,
  RegistryReader,
  TaskId,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { createLogger, type Logger } from "./log.ts";
import { dataPaths, ensureDataDir, type DataDir } from "./config.ts";
import { acquireLock, SERVER_LOCK_FILE, type LockHandle } from "./lock.ts";
import { closeHarness, openHarness, type OpenedHarness, type OpenHarnessOptions } from "./harness.ts";

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
  registry?: RegistryReader<ToolRegistration>;
  settings?: HarnessSettings | (() => HarnessSettings | undefined);
  now?: () => number;
  setTimer?: OpenHarnessOptions["setTimer"];
  /** Additional report sink; the server's logging is always installed. */
  onReport?: (error: unknown, info: ReportInfo) => void;
  context?: Context;
}

export type AppEndReason = "closed" | "failed" | "close_timeout";

export interface AppEnd {
  code: number;
  reason: AppEndReason;
}

export interface AppHandle {
  readonly app: HarnessType;
  /** Bound origin of the scaffold listener, or "" when it never opened. */
  readonly url: string;
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

export interface AppDeps {
  openHarness?: (options: OpenHarnessOptions) => Promise<OpenedHarness>;
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
 * The scaffold listener. It exists so the server is a real supervised process
 * while the routes are still P1-09/P1-10; it never serves data and never reads
 * the harness. `/healthz` is liveness only: no version, no counts, no paths.
 */
export function scaffoldRequestHandler(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/health")) {
    res.statusCode = 200;
    res.end('{"ok":true}\n');
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
      ...(options.registry !== undefined ? { registry: options.registry } : {}),
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
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

  const shutdown = (reason: "closed" | "failed"): Promise<AppEnd> => {
    if (stopping) return stopping;
    stopping = (async () => {
      logger.info(reason === "failed" ? "the harness failed; shutting down for a restart" : "shutting down");
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
      await releaseQuietly(lock, logger);

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
  // a process that is already leaving.
  if (!stopping) {
    try {
      listener = await (deps.listen ?? listenHttp)(options.host, options.port, scaffoldRequestHandler);
      logger.info("listening", { url: listener.url });
    } catch (error) {
      logger.error("could not bind the HTTP listener", { error });
      await closeHarness(opened, closeTimeoutMs).catch(() => undefined);
      await releaseQuietly(lock, logger);
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
    done,
    close: () => shutdown("closed"),
    parkedTasks: () => [...parked.values()],
    retryTask: async (id: TaskId): Promise<void> => {
      await opened.harness.retryTask(id, context);
      parked.delete(String(id));
      opened.harness.resume();
    },
  };
  return { ok: true, app };
}
