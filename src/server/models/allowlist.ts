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
// Three things this deliberately does *not* do:
//   * it does not treat "reachable" as "usable" — PLAN §11.2 requires a live
//     tool-calling probe, so `ok` without a tool call is unverified, not allowed;
//   * it does not let an unknown status *resurrect* a model — a 410 stays dropped
//     through a later network blip, or a revoked key would quietly return to the
//     picker;
//   * it does not forget a model just because this run did not include it — the
//     candidate list can narrow (the picker lets the owner filter) and the cache
//     must survive that.
//
// The superset of results this returns is not the persisted form. That is
// `ModelProbeCache` in `cache.ts`, which is what P1-05 writes and P4-08 reads;
// this module derives its view from it.

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
  /** Effective status: the cached one when this run was inconclusive. */
  status: ProbeStatus;
  toolCall: boolean;
  /** When the model was last *attempted*, successful or not. */
  checkedAt: string;
  /** When it was last confirmed usable (`ok` + tool call). Absent if never. */
  verifiedAt?: string;
}

export interface Allowlist {
  /** Usable now: probe `ok` **and** a real tool call. */
  allowed: AllowlistEntry[];
  /** Neither usable nor excluded; `reason` says which, so the UI need not guess. */
  unverified: Array<{ entry: AllowlistEntry; reason: UnverifiedReason }>;
  /** Excluded, with the status that excluded it. */
  dropped: AllowlistEntry[];
}

function entryOf(result: ProbeResult, overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    id: result.id,
    status: result.status,
    toolCall: result.toolCall,
    checkedAt: result.checkedAt,
    ...overrides,
  };
}

/** Last result wins, so a caller cannot produce duplicate buckets by repeating an id. */
function byId(results: readonly ProbeResult[]): Map<string, ProbeResult> {
  const map = new Map<string, ProbeResult>();
  for (const result of results) map.set(result.id, result);
  return map;
}

/**
 * Merge a fresh probe over the previous one.
 *
 * - A dropping status wins over any history: 410 means gone, even if it worked
 *   yesterday.
 * - `ok` wins over a previous drop: models come back.
 * - An unknown status inherits the previous verdict, whichever way it went:
 *   `ok` keeps the model usable, `deprecated` keeps it out.
 * - A model in `previous` but absent from `fresh` keeps its previous bucket —
 *   a narrowed candidate list must not erase the cache.
 */
export function resolveAllowlist(
  previous: readonly ProbeResult[],
  fresh: readonly ProbeResult[],
): Allowlist {
  const history = byId(previous);
  const now = byId(fresh);
  const empty: Allowlist = { allowed: [], unverified: [], dropped: [] };

  for (const [id, result] of now) {
    const last = history.get(id);

    if (DROPPING_STATUSES.has(result.status)) {
      empty.dropped.push(entryOf(result));
      continue;
    }

    const unknown = result.status !== "ok";
    if (unknown && last) {
      // Inherit the verdict, keep the attempt time: `checkedAt` says when we
      // last asked, `verifiedAt` says when the answer was last a real yes.
      const inherited = entryOf(result, {
        status: last.status,
        toolCall: last.toolCall,
        checkedAt: result.checkedAt,
        verifiedAt: last.status === "ok" && last.toolCall ? last.checkedAt : undefined,
      });
      if (DROPPING_STATUSES.has(inherited.status)) empty.dropped.push(inherited);
      else if (inherited.status === "ok" && inherited.toolCall) empty.allowed.push(inherited);
      else empty.unverified.push({ entry: inherited, reason: "inconclusive" });
      continue;
    }

    if (result.status === "ok") {
      if (result.toolCall) {
        empty.allowed.push(
          entryOf(result, {
            verifiedAt: result.checkedAt,
          }),
        );
      } else {
        empty.unverified.push({ entry: entryOf(result), reason: "tool_call_missing" });
      }
      continue;
    }

    // Unknown with no history at all.
    empty.unverified.push({ entry: entryOf(result), reason: "inconclusive" });
  }

  for (const [id, last] of history) {
    if (now.has(id)) continue;
    if (DROPPING_STATUSES.has(last.status)) {
      empty.dropped.push(entryOf(last));
    } else if (last.status === "ok" && last.toolCall) {
      empty.allowed.push(
        entryOf(last, {
          verifiedAt: last.status === "ok" && last.toolCall ? last.checkedAt : undefined,
        }),
      );
    } else {
      empty.unverified.push({ entry: entryOf(last), reason: "never_probed" });
    }
  }

  return empty;
}
