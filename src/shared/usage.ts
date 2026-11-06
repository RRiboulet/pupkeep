// The monthly budget's pure rules (PLAN §11.3, §16 P4-08).
//
// The agent spends money, so the household has one cap — **$10/month** by
// default — and two thresholds:
//
//   80%  warn: the UI and the agent header say so; nothing is blocked;
//   100% block paid models: a paid turn is refused server-side, while free ($0)
//        models stay selectable and are never auto-selected.
//
// What this module deliberately does **not** do is keep a ledger. `harness.usage()`
// is authoritative (§11.3), and `app.usage` only remembers where the current
// month started (`baselineCostUsd`). Everything here is pure and zone-free: the
// server turns an instant into a household-local `YYYY-MM` with its own clock
// helpers, and the browser only renders what it is told.

/** §11.3: the warning threshold. Not configurable; it is a fraction of the cap. */
export const BUDGET_WARN_RATIO = 0.8;
/** The plan's default cap, used when the household has never set one. */
export const DEFAULT_AGENT_BUDGET_USD = 10;
/** A cap the owner may raise to; a typo must not arm an unlimited budget. */
export const AGENT_BUDGET_MAX_USD = 10_000;

/** `YYYY-MM`, the household-local month a baseline belongs to. */
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isUsageMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH.test(value);
}

/** A cap is whole cents in a plausible range; the parser and the writer share it. */
export function isAgentBudget(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= AGENT_BUDGET_MAX_USD &&
    Math.round(value * 100) === value * 100
  );
}

/** What the household may do at this spend (§11.3's two thresholds). */
export type BudgetState = "ok" | "warn" | "blocked";

export type BudgetView = {
  /** Household-local month the cap applies to, `YYYY-MM`. */
  month: string;
  /** Spend this month, USD (session total minus the month's baseline). */
  spentUsd: number;
  capUsd: number;
  /** `spentUsd / capUsd`; `0` when the cap is `0`, which blocks paid models. */
  ratio: number;
  state: BudgetState;
  /** True when a paid model may be used right now. */
  paidAllowed: boolean;
};

/**
 * The one place the thresholds become a state. A `0` cap blocks every paid
 * turn: "spend nothing" is a legitimate owner choice, and it must not divide by
 * zero. Spend below zero (a restore out of order) reads as zero, never as a
 * credit.
 */
export function budgetView(input: { month: string; spentUsd: number; capUsd: number }): BudgetView {
  const spent = Number.isFinite(input.spentUsd) && input.spentUsd > 0 ? input.spentUsd : 0;
  const cap = Number.isFinite(input.capUsd) && input.capUsd > 0 ? input.capUsd : 0;
  const ratio = cap === 0 ? 0 : spent / cap;
  const state: BudgetState = cap === 0 ? "blocked" : spent >= cap ? "blocked" : ratio >= BUDGET_WARN_RATIO ? "warn" : "ok";
  return {
    month: input.month,
    spentUsd: spent,
    capUsd: cap,
    ratio,
    state,
    paidAllowed: state !== "blocked",
  };
}

/**
 * Is this model free? The catalog's price decides, not the id: a "$0" row in the
 * plan's table is a fact about today's catalog. An unknown model is treated as
 * **paid** (fail closed) — a budget check that guessed "free" for a model the
 * catalog lost would spend the household's money on the strength of a typo.
 */
export function isFreeModel(cost: { input: number; output: number } | undefined): boolean {
  if (!cost) return false;
  return cost.input === 0 && cost.output === 0;
}
