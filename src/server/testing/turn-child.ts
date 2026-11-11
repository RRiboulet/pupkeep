// Child process for the P5-01 "a kill mid-turn loses nothing" row (§7.4, §15.2).
//
// The parent has already written `config.json` (both caregivers, with a session
// it holds the token for) and started no server. This process starts the real
// app with one extra replay-safe tool, submits a message as the owner over HTTP,
// and lets the scripted model call that tool. The tool commits a real care write
// and then hangs, so the process is killable with the tool *result* uncommitted.
//
// The parent SIGKILLs it once the commit marker appears, reopens the same data
// directory, and asserts one write, one completed turn and the right author. A
// child that failed before the tool ran would prove nothing.

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import { startApp } from "../app.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../http.ts";
import { createLogger } from "../log.ts";
import { KILL_PROBE_TOOL, createKillProbe } from "./kill-probe.ts";

const [dataDir, marker, token] = process.argv.slice(2);
if (dataDir === undefined || marker === undefined || token === undefined) {
  process.stderr.write("usage: turn-child.ts <data-dir> <committed-marker> <session-token>\n");
  process.exit(2);
}

const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] });
faux.setResponses([
  fauxAssistantMessage([fauxToolCall(KILL_PROBE_TOOL, {})], { stopReason: "toolUse" }),
]);
const models = createModels();
models.setProvider(faux.provider);

// The registry must be the same shape the parent reopens with: a task whose tool
// definition is missing is not a rerun, it is a startup failure.
const registry = createRegistry<ToolRegistration>();
registry.install(createKillProbe({ markerPath: marker, hang: true, now: new Date("2026-10-30T08:00:00.000Z") }));

const result = await startApp(
  { dataDir, host: "127.0.0.1", port: 0, models, registry },
  { logger: createLogger({ scope: "turn-child", sink: () => undefined }) },
);
if (!result.ok) {
  process.stderr.write(`the app did not start: ${result.message}\n`);
  process.exit(1);
}

const response = await fetch(`${result.app.url}/api/agent/messages`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
    Cookie: `pupkeep_session=${token}`,
    Origin: result.app.url,
  },
  body: JSON.stringify({ text: "Log a snack", clientMessageId: "msg-kill-turn" }),
});
if (response.status !== 202) {
  process.stderr.write(`the message answered ${response.status}: ${await response.text()}\n`);
  process.exit(1);
}

// Hold the app (and its pid lock) open; the parent kills this process once the
// probe's commit marker lands. The marker is written by the tool, not here: it
// must mean "the care write is committed", not "the message was accepted".
setInterval(() => undefined, 1_000);
