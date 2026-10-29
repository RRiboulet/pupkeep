import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { announceOwnerLink, redactLink } from "../src/launcher/owner.ts";

const LINK = "http://127.0.0.1:8787/login?token=SECRET-OWNER-TOKEN";

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pupkeep-owner-"));
}

test("a minted link is written 0600 and printed when interactive", async () => {
  const path = join(await dir(), "owner-link.txt");
  const printed: string[] = [];
  const result = await announceOwnerLink({
    link: LINK,
    path,
    interactive: true,
    writeFile: true,
    writeOut: (text) => printed.push(text),
    log: () => {},
  });

  assert.deepEqual(result, { written: true, printed: true });
  assert.equal(await readFile(path, "utf8"), `${LINK}\n`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(printed.join(""), /SECRET-OWNER-TOKEN/);
});

test("a pre-existing loose file is tightened, not left world-readable", async () => {
  // `writeFile(..., {mode})` only applies at creation. This is the reissue path:
  // an old 0644 file must not survive while the log claims 0600.
  const path = join(await dir(), "owner-link.txt");
  await writeFile(path, "old\n", "utf8");
  const { chmod } = await import("node:fs/promises");
  await chmod(path, 0o644);

  await announceOwnerLink({ link: LINK, path, interactive: false, writeFile: true, log: () => {} });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("boot mode never prints the token and logs only the path", async () => {
  const path = join(await dir(), "owner-link.txt");
  const printed: string[] = [];
  const logged: string[] = [];

  await announceOwnerLink({
    link: LINK,
    path,
    interactive: false,
    writeFile: true,
    writeOut: (text) => printed.push(text),
    log: (line) => logged.push(line),
  });

  assert.deepEqual(printed, []);
  const log = logged.join("\n");
  assert.match(log, /owner link written to .*owner-link\.txt/);
  assert.doesNotMatch(log, /SECRET-OWNER-TOKEN/);
});

test("a link that is announced without being written still hides its token", async () => {
  const logged: string[] = [];
  await announceOwnerLink({
    link: LINK,
    path: "/tmp/never-written",
    interactive: false,
    writeFile: false,
    log: (line) => logged.push(line),
  });
  assert.match(logged.join("\n"), /owner link/);
  assert.doesNotMatch(logged.join("\n"), /SECRET-OWNER-TOKEN/);
});

test("redaction assumes nothing about the link shape P1-06 will pick", () => {
  // The shape is not decided yet, so every plausible carrier is stripped.
  const cases = [
    "https://x.test/login?token=S",
    "https://x.test/login?TOKEN=S",
    "https://x.test/login?invite=S",
    "https://x.test/login?access_code=S",
    "https://x.test/login#token=S",
    "https://x.test/login/S1234567890abcdef",
    "https://x.test/login/S1234567890abcdef/today",
  ];
  for (const link of cases) {
    const redacted = redactLink(link);
    assert.doesNotMatch(redacted, /S1234567890abcdef|=[A-Za-z0-9_-]+/, `${link} → ${redacted}`);
    // The origin is still recognisable, which is the point of logging it.
    assert.match(redacted, /^https:\/\/x\.test\/login/);
  }
});
