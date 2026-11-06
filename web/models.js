// Models, provider keys and the budget: the pure half of the Settings card
// (PLAN §11.2, §11.3, §13.1, §16 P4-08).
//
// What a Node test can pin without a browser: the request bodies, the money and
// price copy, the budget's state as a caregiver reads it, the allowlist's
// reasons in words, and the probe summary. The card in `views/settings.js` turns
// these into elements; like `notifications.js`, this module imports no Preact.
//
// Two facts from the plan that the copy has to keep honest:
//   * probe spend is **not** in the monthly budget (§11.2/§11.3): the calls go
//     to the provider outside Pi Durable, so the result says what it spent and
//     the card says the budget does not count it;
//   * `harness.usage()` is authoritative, so the spend shown is the server's,
//     never a number this module computes from anything else.

/** A price list in USD per 1M tokens, as the catalog reports it. */
export function priceText(price) {
  if (!price) return "price unknown";
  if (price.input === 0 && price.output === 0) return "free";
  return `$${money(price.input)} in / $${money(price.output)} out per 1M tokens`;
}

/** Two decimals for money, without a locale dependency (`en-US` formatting depends on ICU). */
export function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "0.00";
  return number.toFixed(2);
}

/** `3.25 of 10.00` with the month, for the card's headline. */
export function spendText(budget) {
  if (!budget) return "No budget information yet.";
  return `$${money(budget.spentUsd)} of $${money(budget.capUsd)} in ${budget.month}`;
}

/** §11.3's two thresholds as one sentence each. */
export function budgetStateText(state) {
  if (state === "blocked") {
    return (
      "The monthly budget is used up. Paid models are blocked; a free model still works, " +
      "or the owner can raise the cap."
    );
  }
  if (state === "warn") {
    return "The monthly budget is at 80% or more. Nothing is blocked yet; the owner can raise the cap.";
  }
  return "Within the monthly budget.";
}

/** The bar's fill, 0–100, capped at a full bar (over-spend is the state's job). */
export function budgetPercent(budget) {
  if (!budget || !(budget.capUsd > 0)) return 0;
  const ratio = Number(budget.spentUsd) / Number(budget.capUsd);
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

/** `opencode-go/mimo-v2.6-flash — $0.14 in / $0.28 out per 1M tokens`. */
export function modelOptionText(candidate) {
  if (!candidate) return "";
  const marker = candidate.paid ? "" : " (free)";
  return `${candidate.id}${marker} — ${priceText(candidate.price)}`;
}

/** Who is using the thread right now, or that nobody is. */
export function currentModelText(view) {
  if (!view || view.current === null || view.current === undefined) {
    return "No model is attached yet. Add a provider key, run the check, then choose a model.";
  }
  const current = view.current;
  const marker = current.paid ? "" : " (free)";
  return `Using ${current.id}${marker} — ${priceText(current.price)}.`;
}

/** The allowlist's three buckets, in words, each line one entry. */
export function allowlistLines(view) {
  const allowlist = view?.allowlist ?? { allowed: [], unverified: [], dropped: [] };
  const lines = [];
  for (const entry of allowlist.allowed ?? []) lines.push({ kind: "allowed", text: `${entry.id}: usable` });
  for (const entry of allowlist.unverified ?? []) {
    const why =
      entry.reason === "tool_call_missing"
        ? "it never made the probe tool call"
        : entry.reason === "inconclusive"
          ? "the last check was inconclusive"
          : "it has never been checked";
    lines.push({ kind: "unverified", text: `${entry.id}: not usable — ${why}` });
  }
  for (const entry of allowlist.dropped ?? []) {
    const why =
      entry.status === "deprecated"
        ? "the provider deprecated it"
        : entry.status === "unauthorized"
          ? "the provider rejected the key"
          : entry.status === "not_found"
            ? "the provider no longer lists it"
            : entry.status;
    lines.push({ kind: "dropped", text: `${entry.id}: dropped — ${why}` });
  }
  return lines;
}

/**
 * The last probe as one line, plus the spend exception. `results` carry their own
 * `usage` (the probe's calls are outside `harness.usage()`), and the plan says to
 * state that rather than fold it into the budget.
 */
export function probeText(probe) {
  if (!probe || probe.results.length === 0) {
    return "No check has run yet. Checking uses one small request per model and is not counted in the monthly budget.";
  }
  const checked = new Date(probe.checkedAt);
  const when = Number.isNaN(checked.getTime()) ? probe.checkedAt : checked.toISOString();
  const cost = probe.results.reduce((sum, result) => sum + (result.usage?.cost ?? 0), 0);
  return (
    `Checked ${when}: ${probe.results.length} model(s), ${money(cost)} spent. ` +
    "Probe spend is not counted in the monthly budget."
  );
}

/** One probe result line: model, verdict, latency. */
export function probeResultLines(probe) {
  return (probe?.results ?? []).map((result) => ({
    id: result.id,
    text: `${result.id}: ${result.status}${result.toolCall ? " (tool call ok)" : ""}, ${Math.round(result.latencyMs)} ms`,
    status: result.status,
  }));
}

/** The provider-key body; `null` clears the stored key. */
export function providerKeyBody(provider, key) {
  return { provider, key: key === "" ? null : key };
}

/** The picker's body: one `provider/model` id. */
export function modelChoiceBody(id) {
  return { model: id };
}

/** The budget write's body: the revision the caller read and the cap. */
export function budgetBody(rev, capUsd) {
  return { rev, capUsd };
}

/**
 * The cap field's value as a number, or `undefined` for something the server
 * would refuse. Whole cents only, matching `isAgentBudget` (§11.3).
 */
export function parseCapInput(value) {
  const text = String(value ?? "").trim();
  if (text === "") return undefined;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 10_000) return undefined;
  if (Math.round(number * 100) !== number * 100) return undefined;
  return number;
}
