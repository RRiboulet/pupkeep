import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

// Regression guard for a mistake that already cost a review run: declaring the
// shared `my-agent-setup` package in this repo's `.pi/settings.json`. When pupkeep
// sits inside a workspace that already loads those extensions, the second
// declaration makes every extension load twice, and any pi process started here —
// including a subagent — dies at startup on a duplicate flag.
//
// The file may exist for other settings; it just must not re-declare the package.
// A standalone clone adds it to its own local settings, not to the repo.

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
