// Child process for the P2-08 "a walk survives a kill" gate.
//
// The parent has already written `config.json` (both caregivers, with sessions
// it holds the tokens for) and started no server. This process starts the real
// app on that data directory, starts a walk over HTTP exactly as a browser does,
// and only then writes the marker the parent waits for. The parent SIGKILLs it
// without a graceful close, and a fresh app on the same directory must still have
// the open walk — the §15.2 "kill after an HTTP ack" case, including the
// launcher's pid lock and the harness's own `resume()` on start.
//
// Usage: walk-child.ts <data-dir> <ready-marker> <session-token>

import { rename, writeFile } from "node:fs/promises";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { startApp } from "../app.ts";
import { createLogger } from "../log.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../http.ts";

const [dataDir, marker, token] = process.argv.slice(2);
if (dataDir === undefined || marker === undefined || token === undefined) {
  process.stderr.write("usage: walk-child.ts <data-dir> <ready-marker> <session-token>\n");
  process.exit(2);
}

/**
 * Write-then-rename: the parent polls for the marker with `stat().isFile()`, so a
 * plain write would let it read a half-written file. Renaming into place means
 * the marker is either absent or complete.
 */
async function writeMarker(path: string, text: string): Promise<void> {
  const staged = `${path}.partial`;
  await writeFile(staged, text, { mode: 0o600 });
  await rename(staged, path);
}

const models = createModels();
models.setProvider(fauxProvider().provider);
const result = await startApp(
  { dataDir, host: "127.0.0.1", port: 0, models },
  { logger: createLogger({ scope: "walk-child", sink: () => undefined }) },
);
if (!result.ok) {
  process.stderr.write(`the app did not start: ${result.message}\n`);
  process.exit(1);
}

const response = await fetch(`${result.app.url}/api/walks/start`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
    "Idempotency-Key": "http:start-kill",
    Cookie: `pupkeep_session=${token}`,
    Origin: result.app.url,
  },
  body: "{}",
});
if (response.status !== 200) {
  process.stderr.write(`the walk start answered ${response.status}: ${await response.text()}\n`);
  process.exit(1);
}
const body = (await response.json()) as { walk: { id: string } };
await writeMarker(marker, `${body.walk.id}\n`);

// Hold the app (and its pid lock) open; the parent kills this process.
setInterval(() => undefined, 1_000);
