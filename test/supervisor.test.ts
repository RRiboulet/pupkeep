import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Supervisor, type ChildLike } from "../src/launcher/supervisor.ts";

// A fake child: the supervisor's whole point is the policy around a process, so
// the process is the least interesting part of the test.
class FakeChild extends EventEmitter implements ChildLike {
  readonly pid = 4242;
  killed: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    return true;
  }
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

/** A clock whose time only moves when a test says so. */
function fakeClock() {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("a healthy child is not restarted, and stop() kills it", () => {
  const child = new FakeChild();
  const supervisor = new Supervisor({ name: "server", spawn: () => child, now: () => 0 });
  supervisor.start();
  assert.equal(supervisor.state().running, true);

  supervisor.stop();
  assert.deepEqual(child.killed, ["SIGTERM"]);
  assert.equal(supervisor.state().stopping, true);

  // An exit after stop must not schedule anything.
  child.exit(1, "SIGTERM");
  assert.equal(supervisor.state().restarts, 0);
});

test("an unexpected exit restarts with exponential backoff", () => {
  const clock = fakeClock();
  const delays: number[] = [];
  const timers: Array<() => void> = [];
  const children: FakeChild[] = [];

  const supervisor = new Supervisor({
    name: "server",
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    now: clock.now,
    setTimeoutFn: (fn, ms) => {
      delays.push(ms);
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeoutFn: () => {},
    backoff: { initialMs: 1000, factor: 2, maxMs: 5000, maxRestarts: 4, stableAfterMs: 60_000 },
  });

  supervisor.start();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    children[attempt]!.exit(1);
    timers[attempt]!();
  }

  assert.deepEqual(delays, [1000, 2000, 4000, 5000], "backoff doubles then caps");
  assert.equal(supervisor.state().restarts, 4);
});

test("long uptime resets the backoff, so a crash-loop is not punished forever", () => {
  const clock = fakeClock();
  const delays: number[] = [];
  const timers: Array<() => void> = [];
  let latest: FakeChild | undefined;

  const supervisor = new Supervisor({
    name: "server",
    spawn: () => (latest = new FakeChild()),
    now: clock.now,
    setTimeoutFn: (fn, ms) => {
      delays.push(ms);
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeoutFn: () => {},
    backoff: { initialMs: 1000, factor: 2, maxMs: 30_000, maxRestarts: 5, stableAfterMs: 60_000 },
  });

  supervisor.start();
  clock.advance(2_000); // dies early → attempt 1
  latest!.exit(1);
  timers.at(-1)!();

  clock.advance(120_000); // this one was healthy
  latest!.exit(1);

  assert.deepEqual(delays, [1000, 1000], "a healthy run resets the counter");
});

test("it gives up after maxRestarts instead of spinning forever", () => {
  const clock = fakeClock();
  const timers: Array<() => void> = [];
  let latest: FakeChild | undefined;
  const giveUps: number[] = [];

  const supervisor = new Supervisor({
    name: "server",
    spawn: () => (latest = new FakeChild()),
    now: clock.now,
    setTimeoutFn: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeoutFn: () => {},
    onGiveUp: ({ attempts }) => giveUps.push(attempts),
    backoff: { initialMs: 10, factor: 2, maxMs: 10, maxRestarts: 2, stableAfterMs: 60_000 },
  });

  supervisor.start();
  latest!.exit(1);
  timers.pop()!();
  latest!.exit(1);
  timers.pop()!();
  latest!.exit(1);

  assert.deepEqual(giveUps, [2]);
  assert.equal(supervisor.state().running, false);
});

test("output is split into lines, and partial lines are held until newline", () => {
  const child = new FakeChild();
  const lines: Array<[string, string]> = [];
  const supervisor = new Supervisor({
    name: "server",
    spawn: () => child,
    onOutput: (line, stream) => lines.push([stream, line]),
    now: () => 0,
  });
  supervisor.start();

  child.stdout.emit("data", "2026-10-29 INF starting\n");
  child.stdout.emit("data", "partial ");
  child.stderr.emit("data", "warn: something\n");

  assert.deepEqual(lines, [
    ["stdout", "2026-10-29 INF starting"],
    ["stderr", "warn: something"],
  ]);

  child.stdout.emit("data", "line\n");
  assert.deepEqual(lines.at(-1), ["stdout", "partial line"]);
});

test("a spawn that throws is treated as a failed attempt, not a crash", () => {
  const clock = fakeClock();
  let attempts = 0;
  const supervisor = new Supervisor({
    name: "server",
    spawn: () => {
      attempts += 1;
      throw new Error("ENOENT");
    },
    now: clock.now,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    backoff: { initialMs: 1, factor: 2, maxMs: 1, maxRestarts: 3, stableAfterMs: 1000 },
  });

  assert.doesNotThrow(() => supervisor.start());
  assert.equal(attempts, 1);
});

// --- the two failures a green suite missed -----------------------------------

test("a spawn error with no exit is treated as a failed attempt, not silence", async () => {
  // Node emits `error` for ENOENT/EACCES and does NOT always follow it with
  // `exit` (verified on Node 24). The first version of this supervisor ignored
  // `error`, so a missing binary looked like a healthy service forever.
  const clock = fakeClock();
  const timers: Array<() => void> = [];
  const errors: string[] = [];
  const children: FakeChild[] = [];
  let attempts = 0;

  const supervisor = new Supervisor({
    name: "tunnel",
    spawn: () => {
      attempts += 1;
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    now: clock.now,
    setTimeoutFn: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeoutFn: () => {},
    onError: (error) => errors.push(error.message),
    backoff: { initialMs: 10, factor: 2, maxMs: 10, maxRestarts: 3, stableAfterMs: 60_000 },
  });

  supervisor.start();
  // Only `error`, never `exit` — exactly what ENOENT does.
  children[0]!.emit("error", Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" }));

  assert.equal(attempts, 1, "a failed spawn must be scheduled for a retry");
  assert.deepEqual(errors, ["spawn cloudflared ENOENT"], "and the reason must be reported");
  assert.equal(timers.length, 1);

  timers[0]!();
  assert.equal(attempts, 2, "the retry actually happens");
});

test("an error followed by exit restarts once, not twice", () => {
  const clock = fakeClock();
  const timers: Array<() => void> = [];
  const child = new FakeChild();
  const supervisor = new Supervisor({
    name: "server",
    spawn: () => child,
    now: clock.now,
    setTimeoutFn: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeoutFn: () => {},
    backoff: { initialMs: 10, factor: 2, maxMs: 10, maxRestarts: 5, stableAfterMs: 60_000 },
  });

  supervisor.start();
  child.emit("error", new Error("spawn ENOENT"));
  child.exit(1);

  assert.equal(timers.length, 1, "two events, one restart");
});

test("stop() waits for the child, then escalates to SIGKILL", async () => {
  const clock = fakeClock();
  const signals: NodeJS.Signals[] = [];
  const timers: Array<() => void> = [];

  class StubbornChild extends FakeChild {
    override kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
      signals.push(signal);
      // Ignores SIGTERM entirely; only SIGKILL takes it down.
      if (signal === "SIGKILL") queueMicrotask(() => this.emit("exit", null, "SIGKILL"));
      return true;
    }
  }

  const child = new StubbornChild();
  const supervisor = new Supervisor({
    name: "server",
    spawn: () => child,
    now: clock.now,
    setTimeoutFn: (fn, ms) => {
      timers.push(fn);
      if (ms <= 100) setTimeout(() => fn(), 0); // let the short waits fire
      return timers.length - 1;
    },
    clearTimeoutFn: () => {},
    backoff: { initialMs: 10, factor: 2, maxMs: 10, maxRestarts: 5, stableAfterMs: 60_000, killTimeoutMs: 5 },
  });

  supervisor.start();
  const stopping = supervisor.stop();
  // Let the grace period expire without waiting three real seconds.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await stopping;

  assert.ok(signals.includes("SIGTERM"), "TERM is tried first");
  assert.ok(signals.includes("SIGKILL"), "then the escalation, because TERM was ignored");
});

test("stop() resolves once the child exits, so the caller can release a lock after it", async () => {
  const child = new FakeChild();
  const supervisor = new Supervisor({ name: "server", spawn: () => child, now: () => 0 });
  supervisor.start();

  const stopping = supervisor.stop();
  let done = false;
  void stopping.then(() => (done = true));

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(done, false, "stop() must not resolve while the child is alive");

  child.exit(0, "SIGTERM");
  await stopping;
  assert.equal(done, true);
});

test("a line without a newline cannot grow the buffer forever", () => {
  const child = new FakeChild();
  const lines: string[] = [];
  const supervisor = new Supervisor({
    name: "server",
    spawn: () => child,
    onOutput: (line) => lines.push(line),
    now: () => 0,
  });
  supervisor.start();

  child.stderr.emit("data", "x".repeat(70 * 1024));
  child.stderr.emit("data", "after\n");
  // The oversized partial line is dropped; the next complete line still arrives.
  assert.deepEqual(lines, ["after"]);
});
