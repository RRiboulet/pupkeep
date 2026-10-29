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
  // A supervisor that gave up must look failed to whatever supervises *it*
  // (termux-services, a boot script, systemd): exiting 0 after the server
  // crash-looped is indistinguishable from a clean stop. The launcher has
  // already stopped its children and released the lock when this runs.
  onFatal: () => process.exit(1),
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
// The server child is spawned, not necessarily bound yet; P1-04 has no
// readiness handshake, so do not claim it is serving.
if (urls.display) console.error(`pupkeep: starting on ${urls.display}`);
