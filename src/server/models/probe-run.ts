// The live probe of the allowlist, and its one cache write (PLAN §11.2,
// §16 P4-08).
//
// P1-03 built the probe itself (`runProbes`, `createPiAiProbeCall`) and the
// allowlist rules (`resolveAllowlist`); P4-08 is what finally *runs* it with the
// app's own `Models` collection and the household's keys:
//
//   * the candidates are §11.2's live rows only. The two free models OpenCode Go
//     deprecated on 2026-10-28 are not probed — a known-410 model wastes a
//     provider call to re-learn what the plan already recorded;
//   * only providers that have a stored key are probed. A missing key is not a
//     verdict about the model, and recording `unauthorized` for every row would
//     **drop the whole allowlist** (unauthorized is a dropping status), so the
//     run skips them and the previous cache stands;
//   * the probe is bounded (one turn, ~15 s per model, four at a time) and its
//     results are cached as `models.json` in P1-05's `{version, checkedAt,
//     results}` shape. A later run never clobbers a newer one: the cache is
//     compared by `checkedAt`.
//
// Probe spend is outside `harness.usage()` by construction — these calls go
// through `Models.completeSimple` directly, not through Pi Durable — so the
// results carry their own `usage` and the UI states the exception (§11.2,
// §11.3). It is never added to the budget.

import type { Models } from "@earendil-works/pi-ai";
import type { JsonFileStore } from "../json-file.ts";
import { toModelProbeCache, type ModelProbeCache } from "./cache.ts";
import { resolveAllowlist, type Allowlist } from "./allowlist.ts";
import { createPiAiProbeCall, runProbes, type ProbeResult, type ProbeTarget } from "./probe.ts";

/**
 * §11.2's candidates, in the plan's table order. The deprecated rows are listed
 * here only as a comment so the omission is deliberate:
 * `minimax-m3.1-flash-free` and `longcat-2.5-preview-free` returned 410 on
 * 2026-10-28, and `minimax/minimax-m3.1-flash:free` is retired on OpenRouter.
 */
export const PROBE_CANDIDATES: readonly ProbeTarget[] = Object.freeze([
  { provider: "opencode-go", model: "mimo-v2.6-flash" },
  { provider: "opencode-go", model: "beam-free" },
  { provider: "opencode-go", model: "deepseek-v4.1-flash" },
  { provider: "opencode-go", model: "glm-5.3-flash" },
  { provider: "opencode-go", model: "qwen3.8-flash" },
  { provider: "openrouter", model: "openrouter/free" },
]);

export interface ProbeRun {
  /** When the run finished; the cache's own stamp. */
  checkedAt: string;
  /** One result per probed model (empty when no provider has a key). */
  results: ProbeResult[];
  /** The allowlist after merging this run over the cached history. */
  allowlist: Allowlist;
  /** Models this run skipped because their provider has no key. */
  skipped: ProbeTarget[];
  /** How many providers were probed. */
  providers: string[];
}

/**
 * How long a verified verdict is trusted for the **boot** probe. A phone that
 * reboots often must not re-spend a provider call per paid candidate every time;
 * the Settings "check now" ignores this and probes everything the owner asked
 * for. §11.4's cost rule, applied to the one automatic model call the plan
 * sanctions.
 */
export const PROBE_FRESH_MS = 6 * 60 * 60 * 1000;

export interface ProbeRunOptions {
  readonly models: Models;
  /** Providers with a stored key; everything else is skipped. */
  readonly configured: ReadonlySet<string>;
  /** The previous results, to merge over (`resolveAllowlist`'s history). */
  readonly previous?: readonly ProbeResult[];
  /** Per-model timeout; the boot run uses the default (15 s). */
  readonly timeoutMs?: number;
  /** Whole-run cancel, so a boot can stop waiting on a hung provider. */
  readonly signal?: AbortSignal;
  /** Clock, injected by tests. */
  readonly now?: () => number;
  readonly candidates?: readonly ProbeTarget[];
  /**
   * Skip a candidate whose cached verdict is `ok` with a tool call and newer
   * than this. The boot probe passes `PROBE_FRESH_MS`; a manual run passes
   * nothing, because the owner asked for a check.
   */
  readonly freshWithinMs?: number;
}

/**
 * Run one probe and derive the allowlist. Pure with respect to storage: the
 * caller decides whether to cache (the startup run does; a test may not).
 */
export async function probeModels(options: ProbeRunOptions): Promise<ProbeRun> {
  const now = options.now ?? Date.now;
  const all = options.candidates ?? PROBE_CANDIDATES;
  const previous = options.previous ?? [];
  // A fresh `ok` + tool call is trusted for the freshness window (boot only).
  const fresh = options.freshWithinMs === undefined ? undefined : now() - options.freshWithinMs;
  const trusted = new Set(
    fresh === undefined
      ? []
      : previous
          .filter((result) => result.status === "ok" && result.toolCall)
          .filter((result) => {
            const checked = Date.parse(result.checkedAt);
            return Number.isFinite(checked) && checked >= fresh;
          })
          .map((result) => result.id),
  );
  const candidates = all.filter((target) => !trusted.has(`${target.provider}/${target.model}`));
  const targets = candidates.filter((target) => options.configured.has(target.provider));
  const skipped = candidates.filter((target) => !options.configured.has(target.provider));
  const results =
    targets.length === 0
      ? []
      : await runProbes(targets, createPiAiProbeCall(options.models), {
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          now,
        });
  return {
    checkedAt: new Date(now()).toISOString(),
    results,
    allowlist: resolveAllowlist(previous, results),
    skipped,
    providers: [...new Set(targets.map((target) => target.provider))],
  };
}

/**
 * Probe and persist. The write is guarded by `checkedAt` so a slow run that
 * started earlier cannot overwrite a newer run's cache (two Settings tabs, or a
 * boot probe still finishing when the owner presses "check now").
 */
export async function probeAndCache(
  cache: JsonFileStore<ModelProbeCache>,
  options: ProbeRunOptions,
): Promise<ProbeRun> {
  const previous = options.previous ?? (await cache.read()).results;
  const run = await probeModels({ ...options, previous });
  // A run that probed nothing writes nothing (an all-providers-skipped press must
  // not touch the cache). A run that probed *some* models keeps the others'
  // verdicts: a provider whose key was cleared or whose candidate was fresh must
  // not lose the last-known-good the allowlist rules promise to remember.
  if (run.results.length > 0) {
    const merged = new Map(previous.map((result) => [result.id, result]));
    for (const result of run.results) merged.set(result.id, result);
    const next = toModelProbeCache([...merged.values()], run.checkedAt);
    await cache.update((current) => (current.checkedAt > next.checkedAt ? current : next));
  }
  return run;
}

/**
 * The allowlist a reader sees: the cache merged with itself (so a model the
 * candidate list no longer names keeps its verdict, §11.2's "keep the
 * last-known-good") — the same view the last probe produced for the picker.
 */
export function allowlistOf(cache: ModelProbeCache): Allowlist {
  return resolveAllowlist([], cache.results);
}
