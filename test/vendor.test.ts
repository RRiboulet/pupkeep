import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

// The vendored browser files are committed, not installed. Their pin lives in
// NOTICE.md; this test is what makes the pin real. Without it, "pinned versions
// and checksums" is a sentence in a document.

const VENDOR_DIR = join(import.meta.dirname, "..", "web", "vendor");
const NOTICE = join(import.meta.dirname, "..", "NOTICE.md");

interface Entry {
  file: string;
  packageName: string;
  version: string;
  sha256: string;
}

async function readNotice(): Promise<Entry[]> {
  const text = await readFile(NOTICE, "utf8");
  const entries: Entry[] = [];
  const row =
    /^\|\s*`web\/vendor\/([^`]+)`\s*\|\s*`([^`]+)`[^|]*\|\s*`([0-9][^`]*)`\s*\|\s*`([0-9a-f]{64})`\s*\|\s*$/;
  for (const line of text.split("\n")) {
    const match = row.exec(line);
    if (match) {
      entries.push({ file: match[1]!, packageName: match[2]!, version: match[3]!, sha256: match[4]! });
    }
  }
  return entries;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("every vendored file is listed in NOTICE.md with a version and a checksum", async () => {
  const entries = await readNotice();
  const files = (await readdir(VENDOR_DIR)).filter((name) => name.endsWith(".mjs")).sort();

  assert.ok(files.length > 0, "no vendored files found");
  assert.deepEqual(
    files,
    entries.map((entry) => entry.file).sort(),
    "web/vendor and the NOTICE.md table disagree about which files are vendored",
  );
  for (const entry of entries) {
    assert.match(entry.version, /^\d+\.\d+\.\d+$/, `${entry.file} has no exact version`);
  }
});

test("the checksum of each vendored file matches NOTICE.md", async () => {
  for (const entry of await readNotice()) {
    const bytes = await readFile(join(VENDOR_DIR, entry.file));
    assert.equal(
      sha256(bytes),
      entry.sha256,
      `${entry.file} changed without its NOTICE.md checksum — update both deliberately`,
    );
  }
});

test("vendored files are pure ES modules, not bundles with bare imports left unresolved", async () => {
  for (const entry of await readNotice()) {
    const text = await readFile(join(VENDOR_DIR, entry.file), "utf8");
    assert.doesNotMatch(text, /\brequire\s*\(/, `${entry.file} must stay ESM`);
  }
});
