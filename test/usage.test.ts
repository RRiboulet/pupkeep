// P4-08: the monthly budget and its derived baseline (PLAN §11.3, §16 P4-08).
//
// What is pinned here:
//   * the pure rules: the 80%/100% thresholds, a `0` cap that blocks every paid
//     turn, a negative spend that never reads as a credit, free vs paid from the
//     catalog (failing closed for a model the catalog lost);
//   * `harness.usage()` as the ledger: `app.usage` stores only where the month
//     started, so the month's spend is `sessionTotal − baseline` — never a second
//     ledger and never the session total;
//   * the baseline repairs: a month rollover and a restore that reports less
//     spend than the baseline observed;
//   * the cap writer: one commit (setting + activity + key), replay, stale and a
//     refused value writing nothing.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, UsageState } from "@earendil-works/pi-durable";
import { UsageDoc } from "@earendil-works/pi-durable";
import type { Usage } from "@earendil-works/pi-ai";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { emptyConfig, type MemberRecord } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import {
  ActivityDoc,
  CommandsDoc,
  HouseholdDoc,
  UsageDoc as UsageSnapshotDoc,
  emptyUsage,
  parseUsage,
} from "../src/server/domain/docs.ts";
import {
  harnessSpendUsd,
  localMonthAt,
  readBudget,
  readUsageSnapshot,
  reconcileUsageMonth,
} from "../src/server/domain/usage.ts";
import { updateAgentBudget } from "../src/server/domain/household.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import { modelIsPaid } from "../src/server/agent/model.ts";
import {
  AGENT_BUDGET_MAX_USD,
  BUDGET_WARN_RATIO,
  budgetView,
  isAgentBudget,
  isFreeModel,
  isUsageMonth,
} from "../src/shared/usage.ts";

const context = BACKGROUND_CONTEXT;
/** 23:30Z on 29 October is already the 30th in Paris. */
const LATE = new Date("2026-10-29T23:30:00.000Z");
const NOVEMBER = new Date("2026-11-02T09:00:00.000Z");

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "owner",
    role: "owner",
    displayName: "Alex",
    createdAt: "2026-10-29T10:00:00.000Z",
    sessions: [],
    ...overrides,
  };
}

const owner = member();
const partner = member({ id: "partner", role: "member", displayName: "Sam" });
const alex = async () => ({ id: "owner", label: "Alex" });

async function withUsageHarness(run: (opened: OpenedHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-usage-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
  try {
    await bootstrapSession(opened.harness, {
      config: { ...emptyConfig(), members: [owner, partner] },
      context,
      timezone: "Europe/Paris",
      now: () => LATE,
    });
    await run(opened);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

/** One complete `Usage` record, as a provider turn would report it. */
function usage(costTotal: number): Usage {
  return {
    input: 1000,
    output: 200,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1200,
    cost: { input: costTotal, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
}

/**
 * Record spend the way a completed model turn does: the conversation's
 * `pi.usage` document, which `harness.usage()` sums. A real turn writes this in
 * the commit that stores the assistant message; a test only needs the numbers.
 */
async function recordSpend(opened: OpenedHarness, costTotal: number): Promise<void> {
  const household = await opened.harness.snapshot(HouseholdDoc, context);
  assert.ok(household);
  await opened.harness.commit(async (tx) => {
    const draft = await tx.doc(UsageDoc, household.conversationId as ConversationId);
    draft.models = { "opencode-go/mimo-v2.6-flash": usage(costTotal) };
  }, context);
}

// --- the pure rules ---------------------------------------------------------

test("the budget has two thresholds and a zero cap blocks paid models", () => {
  assert.equal(budgetView({ month: "2026-10", spentUsd: 0, capUsd: 10 }).state, "ok");
  assert.equal(budgetView({ month: "2026-10", spentUsd: 7.99, capUsd: 10 }).state, "ok");
  // 80% warns and nothing more: the household keeps working.
  assert.equal(budgetView({ month: "2026-10", spentUsd: 8, capUsd: 10 }).state, "warn");
  assert.equal(budgetView({ month: "2026-10", spentUsd: 8, capUsd: 10 }).paidAllowed, true);
  assert.equal(budgetView({ month: "2026-10", spentUsd: 9.99, capUsd: 10 }).state, "warn");
  // 100% blocks paid models, and only those.
  assert.equal(budgetView({ month: "2026-10", spentUsd: 10, capUsd: 10 }).state, "blocked");
  assert.equal(budgetView({ month: "2026-10", spentUsd: 10, capUsd: 10 }).paidAllowed, false);
  assert.equal(budgetView({ month: "2026-10", spentUsd: 25, capUsd: 10 }).ratio, 2.5, "over-spend is still reported");
  // A zero cap means "spend nothing", not "divide by zero".
  const zero = budgetView({ month: "2026-10", spentUsd: 0, capUsd: 0 });
  assert.equal(zero.state, "blocked");
  assert.equal(zero.ratio, 0);
  assert.equal(BUDGET_WARN_RATIO, 0.8);
  // A negative or absurd spend reads as zero, never as a credit; a negative cap
  // reads as zero, which blocks.
  assert.equal(budgetView({ month: "2026-10", spentUsd: -3, capUsd: 10 }).spentUsd, 0);
  assert.equal(budgetView({ month: "2026-10", spentUsd: 3, capUsd: -1 }).state, "blocked");
});

test("the catalog decides what is free, and an unknown model is paid", () => {
  assert.equal(isFreeModel({ input: 0, output: 0 }), true);
  assert.equal(isFreeModel({ input: 0.14, output: 0.28 }), false);
  assert.equal(isFreeModel({ input: 0, output: 0.28 }), false, "half-free is paid");
  assert.equal(isFreeModel(undefined), false, "an unknown cost fails closed");

  const models = createModels();
  models.setProvider(
    fauxProvider({
      provider: "opencode-go",
      models: [
        { id: "free-model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as never,
        { id: "paid-model", cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 } } as never,
      ],
    }).provider,
  );
  assert.equal(modelIsPaid(models, { provider: "opencode-go", modelId: "free-model" }), false);
  assert.equal(modelIsPaid(models, { provider: "opencode-go", modelId: "paid-model" }), true);
  assert.equal(modelIsPaid(models, { provider: "opencode-go", modelId: "gone" }), true, "a lost model is paid");
  assert.equal(modelIsPaid(undefined, { provider: "opencode-go", modelId: "paid-model" }), true, "no catalog: paid");
});

test("a cap is whole cents in a plausible range", () => {
  assert.equal(isAgentBudget(0), true);
  assert.equal(isAgentBudget(10), true);
  assert.equal(isAgentBudget(9.99), true);
  assert.equal(isAgentBudget(-1), false);
  assert.equal(isAgentBudget(0.001), false, "fractions of a cent are a typo");
  assert.equal(isAgentBudget(AGENT_BUDGET_MAX_USD + 1), false);
  assert.equal(isAgentBudget("10"), false);
  assert.equal(isUsageMonth("2026-10"), true);
  assert.equal(isUsageMonth("2026-13"), false);
  assert.equal(isUsageMonth("2026-1"), false);
});

test("the usage document is a month and a baseline, and nothing else", () => {
  assert.deepEqual(parseUsage({ ...emptyUsage(), month: "2026-10", observedAt: LATE.toISOString() }), {
    schemaVersion: 1,
    month: "2026-10",
    baselineCostUsd: 0,
    observedAt: LATE.toISOString(),
  });
  assert.equal(parseUsage({ ...emptyUsage(), observedAt: LATE.toISOString() }), undefined, "a blank month is not a month");
  assert.equal(parseUsage({ ...emptyUsage(), month: "2026-10", baselineCostUsd: -1, observedAt: LATE.toISOString() }), undefined);
  assert.equal(parseUsage({ ...emptyUsage(), month: "2026-10", observedAt: "" }), undefined);
  assert.equal(
    parseUsage({ ...emptyUsage(), month: "2026-10", baselineCostUsd: 1, observedAt: LATE.toISOString(), extra: true }),
    undefined,
    "an unknown key is refused",
  );
});

test("spend is summed across every bucket the harness reports", () => {
  const state: UsageState = {
    models: { "opencode-go/a": usage(1.5) as never, "openrouter/b": usage(0.25) as never },
    tools: { some_tool: usage(0.25) as never },
  };
  assert.equal(harnessSpendUsd(state), 2);
  assert.equal(harnessSpendUsd({}), 0);
  // A provider that reports no cost, or a broken number, adds nothing.
  assert.equal(harnessSpendUsd({ models: { x: {} as never } }), 0);
  assert.equal(harnessSpendUsd({ models: { x: { cost: { total: Number.NaN } } as never } }), 0);
});

// --- the baseline over a real harness ---------------------------------------

test("a fresh household starts its month at the current spend, not at zero", async () => {
  await withUsageHarness(async (opened) => {
    assert.equal(localMonthAt(LATE, "Europe/Paris"), "2026-10");
    const snapshot = await readUsageSnapshot(opened.harness, context);
    assert.equal(snapshot.month, "2026-10");
    assert.equal(snapshot.baselineCostUsd, 0);
    const budget = await readBudget(opened.harness, context, LATE);
    assert.deepEqual(
      { month: budget.month, spentUsd: budget.spentUsd, capUsd: budget.capUsd, state: budget.state },
      { month: "2026-10", spentUsd: 0, capUsd: 10, state: "ok" },
      "the plan's default cap",
    );
  });
});

test("this month's spend is the session total minus the baseline", async () => {
  await withUsageHarness(async (opened) => {
    await recordSpend(opened, 3.25);
    const budget = await readBudget(opened.harness, context, LATE);
    assert.equal(budget.spentUsd, 3.25);
    assert.equal(budget.state, "ok");
    assert.equal((await readUsageSnapshot(opened.harness, context)).baselineCostUsd, 0, "the month's start is unchanged");

    // Raising the cap in the household is the owner's one knob (§11.3).
    const raised = await updateAgentBudget(opened.harness, context, {
      actor: alex,
      actionId: "http:budget-1",
      rev: (await opened.harness.snapshot(HouseholdDoc, context))!.rev,
      capUsd: 5,
      now: LATE,
    });
    assert.equal(raised, "updated");
    const tighter = await readBudget(opened.harness, context, LATE);
    assert.equal(tighter.capUsd, 5);
    assert.equal(tighter.state, "ok", "3.25 of 5 is below the warning line");
    await recordSpend(opened, 4.25);
    const warned = await readBudget(opened.harness, context, LATE);
    assert.equal(warned.spentUsd, 4.25);
    assert.equal(warned.state, "warn", "85% warns");
    assert.equal(warned.paidAllowed, true);
  });
});

test("a new household month re-baselines from the harness total", async () => {
  await withUsageHarness(async (opened) => {
    await recordSpend(opened, 4);
    assert.equal((await readBudget(opened.harness, context, LATE)).spentUsd, 4);

    // The clock crosses into November: the month's spend restarts, and the
    // baseline moves to the total so a long-lived household never looks
    // permanently over budget.
    const november = await readBudget(opened.harness, context, NOVEMBER);
    assert.equal(november.month, "2026-11");
    assert.equal(november.spentUsd, 0);
    const snapshot = await readUsageSnapshot(opened.harness, context);
    assert.equal(snapshot.month, "2026-11");
    assert.equal(snapshot.baselineCostUsd, 4);
    assert.equal(snapshot.observedAt, NOVEMBER.toISOString());

    // A second read in the same month writes nothing.
    const again = await reconcileUsageMonth(opened.harness, context, new Date(NOVEMBER.getTime() + 60_000));
    assert.equal(again.snapshot.observedAt, NOVEMBER.toISOString());

    await recordSpend(opened, 4.5);
    assert.equal((await readBudget(opened.harness, context, NOVEMBER)).spentUsd, 0.5);
  });
});

test("a restore that reports less spend than the baseline re-baselines instead of a credit", async () => {
  await withUsageHarness(async (opened) => {
    await recordSpend(opened, 6);
    // A backup restored over a database with a later baseline: the session total
    // is now *below* what the baseline remembered.
    await opened.harness.commit(async (tx) => {
      const draft = await tx.doc(UsageSnapshotDoc);
      draft.baselineCostUsd = 10;
    }, context);
    const budget = await readBudget(opened.harness, context, LATE);
    assert.equal(budget.spentUsd, 0, "the month restarts at zero, never negative");
    assert.equal((await readUsageSnapshot(opened.harness, context)).baselineCostUsd, 6);
  });
});

// --- the cap writer ---------------------------------------------------------

test("setting the cap is one commit: setting, activity and key", async () => {
  await withUsageHarness(async (opened) => {
    const before = (await opened.harness.snapshot(HouseholdDoc, context))!;
    const beforeActivity = (await opened.harness.snapshot(ActivityDoc, context))!.entries.length;
    const outcome = await updateAgentBudget(opened.harness, context, {
      actor: alex,
      actionId: "http:budget-1",
      rev: before.rev,
      capUsd: 25.5,
      now: LATE,
    });
    assert.equal(outcome, "updated");

    const after = (await opened.harness.snapshot(HouseholdDoc, context))!;
    assert.equal(after.settings.agentBudgetUsd, 25.5);
    assert.equal(after.rev, before.rev + 1);
    const activity = (await opened.harness.snapshot(ActivityDoc, context))!.entries;
    assert.equal(activity.length, beforeActivity + 1);
    assert.equal(activity.at(-1)!.kind, "household.budget");
    assert.equal(activity.at(-1)!.summary, "Alex set the monthly agent budget to $25.50");
    assert.ok((await opened.harness.snapshot(CommandsDoc, context))!.entries.some((entry) => entry.key === "http:budget-1"));

    // A replay of the same key is a success even though it bumped the revision.
    assert.equal(
      await updateAgentBudget(opened.harness, context, {
        actor: alex,
        actionId: "http:budget-1",
        rev: before.rev,
        capUsd: 25.5,
        now: LATE,
      }),
      "replayed",
    );
    // A stale revision is refused and writes nothing.
    assert.equal(
      await updateAgentBudget(opened.harness, context, {
        actor: alex,
        actionId: "http:budget-2",
        rev: before.rev,
        capUsd: 50,
        now: LATE,
      }),
      "stale",
    );
    assert.equal((await opened.harness.snapshot(HouseholdDoc, context))!.settings.agentBudgetUsd, 25.5);
    // A refused value does not reach the document and does not burn its key.
    await assert.rejects(
      updateAgentBudget(opened.harness, context, {
        actor: alex,
        actionId: "http:budget-3",
        rev: after.rev,
        capUsd: 0.001,
        now: LATE,
      }),
      /whole cents/,
    );
    assert.equal((await opened.harness.snapshot(HouseholdDoc, context))!.settings.agentBudgetUsd, 25.5);
    assert.equal(
      (await opened.harness.snapshot(CommandsDoc, context))!.entries.some((entry) => entry.key === "http:budget-3"),
      false,
    );
  });
});
