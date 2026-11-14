import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

// Regression guard for a mistake that already cost a review run: declaring the
// shared `my-agent-setup` package in this repo's `.pi/settings.json`. The
// devcontainer now gets that package from the image and declares it in the
// container's own agent settings (postCreate.sh); a second project declaration
// would load every extension twice, and any pi process started here — including
// a subagent — dies at startup on a duplicate flag.
//
// The file may exist for other settings; it just must not re-declare the package.

const SETTINGS = join(import.meta.dirname, "..", ".pi", "settings.json");
const PACKAGE_MARKER = "my-agent-setup";

async function readSettings(): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(SETTINGS, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

test(".pi/settings.json either does not exist or does not declare my-agent-setup", async () => {
  const settings = await readSettings();
  if (settings === undefined) return;

  assert.equal(typeof settings, "object");
  const packages = (settings as { packages?: unknown }).packages;
  if (packages === undefined) return;

  assert.ok(Array.isArray(packages), "packages must be an array");
  for (const entry of packages) {
    assert.equal(typeof entry, "string", "package entries are source strings");
    assert.ok(
      !entry.includes(PACKAGE_MARKER),
      `declaring ${PACKAGE_MARKER} here duplicates the enclosing workspace's extensions ` +
        `and breaks subagent startup — install it locally instead (see README)`,
    );
  }
});
