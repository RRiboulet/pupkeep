// The server contract around the Harness: one writer, a real bound port, an
// exit after a storage failure, a bounded close, and a parked task that is
// visible instead of silently dead.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, HarnessInspection, ReportInfo, SessionEnd, TaskId } from "@earendil-works/pi-durable";
import { startApp, type AppDeps, type ParkedTask } from "../src/server/app.ts";
import { main, parseServerEnvironment } from "../src/server/main.ts";
import { dataStores } from "../src/server/config.ts";
import { createLogger } from "../src/server/log.ts";
import { lockPath, SERVER_LOCK_FILE } from "../src/server/lock.ts";
import type { OpenedHarness } from "../src/server/harness.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pupkeep-app-"));
}

/** A minimal valid auth authority: the launcher would have minted this owner. */
async function seedConfig(dir: string): Promise<void> {
  const stores = dataStores(dir);
  await stores.config.ensure();
  await stores.config.update((config) => ({
    ...config,
    members: [
      {
        id: "owner",
        role: "owner",
        displayName: "Owner",
        createdAt: "2026-10-29T10:00:00.000Z",
        sessions: [],
      },
    ],
  }));
}

const noBootstrap = { bootstrap: async () => undefined };

function quietDeps(overrides: AppDeps = {}): AppDeps {
  return {
    logger: createLogger({ scope: "test", sink: () => undefined }),
    ...overrides,
  };
}

function isMissing(path: string): Promise<boolean> {
  return stat(path).then(
    () => false,
    () => true,
  );
}

interface FakeHarness {
  closed: Promise<SessionEnd>;
  resume(): void;
  close(context: unknown): Promise<void>;
  inspect(context: unknown): Promise<HarnessInspection>;
  retryTask(id: TaskId, context: unknown): Promise<void>;
}

function fakeOpened(harness: FakeHarness): OpenedHarness {
  return {
    harness: harness as unknown as Harness,
    storage: {} as OpenedHarness["storage"],
    database: {} as OpenedHarness["database"],
    path: "/tmp/fake.sqlite",
    context: BACKGROUND_CONTEXT,
  };
}

function deferredEnd(): { promise: Promise<SessionEnd>; resolve(end: SessionEnd): void } {
  let resolve!: (end: SessionEnd) => void;
  const promise = new Promise<SessionEnd>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("umask is set before the data directory or database is touched", async () => {
  const dir = await tempDir();
  const order: string[] = [];
  try {
    await seedConfig(dir);
    const result = await startApp(
      { dataDir: dir, host: "127.0.0.1", port: 0 },
      quietDeps({
        setUmask: (mode) => order.push(`umask:${mode.toString(8)}`),
        ensureDataDir: async (path) => {
          order.push("ensureDataDir");
          return { path, fixedMode: false };
        },
      }),
    );
    assert.ok(result.ok);
    assert.deepEqual(order.slice(0, 2), ["umask:77", "ensureDataDir"]);
    await result.app.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the server binds a real port, answers /healthz, and refuses everything else", async () => {
  const dir = await tempDir();
  try {
    await seedConfig(dir);
    const result = await startApp({ dataDir: dir, host: "127.0.0.1", port: 0 }, quietDeps());
    assert.ok(result.ok);
    try {
      assert.match(result.app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const health = await fetch(`${result.app.url}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });

      const query = await fetch(`${result.app.url}/healthz?probe=1`);
      assert.equal(query.status, 200);
      const head = await fetch(`${result.app.url}/healthz`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");

      const other = await fetch(`${result.app.url}/api/today`);
      assert.equal(other.status, 503);
      assert.match(await other.text(), /P1-09/);
    } finally {
      const end = await result.app.close();
      assert.deepEqual(end, { code: 0, reason: "closed" });
    }
    assert.equal(await isMissing(lockPath(dir, SERVER_LOCK_FILE)), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a second server on one data directory is refused and leaves the first alone", async () => {
  const dir = await tempDir();
  try {
    await seedConfig(dir);
    const first = await startApp({ dataDir: dir, host: "127.0.0.1", port: 0 }, quietDeps());
    assert.ok(first.ok);
    try {
      const second = await startApp({ dataDir: dir, host: "127.0.0.1", port: 0 }, quietDeps());
      assert.equal(second.ok, false);
      if (!second.ok) {
        assert.equal(second.code, 3);
        assert.match(second.message, /another server already owns/);
      }
      const health = await fetch(`${first.app.url}/healthz`);
      assert.equal(health.status, 200, "the refused start must not disturb the running server");
    } finally {
      await first.app.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a database that cannot be opened exits with a supervisor-restartable code and frees the lock", async () => {
  const dir = await tempDir();
  try {
    // A directory where the SQLite file belongs: a storage failure at open, not
    // a reason to start a server with an empty database.
    await mkdir(join(dir, "pupkeep.sqlite"), { mode: 0o700 });
    const result = await startApp({ dataDir: dir, host: "127.0.0.1", port: 0 }, quietDeps());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 5);
      assert.match(result.message, /could not open the harness/);
    }
    assert.equal(await isMissing(lockPath(dir, SERVER_LOCK_FILE)), true, "a failed open must release the lock");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("harness.closed failure exits non-zero so the supervisor restarts it", async () => {
  const dir = await tempDir();
  const end = deferredEnd();
  let closedOnce = false;
  const harness: FakeHarness = {
    closed: end.promise,
    resume: () => undefined,
    close: async () => {
      closedOnce = true;
    },
    inspect: async () => ({ scheduling: "running", tasks: [], submissions: [] }),
    retryTask: async () => undefined,
  };
  try {
    const result = await startApp(
      { dataDir: dir, host: "127.0.0.1", port: 0 },
      quietDeps({ openHarness: async () => fakeOpened(harness), ...noBootstrap }),
    );
    assert.ok(result.ok);
    end.resolve({ reason: "failed", error: new Error("storage went away") });
    const stopped = await result.app.done;
    assert.deepEqual(stopped, { code: 1, reason: "failed" });
    assert.equal(closedOnce, true, "the failed harness is still closed once");
    assert.equal(await isMissing(lockPath(dir, SERVER_LOCK_FILE)), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a close that a stuck task never finishes is capped and exits non-zero", async () => {
  const dir = await tempDir();
  const harness: FakeHarness = {
    closed: new Promise<SessionEnd>(() => undefined),
    resume: () => undefined,
    close: () => new Promise<void>(() => undefined),
    inspect: async () => ({ scheduling: "running", tasks: [], submissions: [] }),
    retryTask: async () => undefined,
  };
  try {
    const result = await startApp(
      { dataDir: dir, host: "127.0.0.1", port: 0, closeTimeoutMs: 25 },
      quietDeps({ openHarness: async () => fakeOpened(harness), ...noBootstrap }),
    );
    assert.ok(result.ok);
    const started = Date.now();
    const stopped = await result.app.close();
    assert.deepEqual(stopped, { code: 1, reason: "close_timeout" });
    assert.ok(Date.now() - started < 2_000, "the close timeout must bound the wait");
    // The harness may still be writing, so the lock must survive until the
    // process actually exits; the next start clears the dead pid.
    assert.equal(await isMissing(lockPath(dir, SERVER_LOCK_FILE)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a retry that parks the task again leaves it visible", async () => {
  const dir = await tempDir();
  const parked = { id: 2 as TaskId, kind: "app.reminder" };
  let report: ((error: unknown, info: ReportInfo) => void) | undefined;
  const harness: FakeHarness = {
    closed: new Promise<SessionEnd>(() => undefined),
    resume: () => undefined,
    close: async () => undefined,
    inspect: async () =>
      ({
        scheduling: "running",
        tasks: [{ record: parked, state: { kind: "blocked", reason: "restart_limit" } }],
        submissions: [],
      }) as unknown as HarnessInspection,
    retryTask: async (id: TaskId) => {
      report?.(new Error("parked again"), {
        type: "task_parked",
        task: { id, kind: "app.reminder", conversationId: 1 },
      } as unknown as ReportInfo);
    },
  };
  try {
    const result = await startApp(
      { dataDir: dir, host: "127.0.0.1", port: 0 },
      quietDeps({
        openHarness: async (options) => {
          report = options.onReport;
          return fakeOpened(harness);
        },
        ...noBootstrap,
      }),
    );
    assert.ok(result.ok);
    assert.deepEqual(result.app.parkedTasks().map((task: ParkedTask) => task.id), [2]);
    await result.app.retryTask(2 as TaskId);
    assert.deepEqual(
      result.app.parkedTasks().map((task: ParkedTask) => task.id),
      [2],
      "a park reported during the retry must not be deleted with the old one",
    );
    await result.app.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a task parked before this process started is surfaced and retryable", async () => {
  const dir = await tempDir();
  const end = deferredEnd();
  const retried: string[] = [];
  const parked = { id: 1 as TaskId, kind: "app.reminder" };
  const inspection = {
    scheduling: "running",
    tasks: [
      {
        record: parked,
        state: { kind: "blocked", reason: "restart_limit" },
      },
    ],
    submissions: [],
  } as unknown as HarnessInspection;
  const harness: FakeHarness = {
    closed: end.promise,
    resume: () => undefined,
    close: async () => undefined,
    inspect: async () => inspection,
    retryTask: async (id: TaskId) => {
      retried.push(String(id));
    },
  };
  try {
    const result = await startApp(
      { dataDir: dir, host: "127.0.0.1", port: 0 },
      quietDeps({ openHarness: async () => fakeOpened(harness), ...noBootstrap }),
    );
    assert.ok(result.ok);
    assert.deepEqual(
      result.app.parkedTasks().map((task: ParkedTask) => task.id),
      [1],
    );
    await result.app.retryTask(1 as TaskId);
    assert.deepEqual(retried, ["1"]);
    assert.deepEqual(result.app.parkedTasks(), []);
    await result.app.close();
  } finally {
    end.resolve({ reason: "closed" });
    await rm(dir, { recursive: true, force: true });
  }
});


test("the entry point turns a failed open into a non-zero exit for the supervisor", async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir, "pupkeep.sqlite"), { mode: 0o700 });
    const code = await main({
      PUPKEEP_BIND_HOST: "127.0.0.1",
      PUPKEEP_PORT: "8787",
      PUPKEEP_DATA_DIR: dir,
    });
    assert.equal(code, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the server entry refuses to guess a bind address or data directory", () => {
  assert.equal(parseServerEnvironment({ PUPKEEP_PORT: "8787", PUPKEEP_DATA_DIR: "/tmp/x" }).ok, false);
  assert.equal(
    parseServerEnvironment({ PUPKEEP_BIND_HOST: "127.0.0.1", PUPKEEP_PORT: "8787" }).ok,
    false,
  );
  assert.equal(
    parseServerEnvironment({
      PUPKEEP_BIND_HOST: "127.0.0.1",
      PUPKEEP_PORT: "0",
      PUPKEEP_DATA_DIR: "/tmp/x",
    }).ok,
    false,
  );
  const parsed = parseServerEnvironment(
    {
      PUPKEEP_BIND_HOST: "127.0.0.1",
      PUPKEEP_PORT: "8787",
      PUPKEEP_DATA_DIR: "~/pupkeep",
    },
    "/home/owner",
  );
  assert.deepEqual(parsed, {
    ok: true,
    environment: { host: "127.0.0.1", port: 8787, dataDir: "/home/owner/pupkeep" },
  });
});
