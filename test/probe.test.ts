import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROBE_TOOL,
  PROBE_TOOL_NAME,
  redactDetail,
  runProbe,
  runProbes,
  statusFromError,
  type ProbeResult,
} from "../src/server/models/probe.ts";
import { resolveAllowlist } from "../src/server/models/allowlist.ts";

// A structurally valid AssistantMessage. Cast once, here, rather than in every
// test: pi-ai brands provider ids and the fake only needs the fields we read.
function assistant(overrides: Record<string, unknown> = {}): never {
  const base = {
    role: "assistant",
    api: "openai-completions",
    provider: "faux",
    model: "fake-1",
    content: [],
    stopReason: "stop",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    },
    ...overrides,
  };
  return base as never;
}

function toolCallMessage(): never {
  return assistant({
    stopReason: "toolUse",
    content: [
      { type: "toolCall", id: "call-1", name: PROBE_TOOL_NAME, arguments: { status: "ok" } },
    ],
  });
}

const target = { provider: "faux", model: "fake-1" };
const clock = () => {
  let t = 1_000;
  return () => (t += 25);
};

test("the probe tool is a literal-only object, which is the app schema shape", () => {
  assert.equal(PROBE_TOOL.name, PROBE_TOOL_NAME);
  const schema = PROBE_TOOL.parameters as { type: string; required?: string[] };
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["status"]);
});

test("a real tool call with status ok is recorded as ok/toolCall", async () => {
  const result = await runProbe(target, async () => toolCallMessage(), { now: clock() });
  assert.equal(result.status, "ok");
  assert.equal(result.toolCall, true);
  assert.equal(result.id, "faux/fake-1");
  assert.equal(result.usage?.cost, 0.001);
  assert.equal(result.latencyMs, 25);
});

test("a text-only answer is ok but not a tool call", async () => {
  const result = await runProbe(
    target,
    async () => assistant({ content: [{ type: "text", text: "ok" }] }),
    { now: clock() },
  );
  assert.equal(result.status, "ok");
  assert.equal(result.toolCall, false);
});

test("tool calls to another tool or with another argument do not count", async () => {
  const wrongTool = await runProbe(
    target,
    async () =>
      assistant({
        content: [{ type: "toolCall", id: "c", name: "something_else", arguments: { status: "ok" } }],
      }),
    { now: clock() },
  );
  const wrongArg = await runProbe(
    target,
    async () =>
      assistant({
        content: [{ type: "toolCall", id: "c", name: PROBE_TOOL_NAME, arguments: { status: "no" } }],
      }),
    { now: clock() },
  );
  assert.equal(wrongTool.toolCall, false);
  assert.equal(wrongArg.toolCall, false);
});

test("a provider error embedded in the message is not an ok", async () => {
  const result = await runProbe(
    target,
    async () => assistant({ stopReason: "error", errorMessage: "upstream exploded" }),
    { now: clock() },
  );
  assert.equal(result.status, "network");
  assert.equal(result.toolCall, false);
  assert.match(result.detail ?? "", /upstream exploded/);
});

test("HTTP failures map to the statuses that decide drops", () => {
  for (const [error, expected] of [
    [{ status: 410, message: "410 ModelDeprecated" }, "deprecated"],
    [{ status: 404, message: "not found" }, "not_found"],
    [{ status: 401, message: "unauthorized" }, "unauthorized"],
    [{ status: 403, message: "forbidden" }, "unauthorized"],
    [{ status: 429, message: "too many" }, "rate_limited"],
    [{ status: 503, message: "upstream" }, "network"],
    [{ message: "boom" }, "network"],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), "timeout"],
    [new Error("connect ECONNREFUSED"), "network"],
  ] as const) {
    assert.equal(statusFromError(error), expected, String((error as { message?: string }).message));
  }
});

test("a status in the message text is still recognised", () => {
  // Some adapters only surface a string; this is the fallback path.
  assert.equal(statusFromError(new Error("Error: 410 ModelDeprecated")), "deprecated");
  assert.equal(statusFromError(new Error("HTTP 429 rate limited")), "rate_limited");
});

test("a hung provider times out instead of holding startup open", async () => {
  const result = await runProbe(
    target,
    (_target, _context, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    { timeoutMs: 5, now: clock() },
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.toolCall, false);
});

test("detail is redacted before it can reach a log or the UI", () => {
  const detail = redactDetail(
    "failed: Authorization sk-abcdefghijklmnop1234 https://x.example/v1?key=SUPERSECRET&model=a " +
      "token ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  );
  assert.doesNotMatch(detail, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(detail, /SUPERSECRET/);
  assert.doesNotMatch(detail, /[A-Za-z0-9]{32,}/);
  assert.ok(detail.length <= 200);
});

test("runProbes keeps input order, bounds concurrency and probes every target", async () => {
  const targets = Array.from({ length: 6 }, (_, i) => ({ provider: "faux", model: `m${i}` }));
  let inFlight = 0;
  let peak = 0;

  const results = await runProbes(
    targets,
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return toolCallMessage();
    },
    { concurrency: 2 },
  );

  assert.deepEqual(
    results.map((result) => result.model),
    targets.map((t) => t.model),
  );
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
  assert.equal(results.filter((r) => r.status === "ok").length, 6);
});

// --- allowlist -------------------------------------------------------------

function result(id: string, status: ProbeResult["status"]): ProbeResult {
  return {
    id,
    provider: id.split("/")[0]!,
    model: id.split("/")[1]!,
    status,
    toolCall: status === "ok",
    latencyMs: 1,
    checkedAt: "2026-10-29T00:00:00.000Z",
  };
}

test("only deprecated, not_found and unauthorized drop a model", () => {
  const fresh = [
    result("a/ok", "ok"),
    result("a/gone", "deprecated"),
    result("a/missing", "not_found"),
    result("a/keys", "unauthorized"),
    result("a/busy", "rate_limited"),
    result("a/flaky", "network"),
    result("a/slow", "timeout"),
  ];
  const list = resolveAllowlist([], fresh);

  assert.deepEqual(list.allowed, ["a/ok"]);
  assert.deepEqual(
    list.dropped.map((d) => d.id),
    ["a/gone", "a/missing", "a/keys"],
  );
  // Unknown with no history: kept, but flagged rather than silently trusted.
  assert.deepEqual(list.unverified, ["a/busy", "a/flaky", "a/slow"]);
});

test("a rate limit keeps the last known good entry", () => {
  const list = resolveAllowlist([result("a/busy", "ok")], [result("a/busy", "rate_limited")]);
  assert.deepEqual(list.allowed, ["a/busy"]);
  assert.deepEqual(list.unverified, []);
});

test("a drop beats history, and a later ok brings the model back", () => {
  const dropped = resolveAllowlist([result("a/x", "ok")], [result("a/x", "deprecated")]);
  assert.deepEqual(dropped.allowed, []);
  assert.deepEqual(dropped.dropped, [{ id: "a/x", status: "deprecated" }]);

  const revived = resolveAllowlist([result("a/x", "deprecated")], [result("a/x", "ok")]);
  assert.deepEqual(revived.allowed, ["a/x"]);
  assert.deepEqual(revived.dropped, []);
});

test("a model missing from the fresh run is not resurrected or dropped", () => {
  // The probe covers the current candidate list; history for others is untouched.
  const list = resolveAllowlist([result("a/old", "ok")], [result("a/new", "ok")]);
  assert.deepEqual(list.allowed, ["a/new"]);
  assert.deepEqual(list.dropped, []);
});
