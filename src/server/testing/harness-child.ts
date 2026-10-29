// Child process for the SIGKILL test in test/harness.test.ts. It opens the
// same Harness the server uses, commits a session document, drops a ready
// marker, and then *stays alive* so the parent's SIGKILL lands on a process with
// the Harness open (a child that exits first would prove nothing).

import { writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { openHarness } from "../harness.ts";

const [databasePath, markerPath] = process.argv.slice(2);
if (databasePath === undefined || markerPath === undefined) {
  process.stderr.write("usage: harness-child.ts <database> <marker>\n");
  process.exit(2);
}

const PersistDoc = defineDoc({
  kind: "app.test.persist",
  version: 1,
  scope: "session",
  initial: () => ({ markers: [] as string[] }),
  checkpointWhen: () => true,
});

const opened = await openHarness({ path: databasePath });
await opened.harness.commit(async (tx) => {
  const doc = await tx.doc(PersistDoc);
  doc.markers.push("before-kill");
}, BACKGROUND_CONTEXT);
await writeFile(markerPath, "ready\n", { mode: 0o600 });

// Not unref'd: the point is to be killable while the Harness is open.
setInterval(() => undefined, 1_000);
