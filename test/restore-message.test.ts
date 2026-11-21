// scripts/restore.ts used to tell the operator to "run --reissue-owner" after a
// restore. That is the launcher's flag (bin/pupkeep.js, i.e. `npm start`), and
// restore's own parseArgs rejects it as an unknown option — so following the
// advice literally failed. The message must name the launcher, and this file
// also pins the trap itself so the flag never creeps back into restore's CLI.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRestoreArgs, restoreReport, USAGE } from "../scripts/restore.ts";
import type { RestoreResult } from "../src/server/backup.ts";

const ARCHIVE = "/data/backups/pupkeep-2026-11-20T033000Z.tar.gz.age";

function restored(overrides: Partial<RestoreResult> = {}): RestoreResult {
  return {
    restored: ["config.json", "pupkeep.sqlite"],
    seq: 412,
    secretsPresent: false,
    requiresOwnerMint: true,
    ...overrides,
  };
}

/** Lines that hand the operator --reissue-owner without saying who owns it. */
function orphanedFlags(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.includes("--reissue-owner"))
    .filter((line) => !line.includes("npm start") && !line.includes("bin/pupkeep.js"));
}

test("the restored-household message names the launcher, never a bare --reissue-owner", () => {
  const text = restoreReport(restored(), ARCHIVE).join("\n");

  // Copy-pasteable: the npm path, and the file the container's entrypoint runs.
  assert.match(text, /npm start -- --reissue-owner/);
  assert.match(text, /bin\/pupkeep\.js/);
  assert.deepEqual(orphanedFlags(text), [], "every --reissue-owner mention names the launcher");

  // The old text's exact trap: "run --reissue-owner", which restore rejects.
  assert.doesNotMatch(text, /(^|\s)run --reissue-owner/);

  // Why a fresh link is needed stays in the message, and so do the other facts.
  assert.match(text, /carries no owner token, session or invite/);
  assert.match(text, /nobody can sign in until a fresh owner token is minted/);
  assert.match(text, /secrets\.json is absent .*re-enter the provider keys/);
  assert.match(text, /restored config\.json, pupkeep\.sqlite from .*durable seq 412/);
});

test("a restore that still has an owner does not mention minting at all", () => {
  const text = restoreReport(
    restored({ requiresOwnerMint: false, secretsPresent: true }),
    ARCHIVE,
  ).join("\n");
  assert.doesNotMatch(text, /--reissue-owner|owner token/);
  assert.match(text, /secrets\.json was left in place/);
});

test("restore --help names the launcher too, and says the flag is not its own", () => {
  assert.deepEqual(orphanedFlags(USAGE), []);
  assert.match(USAGE, /npm start -- --reissue-owner/);
  assert.match(USAGE, /This script has no such flag\./);
  // Never presented as a restore option (the launcher's own help lists it).
  assert.doesNotMatch(USAGE, /^\s*--reissue-owner/m);
});

test("restore's own parser still rejects --reissue-owner: the trap the message must not point at", () => {
  // Documenting the failure rather than pretending it is gone: if a future
  // change teaches restore the flag, this test fails and the message can be
  // rewritten around the real command instead.
  assert.throws(
    () => parseRestoreArgs(["--reissue-owner"], "/home/owner"),
    /Unknown option '--reissue-owner'/,
  );
});
