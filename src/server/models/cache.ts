// The persisted form of a probe run: what P1-05 writes to `~/.pupkeep/models.json`
// and what P4-08 reads to seed the picker. Naming it here matters — P1-05 is
// upstream of P4-08, and once a file is written the shape is frozen. It is
// deliberately the same per-model table P0-05 documented, wrapped in a version and
// a run timestamp, and it is *not* the `Allowlist`, which is a derived view with
// reasons that cannot be reconstructed from a file.

import type { ProbeResult, ProbeStatus } from "./probe.ts";

export const PROBE_CACHE_VERSION = 1;

export interface ModelProbeCache {
  version: typeof PROBE_CACHE_VERSION;
  /** When the run that produced `results` finished. */
  checkedAt: string;
  /** One entry per model attempted; duplicates are not expected. */
  results: ProbeResult[];
}

const STATUSES: ReadonlySet<string> = new Set<ProbeStatus>([
  "ok",
  "deprecated",
  "not_found",
  "unauthorized",
  "rate_limited",
  "network",
  "timeout",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResult(value: unknown): ProbeResult | undefined {
  if (!isRecord(value)) return undefined;
  const { id, provider, model, status, toolCall, latencyMs, checkedAt, usage, detail } = value;
  if (typeof id !== "string" || !id.includes("/")) return undefined;
  if (typeof provider !== "string" || typeof model !== "string") return undefined;
  if (typeof status !== "string" || !STATUSES.has(status)) return undefined;
  if (typeof toolCall !== "boolean") return undefined;
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) return undefined;
  if (typeof checkedAt !== "string") return undefined;

  const result: ProbeResult = {
    id,
    provider,
    model,
    status: status as ProbeStatus,
    toolCall,
    latencyMs,
    checkedAt,
  };
  if (isRecord(usage)) {
    const { input, output, cacheRead, cacheWrite, cost } = usage;
    if ([input, output, cacheRead, cacheWrite, cost].every((n) => typeof n === "number")) {
      result.usage = {
        input: input as number,
        output: output as number,
        cacheRead: cacheRead as number,
        cacheWrite: cacheWrite as number,
        cost: cost as number,
      };
    }
  }
  if (typeof detail === "string") result.detail = detail;
  return result;
}

/**
 * Parse a cache file defensively. Returns `undefined` for anything this version
 * does not understand — a hand-edited or truncated file must not stop a boot, and
 * a version bump must be an explicit migration rather than silent garbage.
 */
export function parseModelProbeCache(raw: unknown): ModelProbeCache | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.version !== PROBE_CACHE_VERSION) return undefined;
  if (typeof raw.checkedAt !== "string") return undefined;
  if (!Array.isArray(raw.results)) return undefined;

  const results: ProbeResult[] = [];
  for (const item of raw.results) {
    const parsed = parseResult(item);
    if (!parsed) return undefined; // a half-valid file is not a cache
    results.push(parsed);
  }
  return { version: PROBE_CACHE_VERSION, checkedAt: raw.checkedAt, results };
}

export function toModelProbeCache(results: readonly ProbeResult[], checkedAt: string): ModelProbeCache {
  return { version: PROBE_CACHE_VERSION, checkedAt, results: [...results] };
}
