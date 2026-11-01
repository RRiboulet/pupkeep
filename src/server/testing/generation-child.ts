// Child process for the interrupted-generation restore test. The faux provider
// stalls forever, which leaves a `pi.generation` task committed and running; the
// parent kills this process, backs up the database, restores it elsewhere, and
// resumes the generation there. A child that failed before the provider call
// would not prove that the *running* task state survived.

import { rename, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { openHarness } from "../harness.ts";

const [databasePath, submissionMarker, calledMarker] = process.argv.slice(2);
if (databasePath === undefined || submissionMarker === undefined || calledMarker === undefined) {
  process.stderr.write("usage: generation-child.ts <database> <submission-marker> <called-marker>\n");
  process.exit(2);
}

/**
 * Write-then-rename. The parent polls for these markers with `stat().isFile()`,
 * so a plain `writeFile` is a race: it creates the path with O_TRUNC before the
 * bytes land, the poller sees an empty file, and it reads "" instead of an id.
 * Renaming into place means a marker is either absent or complete.
 */
async function writeMarker(path: string, text: string): Promise<void> {
  const staged = `${path}.partial`;
  await writeFile(staged, text, { mode: 0o600 });
  await rename(staged, path);
}

const faux = fauxProvider();
faux.setResponses([
  () => {
    void writeMarker(calledMarker, "called\n");
    // The generation phase is already committed; staying here is what makes it
    // an interrupted generation rather than a completed one.
    return new Promise(() => undefined);
  },
]);

const models = createModels();
models.setProvider(faux.provider);
const opened = await openHarness({
  path: databasePath,
  models,
  registry: createRegistry(),
});

const root = await opened.harness.root(BACKGROUND_CONTEXT, {
  agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
});
const submission = await root.submit(
  { type: "input", content: "a question that was still running", requestId: "generation-restore-1" },
  BACKGROUND_CONTEXT,
);
await writeMarker(submissionMarker, `${submission.id}\n`);

// Hold the process open with the Harness still owning the database, so SIGKILL
// lands on a live generation.
setInterval(() => undefined, 1_000);
