import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelProbeCache, toModelProbeCache, PROBE_CACHE_VERSION } from "../src/server/models/cache.ts";
import type { ProbeResult } from "../src/server/models/probe.ts";

// The cache file is written by P1-05 and read by P4-08. It is also the one input
// to the allowlist that can be corrupt: a hand edit, a truncated write, or a file
// from an older build. A bad file must degrade to "no cache", never crash a boot.

function result(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    id: "opencode-go/mimo-v2.6-flash",
    provider: "opencode-go",
    model: "mimo-v2.6-flash",
    status: "ok",
    toolCall: true,
    latencyMs: 850,
    checkedAt: "2026-10-29T10:00:00.000Z",
    usage: { input: 120, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0.002 },
    ...overrides,
  };
}

test("a cache round-trips through JSON", () => {
  const cache = toModelProbeCache([result()], "2026-10-29T10:00:01.000Z");
  const parsed = parseModelProbeCache(JSON.parse(JSON.stringify(cache)));
  assert.deepEqual(parsed, cache);
  assert.equal(parsed!.version, PROBE_CACHE_VERSION);
});

test("a cache keeps the optional detail and drops unknown fields", () => {
  const cache = toModelProbeCache([result({ detail: "429 too many" })], "2026-10-29T10:00:01.000Z");
  const withExtra = { ...cache, nonsense: true, results: [{ ...cache.results[0]!, extra: 1 }] };
  const parsed = parseModelProbeCache(withExtra);
  assert.equal(parsed!.results[0]!.detail, "429 too many");
  assert.equal("extra" in parsed!.results[0]!, false);
});

test("anything this version does not understand is refused, not repaired", () => {
  const good = toModelProbeCache([result()], "2026-10-29T10:00:01.000Z");
  const cases: unknown[] = [
    undefined,
    null,
    "not a cache",
    [],
    {},
    { ...good, version: 2 },
    { ...good, version: "1" },
    { ...good, checkedAt: 12345 },
    { ...good, results: "nope" },
    { ...good, results: [{ ...good.results[0]!, status: "exploded" }] },
    { ...good, results: [{ ...good.results[0]!, toolCall: "yes" }] },
    { ...good, results: [{ ...good.results[0]!, id: "no-slash" }] },
    { ...good, results: [{ ...good.results[0]!, latencyMs: Number.NaN }] },
  ];
  for (const value of cases) {
    assert.equal(parseModelProbeCache(value), undefined, JSON.stringify(value)?.slice(0, 80));
  }
});

test("a half-valid file is refused as a whole, so buckets cannot be built on holes", () => {
  const good = toModelProbeCache([result(), result({ id: "a/b" })], "2026-10-29T10:00:01.000Z");
  const broken = { ...good, results: [good.results[0]!, { ...good.results[1]!, status: "broken" }] };
  assert.equal(parseModelProbeCache(broken), undefined);
});

test("a bad usage block is dropped without losing the result", () => {
  const good = toModelProbeCache([result()], "2026-10-29T10:00:01.000Z");
  const parsed = parseModelProbeCache({
    ...good,
    results: [{ ...good.results[0]!, usage: { input: "many" } }],
  });
  assert.ok(parsed);
  assert.equal(parsed!.results[0]!.usage, undefined);
});
