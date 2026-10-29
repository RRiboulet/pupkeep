// P0-07 left one restore case open: the encrypted bundle was a cleanly closed
// snapshot and an in-progress generation was not restored. This test closes it
// the way PLAN §16's P1-07 bullet asks: a faux provider stalls with a committed
// `pi.generation` task, the process is SIGKILLed, the database is backed up and
// restored elsewhere, and `harness.resume()` finishes the generation there.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, type SubmissionId } from "@earendil-works/pi-durable";
import { dataPaths, dataStores } from "../src/server/config.ts";
import { backupDataDir, restoreDataDir, type ArchiveCipher } from "../src/server/backup.ts";
import { openHarness } from "../src/server/harness.ts";

const PASSPHRASE = "correct-horse-battery-staple";

const identityCipher: ArchiveCipher = {
  encrypt: async (input, output) => {
    await copyFile(input, output);
  },
  decrypt: async (input, output) => {
    await copyFile(input, output);
  },
};

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await stat(path).catch(() => undefined))?.isFile()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a backup restores an interrupted generation and resume() finishes it", { timeout: 90_000 }, async () => {
  const source = await mkdtemp(join(tmpdir(), "pupkeep-generation-src-"));
  const target = await mkdtemp(join(tmpdir(), "pupkeep-generation-dst-"));
  const submissionMarker = join(source, "submission-id");
  const calledMarker = join(source, "provider-called");
  const fixture = fileURLToPath(new URL("../src/server/testing/generation-child.ts", import.meta.url));

  const stores = dataStores(source);
  await stores.config.ensure();
  await stores.push.update((push) => push);

  const child = spawn(process.execPath, [fixture, dataPaths(source).database, submissionMarker, calledMarker], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await Promise.all([waitFor(submissionMarker, 60_000), waitFor(calledMarker, 60_000)]);
    const submissionId = Number((await readFile(submissionMarker, "utf8")).trim()) as SubmissionId;
    assert.ok(Number.isSafeInteger(submissionId) && submissionId > 0);

    child.kill("SIGKILL");
    const [, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    assert.equal(signal, "SIGKILL", `the child exited before it could be killed: ${stderr}`);

    const backup = await backupDataDir(
      { dataDir: source, passphrase: PASSPHRASE, now: new Date("2026-10-29T13:00:00Z") },
      { cipher: identityCipher },
    );
    assert.ok(backup.expectedSeq > 1);
    assert.equal(backup.copiedSeq >= backup.expectedSeq, true);

    const restored = await restoreDataDir(
      { archive: backup.archive, dataDir: target, passphrase: PASSPHRASE },
      { cipher: identityCipher },
    );
    assert.equal(restored.seq, backup.copiedSeq);

    // The restored database still has a running generation task. A provider
    // that now answers is what turns `resume()` into a finished submission.
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("answer-after-restore")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const opened = await openHarness({
      path: dataPaths(target).database,
      models,
      registry: createRegistry(),
    });
    try {
      opened.harness.resume();
      const submission = await opened.harness.submission(submissionId, BACKGROUND_CONTEXT);
      assert.ok(submission, "the restored database must still know the submission");
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      assert.equal(settled.status, "done", "the interrupted generation must finish after resume()");
    } finally {
      await opened.harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
