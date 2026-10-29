// A small supervisor for the two children the launcher owns: the server and the
// quick tunnel. It is deliberately independent of `child_process` — the spawner
// is injected — so the restart policy and the shutdown ladder can be tested with
// fake children and millisecond timings instead of a flaky integration test.
//
// Policy (PLAN §6.3, §6.8):
//   * restart a child that exits unexpectedly, with exponential backoff;
//   * reset the backoff once a child has stayed up long enough to count as
//     healthy, so a crash-loop does not inherit yesterday's delay;
//   * give up after a bounded number of consecutive failures rather than spin
//     forever on a broken install;
//   * `stop()` means stop, it **waits** for the child, and it escalates.
//
// Two lessons are baked in because a green test suite missed both the first time:
//   * a failed spawn emits `error` and **no** `exit` (verified on Node 24), so an
//     `error`-only handler that does nothing leaves the supervisor "running"
//     forever with no restart, no give-up and no log line;
//   * killing a wrapper kills the wrapper. `termux-chroot` is the tunnel's direct
//     child on the phone, so shutdown signals the process *group*, waits, and
//     escalates to SIGKILL rather than orphaning a live tunnel.

export interface ChildLike {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null | undefined;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null | undefined;
}

export interface Backoff {
  initialMs: number;
  factor: number;
  maxMs: number;
  /** Consecutive failures before giving up. */
  maxRestarts: number;
  /** Uptime that counts as healthy and resets the counter. */
  stableAfterMs: number;
  /** How long a stop waits after SIGTERM before escalating to SIGKILL. */
  killTimeoutMs: number;
}

export const DEFAULT_BACKOFF: Backoff = {
  initialMs: 1_000,
  factor: 2,
  maxMs: 30_000,
  maxRestarts: 10,
  stableAfterMs: 60_000,
  killTimeoutMs: 3_000,
};

/** Longest partial line held before the buffer is dropped. */
const MAX_LINE_BYTES = 64 * 1024;

export interface SupervisorOptions {
  name: string;
  /** Start the child. Called again for every restart. */
  spawn: () => ChildLike;
  backoff?: Partial<Backoff>;
  /** One line at a time, already split; the caller decides where it goes. */
  onOutput?: (line: string, stream: "stdout" | "stderr") => void;
  onRestart?: (info: { attempt: number; delayMs: number; lastExit: ExitInfo }) => void;
  /** Called once the restart budget is spent; the child is not running. */
  onGiveUp?: (info: { attempts: number; lastExit: ExitInfo }) => void;
  /** A failed spawn, reported rather than swallowed. */
  onError?: (error: Error) => void;
  now?: () => number;
  /** Injected so tests do not wait in real time. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  uptimeMs: number;
  error?: string;
}

export interface SupervisorState {
  running: boolean;
  stopping: boolean;
  attempts: number;
  restarts: number;
  lastExit?: ExitInfo;
}

export class Supervisor {
  readonly #options: SupervisorOptions;
  readonly #backoff: Backoff;
  readonly #now: () => number;
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;

  #child?: ChildLike;
  #startedAt = 0;
  #timer?: unknown;
  /** Resolves when the current child is gone; used by stop() to wait. */
  #exited?: { promise: Promise<void>; resolve: () => void };
  #state: SupervisorState = { running: false, stopping: false, attempts: 0, restarts: 0 };

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.#now = options.now ?? Date.now;
    this.#setTimeout = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  state(): SupervisorState {
    return { ...this.#state };
  }

  start(): void {
    if (this.#child !== undefined) throw new Error(`${this.#options.name} already started`);
    this.#state = { ...this.#state, stopping: false, running: true };
    this.#launch();
  }

  /**
   * Stop the child and cancel any pending restart. Resolves only once the child
   * is gone — TERM, wait `killTimeoutMs`, then KILL and wait briefly. The caller
   * (the launcher) must not release the data-directory lock before this returns.
   */
  async stop(): Promise<void> {
    this.#state.stopping = true;
    this.#state.running = false;
    if (this.#timer !== undefined) {
      this.#clearTimeout(this.#timer);
      this.#timer = undefined;
    }

    const child = this.#child;
    if (!child) return;
    const exited = this.#exitWaiter(child);

    this.#signal(child, "SIGTERM");
    if (await this.#within(exited.promise, this.#backoff.killTimeoutMs)) return;

    this.#signal(child, "SIGKILL");
    if (await this.#within(exited.promise, 500)) return;
    // A child that outlived SIGKILL is a kernel-level problem; say so instead of
    // pretending the shutdown was clean.
    this.#options.onError?.(new Error(`${this.#options.name} did not exit after SIGKILL`));
  }

  #within(promise: Promise<void>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = this.#setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, ms);
      promise.then(() => {
        if (settled) return;
        settled = true;
        this.#clearTimeout(timer);
        resolve(true);
      });
    });
  }

  #exitWaiter(child: ChildLike): { promise: Promise<void>; resolve: () => void } {
    if (this.#exited) return this.#exited;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    this.#exited = { promise, resolve };
    return this.#exited;
  }

  /**
   * Signal the child *group* when possible: the tunnel's direct child is a
   * wrapper (`termux-chroot`), and killing only the wrapper orphans cloudflared.
   */
  #signal(child: ChildLike, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (typeof pid === "number" && pid > 0) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Not a group leader (or not detached); fall through to the child.
      }
    }
    try {
      child.kill(signal);
    } catch (error) {
      this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #launch(): void {
    this.#startedAt = this.#now();
    this.#exited = undefined;

    let child: ChildLike;
    try {
      child = this.#options.spawn();
    } catch (error) {
      // A spawner that throws is a failed attempt; keep the policy in one place.
      if (!this.#state.stopping) {
        this.#handleExit({ code: null, signal: null, uptimeMs: 0, error: String(error) });
      }
      return;
    }
    this.#child = child;

    for (const stream of ["stdout", "stderr"] as const) {
      const pipe = child[stream];
      if (!pipe) continue;
      let buffer = "";
      pipe.on("data", (chunk) => {
        buffer += String(chunk);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line !== "") this.#options.onOutput?.(line, stream);
          newline = buffer.indexOf("\n");
        }
        if (buffer.length > MAX_LINE_BYTES) {
          // A child that never emits a newline must not grow the phone's heap.
          buffer = "";
        }
      });
    }

    let exited = false;
    const exitOnce = (exit: ExitInfo): void => {
      if (exited) return;
      exited = true;
      if (this.#child !== child) return; // already replaced or stopped
      this.#child = undefined;
      this.#exited?.resolve();
      this.#handleExit(exit);
    };

    // `error` fires for a failed exec (ENOENT, EACCES) and is *not* always
    // followed by `exit` — treating it as an exit is what keeps a missing binary
    // from looking like a healthy service. A normal child emits both; `exitOnce`
    // makes the second one a no-op.
    child.on("error", (error) => {
      this.#options.onError?.(error);
      exitOnce({
        code: null,
        signal: null,
        uptimeMs: Math.max(0, this.#now() - this.#startedAt),
        error: error.message,
      });
    });

    child.on("exit", (code, signal) => {
      exitOnce({ code, signal, uptimeMs: Math.max(0, this.#now() - this.#startedAt) });
    });
  }

  #handleExit(exit: ExitInfo): void {
    this.#state.lastExit = exit;
    if (this.#state.stopping) {
      this.#state.running = false;
      return;
    }

    if (exit.uptimeMs >= this.#backoff.stableAfterMs) {
      this.#state.attempts = 0;
    }

    if (this.#state.attempts >= this.#backoff.maxRestarts) {
      this.#state.running = false;
      this.#options.onGiveUp?.({ attempts: this.#state.attempts, lastExit: exit });
      return;
    }

    const delayMs = Math.min(
      this.#backoff.initialMs * this.#backoff.factor ** this.#state.attempts,
      this.#backoff.maxMs,
    );
    this.#state.attempts += 1;
    this.#state.restarts += 1;
    this.#options.onRestart?.({ attempt: this.#state.attempts, delayMs, lastExit: exit });

    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined;
      if (this.#state.stopping) return;
      this.#launch();
    }, delayMs);
  }
}
