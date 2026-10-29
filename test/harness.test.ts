// The durability claims P1-07 is responsible for, as tests rather than prose:
// the exact open sequence leaves `synchronous = 2`, a committed document
// survives close and a real SIGKILL, and reopening the same file finds it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { openDurableDatabase, openHarness, TABLE_PREFIX } from "../src/server/harness.ts";

const PersistDoc = defineDoc({
  kind: "app.test.persist",
  version: 1,
  scope: "session",
  initial: () => ({ markers: [] as string[] }),
  checkpointWhen: () => true,
});

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pupkeep-harness-"));
}

async function readPragmas(path: string): Promise<{
  synchronous: number;
  journalMode: string;
  busyTimeout: number;
  foreignKeys: number;
}> {
  const db = await openDurableDatabase(path);
  try {
    const synchronous = (await db.get("PRAGMA synchronous")) as { synchronous: number };
    const journal = (await db.get("PRAGMA journal_mode")) as { journal_mode: string };
    const busy = (await db.get("PRAGMA busy_timeout")) as { timeout: number };
    const foreign = (await db.get("PRAGMA foreign_keys")) as { foreign_keys: number };
    return {
      synchronous: synchronous.synchronous,
      journalMode: journal.journal_mode,
      busyTimeout: busy.timeout,
      foreignKeys: foreign.foreign_keys,
    };
  } finally {
    await db.close();
  }
}

test("the open sequence leaves synchronous FULL, WAL, busy_timeout 5000 and pi_ tables", async () => {
  const dir = await tempDir();
  const path = join(dir, "pupkeep.sqlite");
  const opened = await openHarness({ path });
  try {
    const pragmas = await readPragmas(path);
    assert.equal(pragmas.synchronous, 2);
    assert.equal(pragmas.journalMode, "wal");
    assert.equal(pragmas.busyTimeout, 5000);
    assert.equal(pragmas.foreignKeys, 1);

    // The adapter's default would be NORMAL; a reopen must reapply FULL, not
    // inherit whatever the file or a previous connection left behind.
    await opened.harness.close(BACKGROUND_CONTEXT);
  } finally {
    await opened.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }

  const reopened = await openHarness({ path });
  try {
    assert.equal((await readPragmas(path)).synchronous, 2);
    const tables = await reopened.database.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    assert.ok(tables.length > 4);
    for (const table of tables) {
      assert.ok(table.name.startsWith(TABLE_PREFIX), `${table.name} is not pi_-prefixed`);
    }
    assert.ok(tables.some((table) => table.name === `${TABLE_PREFIX}durable_metadata`));
  } finally {
    await reopened.harness.close(BACKGROUND_CONTEXT);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a committed session document survives close and reopen", async () => {
  const dir = await tempDir();
  const path = join(dir, "pupkeep.sqlite");
  try {
    const first = await openHarness({ path });
    await first.harness.commit(async (tx) => {
      const doc = await tx.doc(PersistDoc);
      doc.markers.push("first");
    }, BACKGROUND_CONTEXT);
    await first.harness.close(BACKGROUND_CONTEXT);

    const second = await openHarness({ path });
    try {
      assert.deepEqual(await second.harness.snapshot(PersistDoc, BACKGROUND_CONTEXT), { markers: ["first"] });
      // `resume()` is the call that starts the scheduler; a reopen is not enough
      // on its own, and a sleeping reminder depends on it being called.
      second.harness.resume();
      assert.equal((await second.harness.inspect(BACKGROUND_CONTEXT)).scheduling, "running");
    } finally {
      await second.harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a SIGKILLed process leaves its committed document readable", async () => {
  const dir = await tempDir();
  const path = join(dir, "pupkeep.sqlite");
  const marker = join(dir, "ready");
  const fixture = fileURLToPath(new URL("../src/server/testing/harness-child.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture, path, marker], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitForFile(marker);
    child.kill("SIGKILL");
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    assert.equal(signal, "SIGKILL", `the child exited normally (code ${code}): ${stderr}`);

    const reopened = await openHarness({ path });
    try {
      assert.deepEqual(await reopened.harness.snapshot(PersistDoc, BACKGROUND_CONTEXT), {
        markers: ["before-kill"],
      });
      const check = (await reopened.database.get("PRAGMA integrity_check")) as { integrity_check: string };
      assert.equal(check.integrity_check, "ok");
      reopened.harness.resume();
      assert.equal((await reopened.harness.inspect(BACKGROUND_CONTEXT)).scheduling, "running");
    } finally {
      await reopened.harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
