// Turning probe results into an allowlist. The rule P0-05 fixed:
//
//   drop only `deprecated`, `not_found`, `unauthorized`;
//   treat `rate_limited` / `network` / `timeout` as *unknown* and keep the
//   last-known-good entry.
//
// The reason is asymmetry: a wrong drop removes a working model from the picker
// for the rest of the month, while a wrong keep costs one failed request that the
// UI can explain. Everything here is pure so the table in the tests is the spec.
//
// Two things this deliberately does *not* do:
//   * it does not treat "reachable" as "usable" — PLAN §11.2 requires a live
//     tool-calling probe, so `ok` without a tool call is unverified, not allowed;
//   * it does not forget a model just because this run did not include it — the
//     candidate list can narrow (the picker lets the owner filter) and the cache
//     must survive that.

import type { ProbeResult, ProbeStatus } from "./probe.ts";

/** The only statuses that may remove a model. */
export const DROPPING_STATUSES: ReadonlySet<ProbeStatus> = new Set<ProbeStatus>([
  "deprecated",
  "not_found",
  "unauthorized",
]);

/** Why a model is neither allowed nor dropped. */
export type UnverifiedReason =
  /** Never probed: no cached result and absent from this run. */
  | "never_probed"
  /** Probed, but the answer said nothing about usability (rate limit, network). */
  | "inconclusive"
  /** Reached the model, but it never made the tool call — unusable for tools. */
  | "tool_call_missing";

/** A model as the allowlist remembers it. */
export interface AllowlistEntry {
  id: string;
  status: ProbeStatus;
  toolCall: boolean;
  checkedAt: string;
}

export interface Allowlist {
  /** Usable now: probe `ok` **and** a real tool call. */
  allowed: AllowlistEntry[];
  /** Neither usable nor excluded; `reason` says which, so the UI need not guess. */
  unverified: Array<{ entry: AllowlistEntry; reason: UnverifiedReason }>;
  dropped: Array<{ entry: AllowlistEntry; status: ProbeStatus }>;
}

function entryOf(result: ProbeResult): AllowlistEntry {
  return {
    id: result.id,
    status: result.status,
    toolCall: result.toolCall,
    checkedAt: result.checkedAt,
  };
}

function classify(entry: AllowlistEntry, fresh: boolean): Allowlist {
  const empty: Allowlist = { allowed: [], unverified: [], dropped: [] };

  if (DROPPING_STATUSES.has(entry.status)) {
    empty.dropped.push({ entry, status: entry.status });
    return empty;
  }

  if (entry.status === "ok") {
    if (entry.toolCall) empty.allowed.push(entry);
    else empty.unverified.push({ entry, reason: "tool_call_missing" });
    return empty;
  }

  // Unknown: rate_limited, network, timeout. A previous tool-call pass is enough
  // to keep it; otherwise it is inconclusive (this run) or never probed (cache).
  empty.unverified.push({ entry, reason: fresh ? "inconclusive" : "never_probed" });
  return empty;
}

/**
 * Merge a fresh probe over the previous one.
 *
 * - A dropping status wins over any history: 410 means gone, even if it worked
 *   yesterday.
 * - `ok` wins over a previous drop: models come back.
 * - Unknown statuses never resurrect or remove anything; they inherit history.
 * - A model in `previous` but absent from `fresh` keeps its previous bucket —
 *   a narrowed candidate list must not erase the cache.
 */
export function resolveAllowlist(
  previous: readonly ProbeResult[],
  fresh: readonly ProbeResult[],
): Allowlist {
  const history = new Map(previous.map((result) => [result.id, result]));
  const freshIds = new Set(fresh.map((result) => result.id));
  const outcomes: Allowlist[] = [];

  for (const result of fresh) {
    let { status, toolCall } = result;

    // Unknown on this run, but last-known-good says otherwise.
    if (
      !DROPPING_STATUSES.has(status) &&
      status !== "ok" &&
      history.get(result.id)?.status === "ok"
    ) {
      const last = history.get(result.id)!;
      // Keep the *known* half: a rate limit does not erase a working tool call.
      status = "ok";
      toolCall = last.toolCall;
    }

    outcomes.push(classify({ ...entryOf(result), status, toolCall }, true));
  }

  // Models the fresh run did not cover keep what the cache said about them.
  for (const previousResult of previous) {
    if (freshIds.has(previousResult.id)) continue;
    outcomes.push(classify(entryOf(previousResult), false));
  }

  return {
    allowed: outcomes.flatMap((outcome) => outcome.allowed),
    unverified: outcomes.flatMap((outcome) => outcome.unverified),
    dropped: outcomes.flatMap((outcome) => outcome.dropped),
  };
}
