// Turning probe results into an allowlist. The rule P0-05 fixed:
//
//   drop only `deprecated`, `not_found`, `unauthorized`;
//   treat `rate_limited` / `network` / `timeout` as *unknown* and keep the
//   last-known-good entry.
//
// The reason is asymmetry: a wrong drop removes a working model from the picker
// for the rest of the month, while a wrong keep costs one failed request that the
// UI can explain. Everything here is pure so the table in the tests is the spec.

import type { ProbeResult, ProbeStatus } from "./probe.ts";

/** The only statuses that may remove a model. */
export const DROPPING_STATUSES: ReadonlySet<ProbeStatus> = new Set<ProbeStatus>([
  "deprecated",
  "not_found",
  "unauthorized",
]);

export interface Allowlist {
  /** Usable now: probed `ok`, or unknown with a last-known-good `ok`. */
  allowed: string[];
  /** Unknown status with no history — allowed, but the UI should say "unchecked". */
  unverified: string[];
  dropped: Array<{ id: string; status: ProbeStatus }>;
}

/**
 * Merge a fresh probe over the previous one.
 *
 * - A dropping status wins over any history: 410 means gone, even if it worked
 *   yesterday.
 * - `ok` wins over a previous drop: models come back.
 * - Unknown statuses never resurrect or remove anything; they inherit history.
 */
export function resolveAllowlist(
  previous: readonly ProbeResult[],
  fresh: readonly ProbeResult[],
): Allowlist {
  const history = new Map(previous.map((result) => [result.id, result]));
  const allowed: string[] = [];
  const unverified: string[] = [];
  const dropped: Allowlist["dropped"] = [];

  for (const result of fresh) {
    if (DROPPING_STATUSES.has(result.status)) {
      dropped.push({ id: result.id, status: result.status });
      continue;
    }
    if (result.status === "ok") {
      allowed.push(result.id);
      continue;
    }
    // Unknown: rate_limited, network, timeout — or any status added later.
    if (history.get(result.id)?.status === "ok") allowed.push(result.id);
    else unverified.push(result.id);
  }

  return { allowed, unverified, dropped };
}
