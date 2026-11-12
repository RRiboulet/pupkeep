// The live transport's silent-stream fallback (P5-01 follow-up).
//
// Cloudflare's quick tunnel buffers a streaming GET response: the client sees
// the `200` and the headers, then no body bytes at all — no snapshot, no
// heartbeat. The stream therefore reports "open" and then nothing, which the
// old code treated as healthy and the old fallback (`typeof EventSource !==
// "function"`) never caught. These tests drive `web/live.js` with fake
// EventSources and short timing seams:
//
//   * silence after `open` falls back to polling the care state;
//   * a healthy stream (snapshot + heartbeats) never polls and never opens a
//     second source;
//   * a probe that delivers its snapshot switches back to live frames and stops
//     the poll loop;
//   * only one source is ever open, and `close()` stops every timer.

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

// `web/` is plain JS the browser loads directly and tsc does not type, so the
// specifier is not a literal here: the import yields `any` instead of demanding
// a declaration, the same seam the other web tests use (`test/client.test.js`).
const LIVE = "../web/live.js";
const { isPolling, startLive, subscribeThread } = await import(LIVE);

type Listener = (event?: unknown) => void;

interface FakeSource {
  closed: boolean;
  addEventListener(type: string, listener: Listener): void;
  close(): void;
  fire(type: string, event?: unknown): void;
}

function fakeSource(): FakeSource {
  const listeners = new Map<string, Listener[]>();
  return {
    closed: false,
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    close() {
      this.closed = true;
    },
    fire(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

/** Generous relative to pollMs: a stalled CI machine must not turn a pass red. */
async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(5);
  }
  return predicate();
}

function snapshotFrame(seq: number): { data: string } {
  return {
    data: JSON.stringify({ seq, status: { busy: false, queued: 0 }, entries: [] }),
  };
}

const TIMING = { firstFrameMs: 100, silenceMs: 400, pollMs: 25, retryMs: 500 };

/**
 * A live transport with fake sources and counting seams. Retry probes are far
 * enough away in the default timing that a test which does not want one never
 * sees it; the recovery tests override the timings.
 */
function harness(overrides: Record<string, unknown> = {}) {
  const sources: FakeSource[] = [];
  const counts = { refresh: 0, badge: 0 };
  const live = startLive({
    ...TIMING,
    ...overrides,
    createSource: () => {
      const source = fakeSource();
      sources.push(source);
      return source;
    },
    refresh: () => {
      counts.refresh += 1;
    },
    refreshUnread: () => {
      counts.badge += 1;
    },
  });
  return { live, sources, counts };
}

test("a stream that opens and then stays silent falls back to polling", async () => {
  const { live, sources, counts } = harness();
  const events: Array<{ type: string }> = [];
  const stop = subscribeThread((event: unknown) => events.push(event as { type: string }));

  sources[0]!.fire("open");
  assert.equal(counts.refresh, 1, "the open frame reads the care state once");

  assert.ok(await waitFor(() => isPolling()), "silence past firstFrameMs starts polling");
  assert.equal(sources[0]!.closed, true, "the silent stream is closed, not left busy");
  assert.equal(
    events.filter((event) => event.type === "poll").length,
    1,
    "the Agent screen is told exactly once",
  );

  await sleep(TIMING.pollMs * 2 + 10);
  assert.ok(counts.refresh >= 2, "the care state is re-read on the poll cadence");
  assert.ok(counts.badge >= 2, "the unread badge is re-read on the poll cadence");
  assert.equal(isPolling(), true);

  stop();
  live.close();
});

test("a healthy stream never polls and reads the care state only on open", async () => {
  const { live, sources, counts } = harness();
  const events: Array<{ type: string }> = [];
  const stop = subscribeThread((event: unknown) => events.push(event as { type: string }));

  sources[0]!.fire("open");
  sources[0]!.fire("snapshot", snapshotFrame(1));
  for (let index = 0; index < 3; index += 1) {
    // The server's heartbeat is well inside silenceMs; the stream is alive.
    await sleep(40);
    sources[0]!.fire("heartbeat", { data: "{}" });
  }

  assert.equal(isPolling(), false);
  assert.equal(
    events.some((event) => event.type === "poll"),
    false,
    "a flowing body is never polled",
  );
  assert.equal(counts.refresh, 1, "one open, one care read");
  assert.equal(sources.length, 1, "no second source while the body flows");
  assert.equal(sources[0]!.closed, false);

  stop();
  live.close();
});

test("a stream that goes silent after a healthy snapshot still falls back", async () => {
  const { live, sources, counts } = harness({
    firstFrameMs: 60,
    silenceMs: 200,
    retryMs: 500,
    pollMs: 20,
  });

  sources[0]!.fire("open");
  sources[0]!.fire("snapshot", snapshotFrame(1));
  assert.equal(isPolling(), false, "a fresh snapshot means the body is flowing");

  assert.ok(
    await waitFor(() => isPolling(), 1500),
    "silenceMs without a heartbeat is a buffered body, not an idle one",
  );
  assert.equal(sources[0]!.closed, true);

  await sleep(60);
  assert.ok(counts.refresh >= 2, "the care state is refreshed while polling");
  live.close();
});

test("a retry source that delivers its snapshot switches back to the live stream", async () => {
  const { live, sources, counts } = harness({
    firstFrameMs: 200,
    silenceMs: 500,
    retryMs: 50,
    pollMs: 20,
  });
  const events: Array<{ type: string }> = [];
  const stop = subscribeThread((event: unknown) => events.push(event as { type: string }));

  sources[0]!.fire("open");
  assert.ok(await waitFor(() => isPolling()));
  assert.ok(await waitFor(() => sources.length >= 2), "the fallback probes the stream again");

  const probe = sources[sources.length - 1]!;
  probe.fire("open");
  probe.fire("snapshot", snapshotFrame(7));

  assert.equal(isPolling(), false, "a frame means the transport works again");
  assert.equal(probe.closed, false, "the recovered source is kept");
  assert.ok(
    events.some((event) => event.type === "open"),
    "the Agent screen is told to catch up",
  );
  assert.ok(events.some((event) => event.type === "snapshot"));

  // The poll loop is stopped, not merely idle: with pollMs = 20 a running loop
  // would add several refreshes in this window.
  const after = counts.refresh;
  await sleep(120);
  assert.equal(counts.refresh, after, "the poll loop stopped");

  stop();
  live.close();
});

test("only one live source exists at a time", async () => {
  const { live, sources } = harness({
    firstFrameMs: 150,
    silenceMs: 500,
    retryMs: 50,
    pollMs: 20,
  });
  const liveCount = () => sources.filter((source) => !source.closed).length;

  assert.equal(liveCount(), 1);
  sources[0]!.fire("open");
  assert.ok(await waitFor(() => isPolling()));
  assert.equal(liveCount(), 0, "the silent stream is closed before polling starts");

  assert.ok(await waitFor(() => sources.length >= 2), "the first probe is created");
  assert.ok(liveCount() <= 1, "one probe at most");

  const firstProbe = sources[1]!;
  assert.ok(await waitFor(() => sources.length >= 3, 2000), "a silent probe is replaced");
  assert.equal(firstProbe.closed, true, "the silent probe does not linger");
  assert.ok(liveCount() <= 1);

  const recovered = sources[sources.length - 1]!;
  recovered.fire("open");
  recovered.fire("snapshot", snapshotFrame(2));
  assert.equal(isPolling(), false);
  assert.equal(liveCount(), 1, "the promoted source is the only live one");

  live.close();
});

test("close stops every timer, including the poll and retry loops", async () => {
  const { live, sources, counts } = harness({
    firstFrameMs: 80,
    silenceMs: 400,
    retryMs: 50,
    pollMs: 20,
  });

  sources[0]!.fire("open");
  assert.ok(await waitFor(() => isPolling()));
  await sleep(60); // let a poll tick or two run

  live.close();
  const after = counts.refresh;
  assert.equal(isPolling(), false);

  await sleep(300); // longer than pollMs, retryMs and firstFrameMs
  assert.equal(counts.refresh, after, "no poll callback runs after close");
  assert.equal(
    sources.every((source) => source.closed),
    true,
    "no source is left open",
  );
});

test("an outage that keeps emitting errors still falls back to polling", async () => {
  // EventSource retries every few seconds. An `error` is not a frame: if it
  // re-armed the silence clock, a connect-failure loop (origin down, a 502 from
  // the tunnel) would keep the watchdog away and the fallback would never run.
  const { live, sources } = harness({ firstFrameMs: 120, silenceMs: 200, pollMs: 20, retryMs: 1000 });
  const events: Array<{ type: string }> = [];
  const stop = subscribeThread((event: unknown) => events.push(event as { type: string }));

  try {
    sources[0]!.fire("open");
    sources[0]!.fire("snapshot", snapshotFrame(1));
    assert.equal(isPolling(), false, "one good frame means the body flowed");

    // Errors every 30 ms: a re-arming clock would never fire, so only the last
    // real frame's timer can trip the fallback.
    let errors = 0;
    for (let index = 0; index < 12 && !isPolling(); index += 1) {
      sources[0]!.fire("error");
      errors += 1;
      await sleep(30);
    }

    assert.ok(errors >= 3, "the outage delivered several retries");
    assert.equal(isPolling(), true, "repeated errors must not keep the fallback away");
    assert.equal(sources[0]!.closed, true, "the failing source is closed");
    assert.equal(
      events.filter((event) => event.type === "error").length,
      errors,
      "every attempt is still reported while the fallback is pending",
    );
  } finally {
    stop();
    live.close();
  }
});

test("a probe the server closes is not promoted as a recovered stream", async () => {
  // `bus.subscribe` sends `reconnect` on cap eviction and shutdown. Promoting
  // that probe would stop the poll loop and announce `open` for a connection
  // that is already ended.
  const { live, sources, counts } = harness({ firstFrameMs: 500, silenceMs: 500, pollMs: 20, retryMs: 60 });
  const events: Array<{ type: string }> = [];
  const stop = subscribeThread((event: unknown) => events.push(event as { type: string }));

  try {
    sources[0]!.fire("open");
    assert.ok(await waitFor(() => isPolling()));
    assert.ok(await waitFor(() => sources.length >= 2), "the fallback probes the stream");

    const probe = sources[sources.length - 1]!;
    const before = events.length;
    probe.fire("reconnect");

    assert.equal(isPolling(), true, "a closed probe is not a recovered transport");
    assert.equal(probe.closed, true, "the probe is dropped");
    assert.deepEqual(
      events.slice(before).map((event) => event.type),
      [],
      "no catch-up burst for a connection the server just closed",
    );

    const after = counts.refresh;
    await sleep(80);
    assert.ok(counts.refresh > after, "the care poll loop keeps running");
  } finally {
    stop();
    live.close();
  }
});
