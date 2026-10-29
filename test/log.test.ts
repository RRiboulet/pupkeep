import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLogger } from "../src/server/log.ts";
import { scrub, redactDetail, redactValue } from "../src/shared/redact.ts";

// PLAN §6.3: the owner link, invite codes, cookies and provider keys must never
// reach `server.log`. On the phone the launcher redirects stdout/stderr there, so
// the logger is the last choke point.

// Each secret is the *sensitive part*: the origin of a URL may stay in a log —
// that is what makes the line useful — but the token in it may not.
const SECRETS: Record<string, { text: string; sensitive: string }> = {
  ownerLink: {
    text: "http://100.90.202.61:8787/login?token=OWNER-TOKEN-9f8e7d6c5b4a3210",
    sensitive: "OWNER-TOKEN-9f8e7d6c5b4a3210",
  },
  invite: { text: "INV1TE-c0de-4f3a-9b21-8d7e6f5a4b3c", sensitive: "INV1TE-c0de-4f3a-9b21-8d7e6f5a4b3c" },
  cookie: { text: "session=abc123def456ghi789jkl012mno345pqr", sensitive: "abc123def456ghi789jkl012mno345pqr" },
  providerKey: {
    text: "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    sensitive: "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
  },
  bearer: {
    text: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    sensitive: "eyJhbGciOiJIUzI1NiJ9.payload.signature",
  },
  ntfyTopic: { text: "QUy9P9Hw4c2MH_NRGZFasFv8U34hBxHu", sensitive: "QUy9P9Hw4c2MH_NRGZFasFv8U34hBxHu" },
  vapidPrivate: {
    text: "f8s7d6f5g4h3j2k1l0q9w8e7r6t5y4u3i2o1p0a9s8d7f6g5h4j3k2l1",
    sensitive: "f8s7d6f5g4h3j2k1l0q9w8e7r6t5y4u3i2o1p0a9s8d7f6g5h4j3k2l1",
  },
};

async function capture(log: (logger: ReturnType<typeof createLogger>) => void): Promise<string> {
  const lines: string[] = [];
  const logger = createLogger({
    sink: (line) => lines.push(line),
    level: "debug",
    now: () => new Date("2026-10-29T12:00:00.000Z"),
    scope: "test",
  });
  log(logger);
  return lines.join("\n");
}

test("no secret shape survives the scrubber", () => {
  for (const [name, { text, sensitive }] of Object.entries(SECRETS)) {
    const scrubbed = scrub(`failed with ${text} at 12:00`);
    assert.ok(!scrubbed.includes(sensitive), `${name} leaked: ${scrubbed}`);
  }
});

test("redaction is by shape, not by parameter name", () => {
  for (const link of [
    "https://x.test/login?token=SECRETSECRETSECRET",
    "https://x.test/login#token=SECRETSECRETSECRET",
    "https://x.test/login/SECRETSECRETSECRET",
    "https://x.test/login?access_code=SECRETSECRETSECRET",
    "https://x.test/login?oauth_token=SECRETSECRETSECRET",
    "https://x.test/invite/SECRETSECRETSECRET",
  ]) {
    assert.ok(!scrub(link).includes("SECRETSECRETSECRET"), `${link} → ${scrub(link)}`);
  }
});

test("a URL keeps its origin, which is the part that helps debugging", () => {
  assert.match(scrub("GET http://100.90.202.61:8787/today?token=abc123456789012345678"), /^GET http:\/\/100\.90\.202\.61:8787\/today/);
});

test("the logger scrubs the message, the fields and the scope", async () => {
  const output = await capture((log) => {
    log.error(`owner link ${SECRETS.ownerLink!.text}`, {
      cookie: SECRETS.cookie!.text,
      authorization: SECRETS.bearer!.text,
      provider: SECRETS.providerKey!.text,
    });
  });

  for (const [name, { sensitive }] of Object.entries(SECRETS)) {
    assert.ok(!output.includes(sensitive), `${name} leaked: ${output}`);
  }
  assert.match(output, /ERROR \[test\]/);
});

test("a real log file contains no secret after a full write cycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-log-"));
  const path = join(dir, "server.log");
  const { appendFile } = await import("node:fs/promises");
  const logger = createLogger({
    sink: (line) => void appendFile(path, `${line}\n`, "utf8"),
    level: "debug",
  });

  logger.info("minted the owner link", { link: SECRETS.ownerLink!.text });
  logger.warn("invite created", { code: SECRETS.invite!.text });
  logger.error("provider rejected the key", { key: SECRETS.providerKey!.text, bearer: SECRETS.bearer!.text });
  logger.debug("ntfy topic stored", { topic: SECRETS.ntfyTopic!.text });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const content = await readFile(path, "utf8");
  for (const [name, { sensitive }] of Object.entries(SECRETS)) {
    assert.ok(!content.includes(sensitive), `${name} reached server.log:\n${content}`);
  }
});

test("levels filter, and a child keeps the parent scope", async () => {
  const output = await capture((log) => {
    const warnOnly = createLogger({
      sink: () => {},
      level: "warn",
      scope: "quiet",
    });
    warnOnly.info("not shown");
    log.info("parent");
    log.child("child").warn("nested");
  });
  assert.match(output, /INFO \[test\] parent/);
  assert.match(output, /WARN \[test:child\] nested/);
  assert.doesNotMatch(output, /not shown/);
});

test("redactDetail bounds and scrubs; redactValue never echoes the secret", () => {
  const detail = redactDetail(`Authorization sk-abcdefghijklmnop1234 ${"x".repeat(500)}`);
  assert.ok(detail.length <= 200);
  assert.doesNotMatch(detail, /sk-abcdefghijklmnop/);

  const value = redactValue("SUPERSECRETSECRETSECRET");
  assert.doesNotMatch(value, /SUPERSECRET/);
  assert.match(value, /redacted \d+ chars/);
});

test("the 22-character Web Push auth secret does not survive", () => {
  // A 16-byte key is exactly 22 base64url chars: below any sane length floor, and
  // it is the whole AES-GCM key for a subscription.
  const auth = "ibq4DWfzHRPqc-qjFAtadA";
  assert.ok(!scrub(`subscription={"keys":{"auth":"${auth}"}}`).includes(auth));
  assert.ok(!scrub(`auth=${auth}`).includes(auth));
  assert.ok(!redactDetail(`push failed {"keys":{"auth":"${auth}"}}`).includes(auth));
});

test("a short invite code and a signed-URL signature are redacted by name", () => {
  assert.ok(!scrub("invite created code=ABC123").includes("ABC123"));
  assert.ok(!scrub("https://x.test/c?X-Amz-Signature=Zx987bad").includes("Zx987bad"));
  assert.ok(!scrub("x-api-key: short23chars").includes("short23chars"));
});

test("standard base64 is redacted whole, not just its leading run", () => {
  const value = "AAAAAAAAAAAAAAAAAAAA/BBBB";
  assert.ok(!scrub(`vapid ${value}`).includes("/BBBB"));
});

test("correlation ids survive when the caller says they are ids", () => {
  const ulid = "01J8ZP4M7Q9XBR2W3Y4Z5A6B7C";
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line), level: "debug" });
  logger.info("busy reject", { requestId: ulid, memberId: ulid });
  assert.match(lines.join(""), new RegExp(ulid), "a request id is what makes the line useful");
});

test("an Error field keeps its message and stack, and a newline cannot forge a line", () => {
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line), level: "debug" });
  logger.error("turn failed", { error: new Error("provider exploded"), note: "a\n2026-01-01 INFO forged" });
  const output = lines.join("\n");
  assert.match(output, /provider exploded/);
  assert.equal(lines.length, 1, "one event must be one line");
  assert.match(output, /a\\n2026-01-01 INFO forged/);
});
