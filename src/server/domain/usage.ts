// The monthly budget (PLAN §11.3, §16 P4-08).
//
// The one rule this module exists to keep: **`harness.usage()` is the ledger**.
// `app.usage` stores only `{month, baselineCostUsd}` — where the household-month
// began in the session total — so the month's spend is
// `sessionTotal − baseline`, computed on read. Nothing here records a spend
// event, and nothing sums a second set of numbers: a ledger beside the harness
// would drift the first time a turn crashed between the provider call and the
// bookkeeping.
//
// Consequences that shape the code:
//   * usage is read **outside** any commit (it is a Session read), which is why
//     `reconcileUsageMonth` reads first and commits second;
//   * a running turn can cross the cap, so the *next* submission is what gets
//     blocked (§11.3), never a turn already in flight;
//   * the baseline is repaired in two situations, both from the harness's own
//     total: the household month rolled over, and the total went **backwards**
//     (a restore from a backup taken before this database's spend). In both
//     cases the conservative reading is "this month started now", which can only
//     under-count, never fake a credit.
//
// Probe spend is deliberately **not** included. `runProbes` calls providers
// directly (`Models.completeSimple`), outside Pi Durable, so its usage never
// reaches `harness.usage()`; the probe result reports what it spent and the UI
// says so (§11.2). Recording it here would be the second ledger this module
// refuses to keep.

import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import type { Household, UsageSnapshot } from "../../shared/domain.ts";
import { budgetView, type BudgetView } from "../../shared/usage.ts";
import { readHousehold } from "./household.ts";
import { UsageDoc, parseUsage, type DocStore } from "./docs.ts";
import { UnavailableError } from "./errors.ts";
import { localDateAt } from "./time.ts";

/** `app.usage` is missing or unreadable; boot repairs it from the harness. */
export class UsageUnavailableError extends UnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "UsageUnavailableError";
  }
}

/** The spend a `UsageState` reports, in USD: every bucket, models and tools. */
export function harnessSpendUsd(state: {
  models?: Record<string, { cost?: { total?: number } }>;
  tools?: Record<string, { cost?: { total?: number } }>;
}): number {
  let total = 0;
  for (const bucket of [state.models ?? {}, state.tools ?? {}]) {
    for (const usage of Object.values(bucket)) {
      const cost = usage?.cost?.total;
      if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) total += cost;
    }
  }
  return total;
}

/** The household-local month of an instant, `YYYY-MM` (the date's first seven characters). */
export function localMonthAt(instant: Date, timezone: string): string {
  return localDateAt(instant, timezone).slice(0, 7);
}

/**
 * Read the snapshot, repairing the baseline when the month rolled over or the
 * session total went backwards. The harness read happens first — it is a
 * Session call, and one made inside a commit would queue on the line the commit
 * holds — and the repair is one small commit that re-reads the document.
 */
export async function reconcileUsageMonth(
  store: DocStore & Pick<Harness, "usage">,
  context: Context,
  now: Date,
): Promise<{ snapshot: UsageSnapshot; totalUsd: number; household: Household }> {
  const household = await readHousehold(store, context);
  const month = localMonthAt(now, household.timezone);
  const totalUsd = harnessSpendUsd(await store.usage(context));
  const snapshot = await readUsageSnapshot(store, context);

  const rolled = snapshot.month !== month;
  // A restore from an older backup, or a database someone replaced, can report
  // less spend than the baseline remembers. A negative month would read as a
  // credit, so re-baseline instead.
  const backwards = totalUsd + 1e-9 < snapshot.baselineCostUsd;
  if (!rolled && !backwards) return { snapshot, totalUsd, household };

  const written = await store.commit(async (tx) => {
    const draft = await tx.doc(UsageDoc);
    // Re-check inside the commit: two concurrent reads may both decide to
    // repair, and the second must not move the baseline a second time.
    if (draft.month === month && totalUsd + 1e-9 >= draft.baselineCostUsd) return null;
    draft.month = month;
    draft.baselineCostUsd = totalUsd;
    draft.observedAt = now.toISOString();
    return { ...draft };
  }, context);
  const next = written === null ? snapshot : parseUsage(written);
  if (!next) throw new UsageUnavailableError("the usage baseline is not a shape this build understands");
  return { snapshot: next, totalUsd, household };
}

/** The stored baseline. Boot keeps the document present. */
export async function readUsageSnapshot(store: DocStore, context: Context): Promise<UsageSnapshot> {
  const snapshot = await store.snapshot(UsageDoc, context);
  const usage = snapshot === undefined ? undefined : parseUsage(snapshot);
  if (!usage) throw new UsageUnavailableError("the usage baseline is not available; retry after boot");
  return usage;
}

/**
 * The household's budget right now: this month's spend against the cap in
 * `app.household.settings.agentBudgetUsd`. `now` is the process clock, so a
 * test's month and the route's month are the same month.
 */
export async function readBudget(
  store: DocStore & Pick<Harness, "usage">,
  context: Context,
  now: Date,
): Promise<BudgetView> {
  const { snapshot, totalUsd, household } = await reconcileUsageMonth(store, context, now);
  return budgetView({
    month: snapshot.month,
    // The month's spend, never the session total: a household that has run for
    // a year must not look permanently over budget.
    spentUsd: totalUsd - snapshot.baselineCostUsd,
    capUsd: household.settings.agentBudgetUsd,
  });
}
