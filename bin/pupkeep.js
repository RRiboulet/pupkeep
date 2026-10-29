#!/usr/bin/env node
// `npm start`. Parses arguments, then hands the launch to the launcher module.
// The CLI stays tiny on purpose: everything worth testing lives in src/launcher.

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

if (options.reissueOwner) {
  // The token belongs to P1-06's auth module; until it exists, say so instead of
  // pretending to rotate anything.
  console.error("pupkeep: --reissue-owner needs the auth module (P1-06); nothing was rotated.");
  process.exit(4);
}

const launcher = createLauncher(options, {
  // The server program arrives with P1-07. Until then this is undefined and the
  // launcher reports it rather than crash-looping on a missing file.
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
