// A small supervisor for the two children the launcher owns: the server and the
// quick tunnel. It is deliberately independent of `child_process` — the spawner
// is injected — so the restart policy can be tested with fake children and
// millisecond timings instead of a flaky integration test.
//
// Policy (PLAN §6.3, §6.8):
//   * restart a child that exits unexpectedly, with exponential backoff;
//   * reset the backoff once a child has stayed up long enough to count as
//     healthy, so a crash-loop does not inherit yesterday's delay;
//   * give up after a bounded number of consecutive failures rather than spin
//     forever on a broken install;
//   * `stop()` means stop — no restart after an intentional shutdown.

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
}

export const DEFAULT_BACKOFF: Backoff = {
  initialMs: 1_000,
  factor: 2,
  maxMs: 30_000,
  maxRestarts: 10,
  stableAfterMs: 60_000,
};

export interface SupervisorOptions {
  name: string;
  /** Start the child. Called again for every restart. */
  spawn: () => ChildLike;
  backoff?: Partial<Backoff>;
  /** One line at a time, already split; the caller decides where it goes. */
  onOutput?: (line: string, stream: "stdout" | "stderr") => void;
  onRestart?: (info: { attempt: number; delayMs: number; lastExit: ExitInfo }) => void;
  onGiveUp?: (info: { attempts: number; lastExit: ExitInfo }) => void;
  now?: () => number;
  /** Injected so tests do not wait in real time. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  uptimeMs: number;
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

  /** Stop the child and cancel any pending restart. Idempotent. */
  stop(): void {
    this.#state.stopping = true;
    this.#state.running = false;
    if (this.#timer !== undefined) {
      this.#clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const child = this.#child;
    this.#child = undefined;
    if (child) child.kill("SIGTERM");
  }

  #launch(): void {
    this.#startedAt = this.#now();
    let child: ChildLike;
    try {
      child = this.#options.spawn();
    } catch (error) {
      this.#handleExit({ code: null, signal: null, uptimeMs: 0 });
      if (error instanceof Error && this.#state.stopping === false) return;
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
      });
    }

    child.on("error", () => {
      // `error` (spawn failure) is followed by `exit` for a normal child; if it
      // is not, treating it as an exit keeps the policy in one place.
    });

    child.on("exit", (code, signal) => {
      if (this.#child !== child) return; // already replaced by stop()
      this.#child = undefined;
      this.#handleExit({ code, signal, uptimeMs: Math.max(0, this.#now() - this.#startedAt) });
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
