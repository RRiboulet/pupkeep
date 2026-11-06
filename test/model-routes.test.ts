// P4-08: the model, provider-key and picker routes (PLAN §11.2, §11.3, §14.1,
// §14.2, §16 P4-08).
//
// What is covered:
//   * the read: both caregivers see the model, the allowlist with its reasons,
//     the last probe, which providers have a key and this month's budget — and a
//     missing session is a 401;
//   * provider keys: owner-only, written to `secrets.json`, **never echoed**,
//     clearable, and the value's own shape rule;
//   * the probe route: owner-only, rate-limited on the deps' limiter, answers the
//     per-model results and the merged allowlist;
//   * the picker: owner-only, refuses a model the probe has not allowed, refuses
//     a paid model at the budget cap while a free one is accepted, and attaches
//     the chosen model to the shared thread.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { UsageDoc } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { SESSION_COOKIE, Auth, hashToken, newToken } from "../src/server/auth.ts";
import { dataStores, type DataStores } from "../src/server/config.ts";
import { HouseholdDoc } from "../src/server/domain/docs.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { createLogger } from "../src/server/log.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { PROBE_CACHE_VERSION, toModelProbeCache } from "../src/server/models/cache.ts";

const context = BACKGROUND_CONTEXT;
const LATE = new Date("2026-10-29T23:30:00.000Z");
const MEMBER_CREATED_AT = "2025-01-01T00:00:00.000Z";
const SESSION_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

const FREE_MODEL = "free-model";
const PAID_MODEL = "paid-model";

interface Fixture {
  url: string;
  app: AppHandle;
  dir: string;
  stores: DataStores;
  ownerCookie: string;
  partnerCookie: string;
  stop(): Promise<void>;
}

async function startModelsApp(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-model-routes-"));
  const faux = fauxProvider({
    provider: "opencode-go",
    models: [
      { id: FREE_MODEL, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as never,
      { id: PAID_MODEL, cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 } } as never,
    ],
  });
  faux.setResponses(
    Array.from({ length: 8 }, () => () =>
      fauxAssistantMessage([fauxToolCall("pupkeep_probe", { status: "ok" })], { stopReason: "toolUse" }),
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);

  const stores = dataStores(dir);
  await stores.config.ensure();
  const partnerToken = newToken();
  await stores.config.update((current) => ({
    ...current,
    members: [
      { id: "owner", role: "owner", displayName: "Alex", createdAt: MEMBER_CREATED_AT, sessions: [] },
      {
        id: "partner",
        role: "member",
        displayName: "Sam",
        createdAt: MEMBER_CREATED_AT,
        sessions: [{ tokenHash: hashToken(partnerToken), createdAt: MEMBER_CREATED_AT, expiresAt: SESSION_EXPIRES_AT }],
      },
    ],
  }));

  const result = await startApp(
    { dataDir: dir, host: "127.0.0.1", port: 0, models, now: () => LATE.getTime() },
    { logger: createLogger({ scope: "test", sink: () => undefined }) },
  );
  assert.ok(result.ok, "the app must start");
  const auth = new Auth({ config: stores.config });
  const ownerCookie = await auth.mintOwner("http://127.0.0.1").then((m) => auth.login(m.token)).then((l) => l.token);
  const stop = async (): Promise<void> => {
    await result.app.close();
    await rm(dir, { recursive: true, force: true });
  };
  return {
    url: result.app.url,
    app: result.app,
    dir,
    stores: dataStores(dir),
    ownerCookie,
    partnerCookie: partnerToken,
    stop,
  };
}

function cookie(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

interface MutationOptions {
  body?: Record<string, unknown>;
  key?: string;
  omitKey?: boolean;
}

async function mutate(
  fixture: Fixture,
  path: string,
  token: string,
  method: "PUT" | "POST" | "PATCH",
  options: MutationOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
    Cookie: cookie(token),
    Origin: fixture.url,
  };
  if (!options.omitKey) headers["Idempotency-Key"] = options.key ?? "model-key-1";
  return fetch(`${fixture.url}${path}`, { method, headers, body: JSON.stringify(options.body ?? {}) });
}

interface ModelsView {
  current: { id: string; paid: boolean } | null;
  providers: Record<string, boolean>;
  allowlist: {
    allowed: { id: string }[];
    unverified: { id: string; reason: string }[];
    dropped: { id: string; status: string }[];
  };
  probe: { checkedAt: string; results: { id: string; status: string }[] } | null;
  candidates: { id: string; paid: boolean; price: { input: number; output: number } | null }[];
  budget: { capUsd: number; spentUsd: number; paidAllowed: boolean };
}

async function readModels(fixture: Fixture, token = fixture.ownerCookie): Promise<ModelsView> {
  const response = await fetch(`${fixture.url}/api/models`, { headers: { Cookie: cookie(token) } });
  assert.equal(response.status, 200);
  return (await response.json()) as ModelsView;
}

/** Cache a probe verdict for a model in the fixture's scripted catalog. */
async function cacheAllowlist(fixture: Fixture, ids: string[]): Promise<void> {
  const results = ids.map((id) => {
    const [provider, model] = id.split("/");
    return {
      id,
      provider: provider!,
      model: model!,
      status: "ok" as const,
      toolCall: true,
      latencyMs: 5,
      checkedAt: LATE.toISOString(),
    };
  });
  await fixture.stores.models.update(() => toModelProbeCache(results, LATE.toISOString()));
}

async function recordSpend(fixture: Fixture, costTotal: number): Promise<void> {
  const household = await fixture.app.app.snapshot(HouseholdDoc, context);
  assert.ok(household);
  await fixture.app.app.commit(async (tx) => {
    const draft = await tx.doc(UsageDoc, household.conversationId as ConversationId);
    draft.models = {
      "opencode-go/paid-model": {
        input: 1000,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1200,
        cost: { input: costTotal, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
      },
    };
  }, context);
}

// --- the read ---------------------------------------------------------------

test("both caregivers see the model state, and it starts with no model attached", async () => {
  const fixture = await startModelsApp();
  try {
    assert.equal((await fetch(`${fixture.url}/api/models`)).status, 401);
    const view = await readModels(fixture, fixture.partnerCookie);
    assert.equal(view.current, null, "no key, no probe: nothing attached");
    assert.deepEqual(view.providers, { "opencode-go": false, openrouter: false });
    assert.deepEqual(view.allowlist, { allowed: [], unverified: [], dropped: [] });
    assert.equal(view.probe, null);
    assert.deepEqual(
      view.candidates.map((candidate) => [candidate.id, candidate.paid]),
      [
        ["opencode-go/mimo-v2.6-flash", true],
        ["opencode-go/beam-free", true],
        ["opencode-go/deepseek-v4.1-flash", true],
        ["opencode-go/glm-5.3-flash", true],
        ["opencode-go/qwen3.8-flash", true],
        ["openrouter/openrouter/free", true],
      ],
      "the §11.2 candidates, priced from the catalog (unknown = paid)",
    );
    assert.equal(view.budget.capUsd, 10);
    assert.equal(view.budget.paidAllowed, true);
  } finally {
    await fixture.stop();
  }
});

// --- provider keys ----------------------------------------------------------

test("a provider key is owner-only, stored in secrets.json and never echoed", async () => {
  const fixture = await startModelsApp();
  try {
    const refused = await mutate(fixture, "/api/models/keys", fixture.partnerCookie, "PUT", {
      body: { provider: "opencode-go", key: "sk-partner" },
    });
    assert.equal(refused.status, 403, "§14.1: providers are owner-only");

    const saved = await mutate(fixture, "/api/models/keys", fixture.ownerCookie, "PUT", {
      body: { provider: "opencode-go", key: "  sk-household-secret  " },
    });
    assert.equal(saved.status, 200);
    const raw = await saved.text();
    assert.doesNotMatch(raw, /sk-household-secret/, "the key is never echoed");
    assert.deepEqual(JSON.parse(raw), { providers: { "opencode-go": true, openrouter: false } });
    assert.equal(
      (await fixture.stores.secrets.read()).providerKeys["opencode-go"],
      "sk-household-secret",
      "trimmed and stored in secrets.json",
    );
    const file = await readFile(join(fixture.dir, "secrets.json"), "utf8");
    assert.match(file, /sk-household-secret/);

    assert.equal((await readModels(fixture)).providers["opencode-go"], true);

    // Clearing is a `null` key; the provider becomes unconfigured again.
    const cleared = await mutate(fixture, "/api/models/keys", fixture.ownerCookie, "PUT", {
      body: { provider: "opencode-go", key: null },
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(((await cleared.json()) as { providers: Record<string, boolean> }).providers, {
      "opencode-go": false,
      openrouter: false,
    });

    const badProvider = await mutate(fixture, "/api/models/keys", fixture.ownerCookie, "PUT", {
      body: { provider: "anthropic", key: "x" },
    });
    assert.equal(badProvider.status, 409);
    const badKey = await mutate(fixture, "/api/models/keys", fixture.ownerCookie, "PUT", {
      body: { provider: "opencode-go", key: "two\nlines" },
    });
    assert.equal(badKey.status, 409);
    assert.equal((await fixture.stores.secrets.read()).providerKeys["opencode-go"], undefined);
  } finally {
    await fixture.stop();
  }
});

// --- the probe --------------------------------------------------------------

test("the probe is owner-only and answers the per-model results and the merged allowlist", async () => {
  const fixture = await startModelsApp();
  try {
    const member = await mutate(fixture, "/api/models/probe", fixture.partnerCookie, "POST");
    assert.equal(member.status, 403);

    // The fixture injects its catalog, so both of its providers count as
    // configured (a production catalog's set is the providers with a key; the
    // skip rule itself is pinned in test/models.test.ts). Saving a key is still
    // what the Settings screen does first.
    await mutate(fixture, "/api/models/keys", fixture.ownerCookie, "PUT", {
      body: { provider: "opencode-go", key: "sk-household" },
    });
    const probed = await mutate(fixture, "/api/models/probe", fixture.ownerCookie, "POST");
    assert.equal(probed.status, 200);
    const body = (await probed.json()) as {
      checkedAt: string;
      providers: string[];
      results: { id: string; toolCall: boolean; status: string }[];
      allowlist: { allowed: { id: string }[]; dropped: { id: string }[] };
    };
    assert.deepEqual(body.providers, ["opencode-go"]);
    // The scripted catalog only knows the two fixture models, so the plan's
    // candidates come back `not_found` — and a not_found drops, by §11.2's rule.
    assert.ok(body.results.length >= 5);
    assert.ok(body.results.every((result) => result.status === "not_found" && result.toolCall === false));
    assert.equal(body.allowlist.dropped.length, body.results.length, "unknown models are dropped, not shown");

    const cached = await fixture.stores.models.read();
    assert.equal(cached.version, PROBE_CACHE_VERSION);
    assert.equal(cached.checkedAt, body.checkedAt);
    const view = await readModels(fixture);
    assert.equal(view.probe?.checkedAt, body.checkedAt, "the cache is what the read serves");
  } finally {
    await fixture.stop();
  }
});

// --- the picker -------------------------------------------------------------

test("the picker refuses an unprobed model and attaches an allowed one", async () => {
  const fixture = await startModelsApp();
  try {
    const member = await mutate(fixture, "/api/models/current", fixture.partnerCookie, "PATCH", {
      body: { model: `opencode-go/${PAID_MODEL}` },
    });
    assert.equal(member.status, 403);

    const unprobed = await mutate(fixture, "/api/models/current", fixture.ownerCookie, "PATCH", {
      body: { model: `opencode-go/${PAID_MODEL}` },
    });
    assert.equal(unprobed.status, 409);
    assert.match(((await unprobed.json()) as { error: string }).error, /live tool-calling probe/);

    await cacheAllowlist(fixture, [`opencode-go/${PAID_MODEL}`]);
    const picked = await mutate(fixture, "/api/models/current", fixture.ownerCookie, "PATCH", {
      body: { model: `opencode-go/${PAID_MODEL}` },
    });
    assert.equal(picked.status, 200);
    const body = (await picked.json()) as { current: { id: string; paid: boolean; price: { input: number } } };
    assert.equal(body.current.id, `opencode-go/${PAID_MODEL}`);
    assert.equal(body.current.paid, true);
    assert.equal(body.current.price.input, 0.14);
    // The thread really carries it now.
    const view = await readModels(fixture);
    assert.equal(view.current?.id, `opencode-go/${PAID_MODEL}`);

    const unknown = await mutate(fixture, "/api/models/current", fixture.ownerCookie, "PATCH", {
      body: { model: "opencode-go/not-in-the-catalog" },
    });
    assert.equal(unknown.status, 409);
    assert.match(((await unknown.json()) as { error: string }).error, /provider catalog/);
    const malformed = await mutate(fixture, "/api/models/current", fixture.ownerCookie, "PATCH", {
      body: { model: "mimo" },
    });
    assert.equal(malformed.status, 409);
  } finally {
    await fixture.stop();
  }
});

test("at the cap the picker refuses a paid model and still accepts a free one", async () => {
  const fixture = await startModelsApp();
  try {
    await cacheAllowlist(fixture, [`opencode-go/${PAID_MODEL}`, `opencode-go/${FREE_MODEL}`]);
    await recordSpend(fixture, 10);
    assert.equal((await readModels(fixture)).budget.paidAllowed, false);

    const paid = await mutate(fixture, "/api/models/current", fixture.ownerCookie, "PATCH", {
      body: { model: `opencode-go/${PAID_MODEL}` },
    });
    assert.equal(paid.status, 409);
    assert.match(((await paid.json()) as { error: string }).error, /budget is used up/);
    assert.equal((await readModels(fixture)).current, null, "nothing was attached");

    // Free models remain selectable at the cap (§11.3).
    const free = await mutate(fixture, "/api/models/current", fixture.ownerCookie, "PATCH", {
      body: { model: `opencode-go/${FREE_MODEL}` },
    });
    assert.equal(free.status, 200);
    const body = (await free.json()) as { current: { id: string; paid: boolean } };
    assert.equal(body.current.paid, false);
    assert.equal(body.current.id, `opencode-go/${FREE_MODEL}`);
  } finally {
    await fixture.stop();
  }
});
