#!/usr/bin/env node
// `npm start`. Parses arguments, then hands the launch to the launcher module.
// The CLI stays tiny on purpose: everything worth testing lives in src/launcher.

import { fileURLToPath } from "node:url";
import { parseOptions, USAGE } from "../src/launcher/options.ts";
import { createLauncher } from "../src/launcher/main.ts";

const parsed = parseOptions(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`pupkeep: ${parsed.error}\n`);
  console.error(USAGE);
  process.exit(2);
}

const options = parsed.options;
if (options.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const launcher = createLauncher(options, {
  // The server is a separate process on purpose: the launcher can then restart
  // a failed harness without touching the tunnel, and the server's own lock
  // (`server.pid`) survives a launcher crash. Same Node binary, no shell.
  serverEntry: {
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.js", import.meta.url))],
  },
  termux: process.env.PUPKEEP_TERMUX === "1",
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void launcher.stop().then(() => process.exit(0));
  });
}

const result = await launcher.start();
if (!result.ok) {
  process.exit(result.code);
}

const urls = launcher.urls();
if (urls.display) console.error(`pupkeep: serving on ${urls.display}`);
