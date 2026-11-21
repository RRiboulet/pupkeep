// `/health` is liveness; `/healthz` is the honest check (PLAN R8).
//
// A probe that cannot fail is not a check, so this suite spends its effort on
// the failure paths: an SQLite handle that really is closed, a free-byte count
// really under the floor, a read that never answers. Each case asserts the 503
// *and* that its body names the check and nothing else — §14.2 forbids a path, a
// version or a count in a body a stranger can read.
//
// The success path is asserted once, on the same real handle that is then
// closed, so the 200 and the 503 come from one artifact rather than two fixtures.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { Auth } from "../src/server/auth.ts";
import { RateLimiter } from "../src/server/auth.ts";
import type { ThreadBus } from "../src/server/agent/bus.ts";
import { listenHttp } from "../src/server/app.ts";
import { dataStores } from "../src/server/config.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import {
  HEALTH_DISK_FLOOR_BYTES,
  checkHealth,
  freeDiskBytes,
} from "../src/server/health.ts";
import {
  createAppHandler,
  HEALTH_LIMIT,
  SIGNIN_LIMIT,
  SIGNIN_WINDOW_MS,
  SUBMIT_LIMIT,
  SUBMIT_WINDOW_MS,
} from "../src/server/http.ts";
import { createLogger } from "../src/server/log.ts";

interface Gate {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Any use of the auth authority from a health route is a bug (§14.2: both are
 * unauthenticated and answer before the session lookup), so make it loud rather
 * than a silent `undefined`.
 */
const unreachableAuth = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`the health route reached auth.${String(property)}`);
    },
  },
) as unknown as Auth;

/** A listener over the real router, with only the health route's needs real. */
async function healthGate(options: {
  harness: Harness;
  /** The data directory: `push.json` sits in it, so `/healthz` can find the disk. */
  dir: string;
  freeBytes?: (directory: string) => Promise<number>;
  now?: () => number;
}): Promise<Gate> {
  const listener = await listenHttp(
    "127.0.0.1",
    0,
    createAppHandler({
      auth: unreachableAuth,
      thread: { harness: options.harness, context: BACKGROUND_CONTEXT },
      // The health route never reaches the SSE fanout either.
      bus: {} as unknown as ThreadBus,
      push: dataStores(options.dir).push,
      submitLimiter: new RateLimiter(SUBMIT_LIMIT, SUBMIT_WINDOW_MS),
      signInLimiter: new RateLimiter(SIGNIN_LIMIT, SIGNIN_WINDOW_MS),
      allowedOrigins: () => [],
      logger: createLogger({ scope: "test", sink: () => undefined }),
      ...(options.freeBytes !== undefined ? { freeBytes: options.freeBytes } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    }),
  );
  return { url: listener.url, close: () => listener.close() };
}

async function tempDatabase(): Promise<{ dir: string; opened: OpenedHarness }> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-health-"));
  return { dir, opened: await openHarness({ path: join(dir, "pupkeep.sqlite") }) };
}

/** The body rule in one place: the check's name, and no number or path. */
function assertNamesOnly(body: string, dir: string, failed: readonly string[]): void {
  assert.deepEqual(JSON.parse(body), { ok: false, failed });
  assert.equal(body.includes(dir), false, "no data-directory path");
  assert.equal(/\d/.test(body), false, "no version, no count, no byte total");
}

test("a closed database keeps /health alive and fails /healthz on storage alone", async () => {
  const { dir, opened } = await tempDatabase();
  const gate = await healthGate({ harness: opened.harness, dir });
  try {
    // No session cookie and a hostile Origin: both endpoints are outside the
    // auth and origin gates, and a probe has no reason to carry either.
    const healthy = await fetch(`${gate.url}/healthz`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(healthy.status, 200, "a working database passes the deep check");
    assert.deepEqual(await healthy.json(), { ok: true });

    // The real handle, closed: what a wedged or vanished database looks like to
    // every route. The listener keeps answering — only the storage is gone.
    await opened.harness.close(BACKGROUND_CONTEXT);

    const alive = await fetch(`${gate.url}/health`);
    assert.equal(alive.status, 200, "/health never reads storage, so the process is still up");
    assert.deepEqual(await alive.json(), { ok: true });

    const deep = await fetch(`${gate.url}/healthz`);
    assert.equal(deep.status, 503);
    assertNamesOnly(await deep.text(), dir, ["storage"]);

    const head = await fetch(`${gate.url}/healthz`, { method: "HEAD" });
    assert.equal(head.status, 503, "a HEAD probe hears the same answer");
    assert.equal(await head.text(), "");
  } finally {
    await gate.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a disk under the floor fails /healthz on disk alone, and the floor is the minimum", async () => {
  const { dir, opened } = await tempDatabase();
  try {
    // The directory the check is asked about is the one this process writes to
    // (found through `push.json`), not a path the caller had to remember.
    let asked: string | undefined;
    const under = await healthGate({
      harness: opened.harness,
      dir,
      freeBytes: async (directory) => {
        asked = directory;
        return HEALTH_DISK_FLOOR_BYTES - 1;
      },
    });
    try {
      const response = await fetch(`${under.url}/healthz`);
      assert.equal(response.status, 503);
      assertNamesOnly(await response.text(), dir, ["disk"]);
      assert.equal(asked, dir, "the floor is measured on the data directory itself");
      // Liveness is untouched by a full disk: restarting the process would not
      // free a byte of one.
      const alive = await fetch(`${under.url}/health`);
      assert.equal(alive.status, 200);
    } finally {
      await under.close();
    }

    const atFloor = await healthGate({
      harness: opened.harness,
      dir,
      freeBytes: async () => HEALTH_DISK_FLOOR_BYTES,
    });
    try {
      const response = await fetch(`${atFloor.url}/healthz`);
      assert.equal(response.status, 200, "the floor is a minimum, not a target");
    } finally {
      await atFloor.close();
    }
  } finally {
    await opened.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("both checks are always evaluated, so one failure never hides the other", async () => {
  const { dir, opened } = await tempDatabase();
  await opened.harness.close(BACKGROUND_CONTEXT);
  const gate = await healthGate({ harness: opened.harness, dir, freeBytes: async () => 0 });
  try {
    const response = await fetch(`${gate.url}/healthz`);
    assert.equal(response.status, 503);
    assertNamesOnly(await response.text(), dir, ["storage", "disk"]);
  } finally {
    await gate.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a storage read that never answers is bounded, not hung", async () => {
  const report = await checkHealth({
    readStorage: () => new Promise(() => undefined),
    dataDir: tmpdir(),
    freeBytes: async () => HEALTH_DISK_FLOOR_BYTES,
    storageTimeoutMs: 25,
  });
  // The one case the handler cannot show without a wedged handle: a read that
  // never settles must still produce an answer, and it must be "storage".
  assert.deepEqual(report, { ok: false, failed: ["storage"] });
});

test("the real statfs path answers with bytes, and this host has room", async () => {
  const { dir, opened } = await tempDatabase();
  try {
    const bytes = await freeDiskBytes(dir);
    assert.equal(Number.isFinite(bytes), true);
    assert.ok(bytes > 0, "a free-byte count is a positive number of bytes");
    // No seam here: the real `statfs` on a real directory, which is what a
    // deployment gets. It only fails on a disk that is actually below the floor.
    const report = await checkHealth({ readStorage: async () => undefined, dataDir: dir });
    assert.deepEqual(report, { ok: true, failed: [] });
  } finally {
    await opened.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a probe flood is capped with a 429, never a 503", async () => {
  const { dir, opened } = await tempDatabase();
  // The pinned clock makes the window a value rather than a race.
  const gate = await healthGate({ harness: opened.harness, dir, now: () => 1_000, freeBytes: async () => 0 });
  try {
    // The disk seam answers "no room", so every request would be a 503 if the
    // limiter did not answer first: the two are distinguishable in the status.
    for (let attempt = 0; attempt < HEALTH_LIMIT; attempt += 1) {
      const response = await fetch(`${gate.url}/healthz`);
      assert.equal(response.status, 503, `probe ${attempt} is answered, not throttled`);
    }
    const limited = await fetch(`${gate.url}/healthz`);
    assert.equal(limited.status, 429, "a throttled probe is not a sick app");
    const body = (await limited.json()) as { error: string };
    assert.match(body.error, /too many health probes/);

    // Liveness is a separate, unlimited answer: Docker reads it every 30 s.
    const alive = await fetch(`${gate.url}/health`);
    assert.equal(alive.status, 200);
  } finally {
    await gate.close();
    await opened.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
