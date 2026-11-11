// Child process for the P5-01 "kill at a commit boundary" rows (§15.2).
//
// The parent has already written `config.json` and started no server. This
// process starts the real app on that data directory, performs **one** care write
// over HTTP exactly as a browser does, and only then writes the marker. The
// parent SIGKILLs it without a graceful close and reopens the same directory: the
// write must be there exactly once, and the same `Idempotency-Key` must replay
// rather than duplicate (§7.3).
//
// One action per process, because the interesting claim is per boundary: a kill
// after the ack of *that* write. `walk-end` starts a walk first, so the boundary
// under test is the end, not the start.
//
// Usage: commit-child.ts <data-dir> <ready-marker> <session-token> <action>
//        action = feed | walk-start | walk-end | appointment

import { rename, writeFile } from "node:fs/promises";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { startApp } from "../app.ts";
import { createLogger } from "../log.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../http.ts";

const [dataDir, marker, token, action] = process.argv.slice(2);
if (dataDir === undefined || marker === undefined || token === undefined || action === undefined) {
  process.stderr.write("usage: commit-child.ts <data-dir> <ready-marker> <session-token> <action>\n");
  process.exit(2);
}

/** Write-then-rename: the parent polls with `stat().isFile()`. */
async function writeMarker(path: string, text: string): Promise<void> {
  const staged = `${path}.partial`;
  await writeFile(staged, text, { mode: 0o600 });
  await rename(staged, path);
}

const models = createModels();
models.setProvider(fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] }).provider);
const result = await startApp(
  { dataDir, host: "127.0.0.1", port: 0, models },
  { logger: createLogger({ scope: "commit-child", sink: () => undefined }) },
);
if (!result.ok) {
  process.stderr.write(`the app did not start: ${result.message}\n`);
  process.exit(1);
}

const url = result.app.url;
async function post(path: string, key: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      "Idempotency-Key": key,
      Cookie: `pupkeep_session=${token}`,
      Origin: url,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== 200) {
    process.stderr.write(`${path} answered ${response.status}: ${text}\n`);
    process.exit(1);
  }
  return JSON.parse(text) as unknown;
}

let written: unknown;
switch (action) {
  case "feed":
    written = await post("/api/feeding/extra", "http:kill-feed", { amount: "a treat" });
    break;
  case "walk-start":
    written = await post("/api/walks/start", "http:kill-walk-start", {});
    break;
  case "walk-end": {
    const started = (await post("/api/walks/start", "http:kill-walk-start", {})) as { walk: { id: string } };
    written = await post("/api/walks/end", "http:kill-walk-end", { walkId: started.walk.id, pee: 1 });
    break;
  }
  case "appointment":
    written = await post("/api/appointments", "http:kill-appointment", {
      title: "Vet visit",
      localDate: "2026-12-20",
      timeLocal: "09:00",
      durationMin: 30,
    });
    break;
  default:
    process.stderr.write(`unknown action: ${action}\n`);
    process.exit(2);
}

await writeMarker(marker, `${JSON.stringify(written)}\n`);

// Hold the app (and its pid lock) open; the parent kills this process.
setInterval(() => undefined, 1_000);
