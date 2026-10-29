import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROBE_TOOL,
  PROBE_TOOL_NAME,
  redactDetail,
  runProbe,
  runProbes,
  statusFromError,
  statusFromMessage,
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

// --- the contract pi-ai actually has: failures RESOLVE a message ------------

test("an aborted stopReason is a timeout, not an ok", async () => {
  // pi-ai adapters resolve on abort (`stopReason: "aborted"`); they do not throw.
  // The first version of this probe recorded that as ok — a hung provider was
  // instantly allowed. This test is the regression guard.
  const result = await runProbe(
    target,
    async () => assistant({ stopReason: "aborted", errorMessage: "Request was aborted" }),
    { now: clock() },
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.toolCall, false);
});

test("an error stopReason is classified from its message, so 410 still drops", async () => {
  const deprecated = await runProbe(
    target,
    async () =>
      assistant({
        stopReason: "error",
        errorMessage: '410: {"type":"invalid_model_error","message":"ModelDeprecated: gone"}',
      }),
    { now: clock() },
  );
  assert.equal(deprecated.status, "deprecated");

  const unauthorized = await runProbe(
    target,
    async () => assistant({ stopReason: "error", errorMessage: "HTTP 401 unauthorized" }),
    { now: clock() },
  );
  assert.equal(unauthorized.status, "unauthorized");

  const opaque = await runProbe(
    target,
    async () => assistant({ stopReason: "error", errorMessage: "upstream exploded" }),
    { now: clock() },
  );
  assert.equal(opaque.status, "network");
  assert.match(opaque.detail ?? "", /upstream exploded/);
});

test("statusFromMessage covers every stopReason the adapters emit", () => {
  assert.equal(statusFromMessage(assistant({ stopReason: "stop" })), "ok");
  assert.equal(statusFromMessage(assistant({ stopReason: "toolUse" })), "ok");
  assert.equal(statusFromMessage(assistant({ stopReason: "length" })), "ok");
  assert.equal(statusFromMessage(assistant({ stopReason: "aborted" })), "timeout");
  assert.equal(statusFromMessage(assistant({ stopReason: "error", errorMessage: "" })), "network");
  assert.equal(
    statusFromMessage(assistant({ stopReason: "error", errorMessage: "429 Too Many Requests" })),
    "rate_limited",
  );
});

// --- result shape ----------------------------------------------------------

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

// --- errors that do throw --------------------------------------------------

test("a provider that throws before producing a message is classified", () => {
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

test("text classification needs context, so paths and ids are not codes", () => {
  assert.equal(statusFromError(new Error("410 Gone")), "deprecated");
  assert.equal(statusFromError(new Error("HTTP 429 rate limited")), "rate_limited");
  assert.equal(statusFromError(new Error("status code: 404")), "not_found");
  // What pi-ai actually produces: `${status}: ${body}` from formatProviderError.
  assert.equal(
    statusFromError(new Error('410: {"type":"invalid_model_error","message":"gone"}')),
    "deprecated",
  );
  assert.equal(statusFromError(new Error("404: not found")), "not_found");
  assert.equal(statusFromError(new Error("Error: 401: bad key")), "unauthorized");
  assert.equal(statusFromError(new Error("429: slow down")), "rate_limited");
  // The old regex matched these; a 3-digit number in prose is not an HTTP status.
  assert.equal(statusFromError(new Error("invalid URL path: /v1/401 or /v2/500")), "network");
  assert.equal(statusFromError(new Error("model mimo-v4.1-410 failed")), "network");
  assert.equal(statusFromError(new Error("used 401 tokens")), "network");
});

test("a call that never settles is cut off by the deadline", async () => {
  const started = Date.now();
  const result = await runProbe(target, () => new Promise<never>(() => {}), {
    timeoutMs: 10,
    now: clock(),
  });
  assert.equal(result.status, "timeout");
  assert.equal(result.toolCall, false);
  assert.ok(Date.now() - started < 1_000, "the probe must not wait for a hung call");
});

test("a call that ignores the abort signal still loses the race", async () => {
  // Some adapters never attach the signal; the bound must not depend on them.
  const result = await runProbe(
    target,
    () => new Promise<never>(() => {
      /* deliberately never resolves, never rejects */
    }),
    { timeoutMs: 5 },
  );
  assert.equal(result.status, "timeout");
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

test("one hung target does not hold the whole probe open", async () => {
  const results = await runProbes(
    [
      { provider: "faux", model: "good" },
      { provider: "faux", model: "hung" },
    ],
    async (t) =>
      t.model === "hung" ? new Promise<never>(() => {}) : toolCallMessage(),
    { timeoutMs: 10, concurrency: 2 },
  );
  assert.deepEqual(
    results.map((r) => r.status),
    ["ok", "timeout"],
  );
});

// --- allowlist -------------------------------------------------------------

function result(
  id: string,
  status: ProbeResult["status"],
  toolCall = status === "ok",
  checkedAt = "2026-10-29T00:00:00.000Z",
): ProbeResult {
  return {
    id,
    provider: id.split("/")[0]!,
    model: id.split("/")[1]!,
    status,
    toolCall,
    latencyMs: 1,
    checkedAt,
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

  assert.deepEqual(
    list.allowed.map((entry) => entry.id),
    ["a/ok"],
  );
  assert.deepEqual(
    list.dropped.map((drop) => drop.entry.id),
    ["a/gone", "a/missing", "a/keys"],
  );
  assert.deepEqual(
    list.unverified.map((u) => u.entry.id),
    ["a/busy", "a/flaky", "a/slow"],
  );
  // Unknown with no history is unverified, and the reason says which kind.
  assert.ok(list.unverified.every((u) => u.reason === "inconclusive"));
});

test("reachable is not usable: ok without a tool call will not be allowed", () => {
  const list = resolveAllowlist([], [result("a/chatty", "ok", false)]);
  assert.deepEqual(list.allowed, []);
  assert.equal(list.unverified.length, 1);
  assert.equal(list.unverified[0]!.reason, "tool_call_missing");
});

test("a rate limit keeps the last known good entry, including its tool call", () => {
  const list = resolveAllowlist([result("a/busy", "ok", true)], [result("a/busy", "rate_limited", false)]);
  assert.deepEqual(
    list.allowed.map((entry) => entry.id),
    ["a/busy"],
  );
  assert.equal(list.allowed[0]!.toolCall, true);
  assert.deepEqual(list.unverified, []);
});

test("a drop beats history, and a later ok brings the model back", () => {
  const dropped = resolveAllowlist([result("a/x", "ok")], [result("a/x", "deprecated")]);
  assert.deepEqual(dropped.allowed, []);
  assert.deepEqual(dropped.dropped.map((d) => d.status), ["deprecated"]);

  const revived = resolveAllowlist([result("a/x", "deprecated")], [result("a/x", "ok")]);
  assert.deepEqual(
    revived.allowed.map((entry) => entry.id),
    ["a/x"],
  );
  assert.deepEqual(revived.dropped, []);
});

test("a model missing from the fresh run keeps its cached bucket", () => {
  const list = resolveAllowlist(
    [result("a/old", "ok"), result("a/dead", "deprecated"), result("a/busy", "rate_limited")],
    [result("a/new", "ok")],
  );

  assert.deepEqual(
    list.allowed.map((entry) => entry.id).sort(),
    ["a/new", "a/old"],
  );
  assert.deepEqual(
    list.dropped.map((d) => d.entry.id),
    ["a/dead"],
  );
  // A cached "unknown" is never probed again by this run, and says so.
  assert.deepEqual(
    list.unverified.map((u) => u.entry.id),
    ["a/busy"],
  );
  assert.equal(list.unverified[0]!.reason, "never_probed");
});

test("the cache keeps the timestamp, so the picker can say how old it is", () => {
  const list = resolveAllowlist([], [result("a/ok", "ok", true, "2026-10-01T09:00:00.000Z")]);
  assert.equal(list.allowed[0]!.checkedAt, "2026-10-01T09:00:00.000Z");
});
