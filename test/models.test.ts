// P4-08: the provider catalog, its credentials and the allowlist probe (PLAN
// §11.1, §11.2, §14.3, §16 P4-08).
//
// What is pinned here:
//   * **keys come from `secrets.json` and nowhere else**: the `CredentialStore`
//     over the JSON file resolves a stored key, an ambient environment variable
//     is never consulted (the `AuthContext` is deliberately empty), and clearing
//     the key leaves the provider unconfigured;
//   * the catalog is catalog-first: model ids and prices are answerable without a
//     credential, so Settings can say "no key yet" instead of showing nothing;
//   * the probe runs only on providers that have a key (a missing key is not a
//     verdict, and `unauthorized` is a dropping status), probes §11.2's live
//     candidates, records a real tool call, merges over the cached history, and
//     never lets an older run overwrite a newer cache.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { JsonFileStore } from "../src/server/json-file.ts";
import { emptySecrets, parseSecrets, type SecretsConfig } from "../src/server/config.ts";
import {
  createAppModels,
  createSecretCredentials,
  isProviderId,
  providersWithKeys,
  PROVIDERS,
} from "../src/server/models/collection.ts";
import {
  PROBE_CANDIDATES,
  allowlistOf,
  probeAndCache,
  probeModels,
} from "../src/server/models/probe-run.ts";
import { toModelProbeCache, type ModelProbeCache } from "../src/server/models/cache.ts";
import type { ProbeResult } from "../src/server/models/probe.ts";
import { PROBE_CACHE_VERSION } from "../src/server/models/cache.ts";

const TMP_PREFIX = "pupkeep-models-";

async function withSecrets(
  run: (secrets: JsonFileStore<SecretsConfig>, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), TMP_PREFIX));
  const secrets = new JsonFileStore<SecretsConfig>({
    path: join(dir, "secrets.json"),
    parse: parseSecrets,
    initial: emptySecrets,
    mode: 0o600,
  });
  try {
    await secrets.ensure();
    await run(secrets, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A scripted catalog that answers every probe with a real tool call. The faux
 * provider shifts one queued response per call, so the queue covers the whole
 * candidate list.
 */
function okFauxProvider(count = 8) {
  // Every OpenCode Go candidate is in the scripted catalog, so a probe of them
  // is a real tool call rather than the probe's `not_found` path.
  const models = PROBE_CANDIDATES.filter((target) => target.provider === "opencode-go").map((target) => ({
    id: target.model,
  }));
  const faux = fauxProvider({ provider: "opencode-go", models: models as never });
  faux.setResponses(
    Array.from({ length: count }, () => () =>
      fauxAssistantMessage([fauxToolCall("pupkeep_probe", { status: "ok" })], { stopReason: "toolUse" }),
    ),
  );
  return faux;
}

function cacheFile(dir: string): JsonFileStore<ModelProbeCache> {
  return new JsonFileStore<ModelProbeCache>({
    path: join(dir, "models.json"),
    parse: (raw) => raw as ModelProbeCache,
    initial: () => ({ version: PROBE_CACHE_VERSION, checkedAt: new Date(0).toISOString(), results: [] }),
    mode: 0o600,
  });
}

// --- credentials ------------------------------------------------------------

test("the credential store reads and writes secrets.json, and only that", async () => {
  await withSecrets(async (secrets) => {
    const store = createSecretCredentials(secrets);
    assert.equal(await store.read("opencode-go"), undefined, "no key stored: unconfigured");
    assert.deepEqual(await store.list(), []);

    await store.modify("opencode-go", async () => ({ type: "api_key", key: "sk-household-1" }));
    assert.deepEqual(await store.read("opencode-go"), { type: "api_key", key: "sk-household-1" });
    assert.deepEqual(await store.list(), [{ providerId: "opencode-go", type: "api_key" }]);
    assert.equal((await secrets.read()).providerKeys["opencode-go"], "sk-household-1");

    // `modify` returning undefined leaves the entry unchanged.
    await store.modify("opencode-go", async (current) => current);
    assert.equal((await secrets.read()).providerKeys["opencode-go"], "sk-household-1");

    await store.delete("opencode-go");
    assert.equal(await store.read("opencode-go"), undefined);
    assert.deepEqual((await secrets.read()).providerKeys, {});
  });
});

test("the catalog resolves a stored key and never falls back to the environment", async () => {
  await withSecrets(async (secrets) => {
    const app = await createAppModels(secrets);
    // The catalog answers without a credential…
    const model = app.models.getModel("opencode-go", "mimo-v2.6-flash");
    assert.ok(model, "the built-in catalog is registered");
    assert.deepEqual(app.configured, new Set(), "no key: nothing is configured");
    // …but auth does not.
    assert.equal(await app.models.getAuth("opencode-go"), undefined);

    // A stray environment key must not become the household's credential: the
    // app's AuthContext resolves no environment at all.
    const previous = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "sk-from-the-shell";
    try {
      assert.equal(await app.models.getAuth("opencode-go"), undefined, "the environment is not a credential source");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previous;
    }

    await secrets.update((config) => ({
      ...config,
      providerKeys: { "opencode-go": "sk-household-1" },
    }));
    const auth = await app.models.getAuth("opencode-go");
    assert.equal(auth?.auth.apiKey, "sk-household-1", "the stored key wins");
    const configured = await createAppModels(secrets);
    assert.deepEqual(configured.configured, new Set(["opencode-go"]));
  });
});

test("the providers this build registers are the plan's two", () => {
  assert.deepEqual([...PROVIDERS], ["opencode-go", "openrouter"]);
  assert.equal(isProviderId("opencode-go"), true);
  assert.equal(isProviderId("openrouter"), true);
  assert.equal(isProviderId("anthropic"), false);
});

// --- the probe --------------------------------------------------------------

test("the probe skips providers without a key instead of dropping their models", async () => {
  const faux = okFauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const run = await probeModels({
    models,
    configured: new Set(["opencode-go"]),
    now: () => Date.parse("2026-10-29T12:00:00.000Z"),
  });
  assert.equal(run.providers.length, 1);
  assert.equal(run.providers[0], "opencode-go");
  assert.equal(
    run.results.length,
    PROBE_CANDIDATES.filter((target) => target.provider === "opencode-go").length,
    "every OpenCode Go candidate was probed",
  );
  assert.deepEqual(
    run.skipped.filter((target) => target.provider === "openrouter").map((target) => `${target.provider}/${target.model}`),
    ["openrouter/openrouter/free"],
    "the keyless provider is skipped, not marked unauthorized",
  );
  assert.ok(run.results.every((result) => result.toolCall), "the scripted catalog makes the tool call");
  assert.equal(run.checkedAt, "2026-10-29T12:00:00.000Z");
  assert.deepEqual(
    run.allowlist.allowed.map((entry) => entry.id).sort(),
    run.results.map((result) => result.id).sort(),
    "the allowlist is the probe's own answer",
  );
});

test("with no configured provider the probe runs nothing and keeps the cached allowlist", async () => {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const previous: ProbeResult[] = [
    {
      id: "opencode-go/mimo-v2.6-flash",
      provider: "opencode-go",
      model: "mimo-v2.6-flash",
      status: "ok",
      toolCall: true,
      latencyMs: 12,
      checkedAt: "2026-10-01T00:00:00.000Z",
    },
  ];
  const run = await probeModels({ models, configured: new Set(), previous });
  assert.deepEqual(run.results, [], "no key, no call");
  assert.equal(run.providers.length, 0);
  assert.deepEqual(
    run.allowlist.allowed.map((entry) => entry.id),
    ["opencode-go/mimo-v2.6-flash"],
    "the last-known-good model survives",
  );
});

test("a merge over the cache keeps a working model through an inconclusive run and drops a 410", async () => {
  const faux = okFauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const previous: ProbeResult[] = [
    {
      id: "opencode-go/beam-free",
      provider: "opencode-go",
      model: "beam-free",
      status: "ok",
      toolCall: true,
      latencyMs: 10,
      checkedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "opencode-go/glm-5.3-flash",
      provider: "opencode-go",
      model: "glm-5.3-flash",
      status: "ok",
      toolCall: true,
      latencyMs: 10,
      checkedAt: "2026-10-01T00:00:00.000Z",
    },
  ];
  const fresh: ProbeResult[] = [
    { ...previous[0]!, status: "rate_limited", toolCall: false, checkedAt: "2026-10-29T12:00:00.000Z" },
    { ...previous[1]!, status: "deprecated", toolCall: false, checkedAt: "2026-10-29T12:00:00.000Z" },
  ];
  const run = await probeModels({ models, configured: new Set(["opencode-go"]), previous, candidates: [] });
  assert.equal(run.results.length, 0);
  const merged = (await import("../src/server/models/allowlist.ts")).resolveAllowlist(previous, fresh);
  assert.deepEqual(merged.allowed.map((entry) => entry.id), ["opencode-go/beam-free"], "inconclusive keeps the verdict");
  assert.deepEqual(merged.dropped.map((entry) => entry.id), ["opencode-go/glm-5.3-flash"], "410 drops it");
});

test("the cache write is guarded by checkedAt, so an older run cannot overwrite a newer one", async () => {
  const dir = await mkdtemp(join(tmpdir(), `${TMP_PREFIX}cache-`));
  try {
    const cache = cacheFile(dir);
    await cache.ensure();
    const result = (id: string, checkedAt: string): ProbeResult => ({
      id,
      provider: "opencode-go",
      model: id.split("/")[1]!,
      status: "ok",
      toolCall: true,
      latencyMs: 5,
      checkedAt,
    });
    await cache.update(() => toModelProbeCache([result("opencode-go/newer", "2026-10-29T12:00:00.000Z")], "2026-10-29T12:00:00.000Z"));

    // A slow probe that started earlier finishes later: its result is stale.
    const models = createModels();
    models.setProvider(okFauxProvider().provider);
    const run = await probeAndCache(cache, {
      models,
      configured: new Set(["opencode-go"]),
      now: () => Date.parse("2026-10-28T12:00:00.000Z"),
    });
    assert.ok(run.results.length > 0, "the run itself happened");
    const stored = await cache.read();
    assert.equal(stored.checkedAt, "2026-10-29T12:00:00.000Z", "the newer cache stands");
    assert.deepEqual(stored.results.map((entry) => entry.id), ["opencode-go/newer"]);
    assert.equal(allowlistOf(stored).allowed.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- review follow-ups ------------------------------------------------------

test("the configured providers are read live, so a saved key counts for the next probe", async () => {
  await withSecrets(async (secrets) => {
    assert.deepEqual(await providersWithKeys(secrets), new Set(), "nothing stored yet");
    await secrets.update((config) => ({ ...config, providerKeys: { "opencode-go": "sk-1" } }));
    assert.deepEqual(await providersWithKeys(secrets), new Set(["opencode-go"]), "a save is visible immediately");
    await secrets.update((config) => ({
      ...config,
      providerKeys: { "opencode-go": "sk-1", openrouter: "sk-2" },
    }));
    assert.deepEqual(await providersWithKeys(secrets), new Set(["opencode-go", "openrouter"]));
    // Clearing is a delete; `secrets.json`'s parser refuses a blank key rather
    // than storing one that would silently mean "configured".
    await secrets.update((config) => {
      const providerKeys = { ...config.providerKeys };
      delete providerKeys.openrouter;
      return { ...config, providerKeys };
    });
    assert.deepEqual(await providersWithKeys(secrets), new Set(["opencode-go"]));
  });
});

test("a probe keeps the verdicts of models it did not re-probe", async () => {
  const dir = await mkdtemp(join(tmpdir(), `${TMP_PREFIX}merge-`));
  try {
    const cache = cacheFile(dir);
    await cache.ensure();
    const known = (id: string, checkedAt: string, status: ProbeResult["status"] = "ok"): ProbeResult => ({
      id,
      provider: id.split("/")[0]!,
      model: id.split("/")[1]!,
      status,
      toolCall: status === "ok",
      latencyMs: 5,
      checkedAt,
    });
    await cache.update(() =>
      toModelProbeCache(
        [
          known("opencode-go/mimo-v2.6-flash", "2026-10-01T00:00:00.000Z"),
          known("openrouter/openrouter/free", "2026-10-01T00:00:00.000Z"),
        ],
        "2026-10-01T00:00:00.000Z",
      ),
    );

    // Only opencode-go has a key now: the OpenRouter verdict must survive.
    const models = createModels();
    models.setProvider(okFauxProvider().provider);
    await probeAndCache(cache, {
      models,
      configured: new Set(["opencode-go"]),
      now: () => Date.parse("2026-10-29T12:00:00.000Z"),
    });
    const stored = await cache.read();
    assert.equal(stored.checkedAt, "2026-10-29T12:00:00.000Z");
    assert.ok(
      stored.results.some((entry) => entry.id === "openrouter/openrouter/free"),
      "the skipped provider's last-known-good is kept",
    );
    assert.ok(
      allowlistOf(stored).allowed.some((entry) => entry.id === "openrouter/openrouter/free"),
      "and it stays usable in the derived allowlist",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the boot probe trusts a fresh verdict and re-probes a stale one", async () => {
  const models = createModels();
  models.setProvider(okFauxProvider().provider);
  const previous: ProbeResult[] = PROBE_CANDIDATES.filter((target) => target.provider === "opencode-go").map(
    (target) => ({
      id: `${target.provider}/${target.model}`,
      provider: target.provider,
      model: target.model,
      status: "ok",
      toolCall: true,
      latencyMs: 5,
      checkedAt: "2026-10-29T11:00:00.000Z",
    }),
  );
  const nowMs = Date.parse("2026-10-29T12:00:00.000Z");
  // One hour old, inside a six-hour window: nothing is re-probed.
  const fresh = await probeModels({ models, configured: new Set(["opencode-go"]), previous, now: () => nowMs, freshWithinMs: 6 * 60 * 60 * 1000 });
  assert.deepEqual(fresh.results, [], "a recent check is not paid for again");
  assert.equal(fresh.allowlist.allowed.length, previous.length, "the cached verdicts still make them usable");
  // Seven hours old: every candidate is probed again.
  const stale = await probeModels({
    models,
    configured: new Set(["opencode-go"]),
    previous: previous.map((result) => ({ ...result, checkedAt: "2026-10-29T04:00:00.000Z" })),
    now: () => nowMs,
    freshWithinMs: 6 * 60 * 60 * 1000,
  });
  assert.equal(stale.results.length, previous.length, "a stale verdict is re-checked");
});
