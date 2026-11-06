// P4-08: the budget over HTTP (PLAN §11.3, §14.1, §14.2, §16 P4-08).
//
// What is covered:
//   * the read: both caregivers see this month's spend and the cap; no session
//     is 401;
//   * the write: owner-only (§14.1), a JSON body with `rev` + `capUsd` and the
//     shared mutation guards, a stale revision answered with the current care
//     view, and the cap taking effect on the next read;
//   * **the enforcement is server-side**, not just displayed: at the cap a paid
//     model's submission is refused with `budget_exhausted` and nothing is
//     placed, a free model still goes through, and raising the cap unblocks the
//     paid one. 80% warns and does not block.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, UsageState } from "@earendil-works/pi-durable";
import { UsageDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import { HouseholdDoc } from "../src/server/domain/docs.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { createLogger } from "../src/server/log.ts";
import type { BudgetView } from "../src/shared/usage.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { dataStores } from "../src/server/config.ts";
import { Auth, hashToken, newToken } from "../src/server/auth.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const context = BACKGROUND_CONTEXT;
/** 23:30Z is already 30 October in Paris. */
const LATE = new Date("2026-10-29T23:30:00.000Z");
const MEMBER_CREATED_AT = "2025-01-01T00:00:00.000Z";
const SESSION_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

/** A model the catalog prices at zero, and one it prices. */
const FREE_MODEL = "free-model";
const PAID_MODEL = "paid-model";

interface Fixture {
  url: string;
  app: AppHandle;
  dir: string;
  ownerCookie: string;
  partnerCookie: string;
  stop(): Promise<void>;
}

async function startBudgetApp(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-budget-routes-"));
  // The faux provider is the catalog: the budget's paid/free decision reads it.
  const faux = fauxProvider({
    provider: "opencode-go",
    models: [
      { id: FREE_MODEL, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as never,
      { id: PAID_MODEL, cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 } } as never,
    ],
  });
  faux.setResponses([() => fauxAssistantMessage("Noted.")]);
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
  try {
    const patched = await fetch(`${result.app.url}/api/household`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        "Idempotency-Key": "zone-setup",
        Cookie: `${SESSION_COOKIE}=${ownerCookie}`,
        Origin: result.app.url,
      },
      body: JSON.stringify({ rev: 0, timezone: "Europe/Paris" }),
    });
    assert.equal(patched.status, 200, "the zone is set for the fixture");
  } catch (error) {
    await stop();
    throw error;
  }
  return { url: result.app.url, app: result.app, dir, ownerCookie, partnerCookie: partnerToken, stop };
}

function cookie(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

async function patchBudget(
  fixture: Fixture,
  token: string,
  body: Record<string, unknown>,
  key = "budget-1",
): Promise<Response> {
  return fetch(`${fixture.url}/api/budget`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      "Idempotency-Key": key,
      Cookie: cookie(token),
      Origin: fixture.url,
    },
    body: JSON.stringify(body),
  });
}

async function readBudget(fixture: Fixture, token = fixture.ownerCookie): Promise<BudgetView> {
  const response = await fetch(`${fixture.url}/api/budget`, { headers: { Cookie: cookie(token) } });
  assert.equal(response.status, 200);
  return ((await response.json()) as { budget: BudgetView }).budget;
}

async function householdRev(fixture: Fixture): Promise<number> {
  const household = await fixture.app.app.snapshot(HouseholdDoc, context);
  assert.ok(household);
  return household.rev;
}

/** Record spend the way a completed turn does: the conversation's `pi.usage`. */
async function recordSpend(fixture: Fixture, costTotal: number): Promise<void> {
  const household = await fixture.app.app.snapshot(HouseholdDoc, context);
  assert.ok(household);
  await fixture.app.app.commit(async (tx) => {
    const draft = await tx.doc(UsageDoc, household.conversationId as ConversationId);
    const usage = {
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1200,
      cost: { input: costTotal, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    };
    draft.models = { "opencode-go/paid-model": usage } as UsageState["models"];
  }, context);
}

/** Point the shared thread at one model, as the picker route will (P4-08b). */
async function setThreadModel(fixture: Fixture, modelId: string): Promise<void> {
  const household = await fixture.app.app.snapshot(HouseholdDoc, context);
  assert.ok(household);
  const conversation = await fixture.app.app.conversation(household.conversationId as ConversationId, context);
  assert.ok(conversation);
  await conversation.configure({ model: { provider: "opencode-go", modelId } }, context);
}

async function submit(fixture: Fixture, token: string, clientMessageId: string): Promise<Response> {
  return fetch(`${fixture.url}/api/agent/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      Cookie: cookie(token),
      Origin: fixture.url,
    },
    body: JSON.stringify({ text: "How is the pup?", clientMessageId }),
  });
}

// --- the read ---------------------------------------------------------------

test("both caregivers can read this month's spend and the cap", async () => {
  const fixture = await startBudgetApp();
  try {
    assert.equal((await fetch(`${fixture.url}/api/budget`)).status, 401);
    const owner = await readBudget(fixture);
    assert.deepEqual(
      { month: owner.month, spentUsd: owner.spentUsd, capUsd: owner.capUsd, state: owner.state },
      { month: "2026-10", spentUsd: 0, capUsd: 10, state: "ok" },
    );
    const partner = await readBudget(fixture, fixture.partnerCookie);
    assert.equal(partner.capUsd, 10, "the partner sees the same cap");
    assert.equal(partner.spentUsd, 0);
  } finally {
    await fixture.stop();
  }
});

// --- the write --------------------------------------------------------------

test("only the owner sets the cap, and the next read reflects it", async () => {
  const fixture = await startBudgetApp();
  try {
    const rev = await householdRev(fixture);
    const refused = await patchBudget(fixture, fixture.partnerCookie, { rev, capUsd: 5 });
    assert.equal(refused.status, 403, "§14.1: the budget is owner-only");
    assert.equal((await readBudget(fixture)).capUsd, 10, "nothing changed");

    const saved = await patchBudget(fixture, fixture.ownerCookie, { rev, capUsd: 5.5 }, "budget-set");
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { budget: BudgetView; replayed: boolean };
    assert.equal(body.replayed, false);
    assert.equal(body.budget.capUsd, 5.5);
    assert.equal((await readBudget(fixture)).capUsd, 5.5);

    // A stale revision carries the current care view, like every §7.4 write.
    const stale = await patchBudget(fixture, fixture.ownerCookie, { rev, capUsd: 50 }, "budget-stale");
    assert.equal(stale.status, 409);
    const staleBody = (await stale.json()) as { error: string; profile: { household: { rev: number } } };
    assert.equal(staleBody.error, "stale");
    assert.equal(staleBody.profile.household.rev, rev + 1, "the answer carries the current care view");
    assert.equal((await readBudget(fixture)).capUsd, 5.5, "the stored cap stands");

    // The value's own rule, not only the client's input type.
    const bad = await patchBudget(fixture, fixture.partnerCookie, { rev, capUsd: 1 });
    assert.equal(bad.status, 403);
    const badOwner = await patchBudget(fixture, fixture.ownerCookie, { rev: rev + 1, capUsd: 0.001 }, "budget-bad");
    assert.equal(badOwner.status, 409);
    assert.match(((await badOwner.json()) as { error: string }).error, /whole cents/);
  } finally {
    await fixture.stop();
  }
});

// --- the enforcement --------------------------------------------------------

test("at the cap a paid model's message is refused server-side, and nothing is placed", async () => {
  const fixture = await startBudgetApp();
  try {
    await setThreadModel(fixture, PAID_MODEL);
    await recordSpend(fixture, 10);
    assert.equal((await readBudget(fixture)).state, "blocked");

    const refused = await submit(fixture, fixture.ownerCookie, "m-budget-1");
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { error: string; message: string; budget: BudgetView };
    assert.equal(body.error, "budget_exhausted");
    assert.match(body.message, /owner can raise it/);
    assert.equal(body.budget.spentUsd, 10);
    // Nothing was placed: the thread has no submission for that client id.
    const thread = await fetch(`${fixture.url}/api/agent/thread`, {
      headers: { Cookie: cookie(fixture.ownerCookie) },
    });
    assert.equal(((await thread.json()) as { status: { busy: boolean } }).status.busy, false);

    // Raising the cap is the owner's way out (§11.3).
    const rev = await householdRev(fixture);
    assert.equal((await patchBudget(fixture, fixture.ownerCookie, { rev, capUsd: 20 }, "raise")).status, 200);
    const accepted = await submit(fixture, fixture.ownerCookie, "m-budget-2");
    assert.equal(accepted.status, 202);
  } finally {
    await fixture.stop();
  }
});

test("a free model stays usable at the cap, and 80% only warns", async () => {
  const fixture = await startBudgetApp();
  try {
    await setThreadModel(fixture, FREE_MODEL);
    await recordSpend(fixture, 10);
    const budget = await readBudget(fixture);
    assert.equal(budget.state, "blocked");
    assert.equal(budget.paidAllowed, false);
    // The plan: free models remain selectable, so their turn is not blocked.
    const accepted = await submit(fixture, fixture.partnerCookie, "m-free");
    assert.equal(accepted.status, 202);

    // Below the cap: a paid model's message goes through, warned but not blocked.
    await setThreadModel(fixture, PAID_MODEL);
    await recordSpend(fixture, 8.5);
    const warned = await readBudget(fixture);
    assert.equal(warned.state, "warn");
    assert.equal(warned.paidAllowed, true);
    const ok = await submit(fixture, fixture.ownerCookie, "m-warn");
    assert.equal(ok.status, 202);
  } finally {
    await fixture.stop();
  }
});
