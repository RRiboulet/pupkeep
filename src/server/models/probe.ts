// Startup model probe: one bounded request per candidate model, recorded in the
// shape P0-05 specifies. The probe exists because the catalog is not a promise —
// `minimax-m3.1-flash-free` was still listed after it started returning 410.
//
// Two halves, deliberately separated so the interesting half is testable offline:
//   * `runProbes()` decides what a result *means* (status, tool call, latency) and
//     takes an injected `ProbeCall`, so the suite runs with no network and no keys.
//   * `createPiAiProbeCall()` is the only code that talks to a provider.
//
// It uses the modern pi-ai surface (`builtinModels()` + `Models.completeSimple`),
// not the deprecated `compat` shim, so P4-08 does not have to rewrite it.

import type { Api, AssistantMessage, Context, Model, Tool } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/** Statuses recorded per model. Only the dropping ones may remove a model. */
export type ProbeStatus =
  | "ok"
  | "deprecated"
  | "not_found"
  | "unauthorized"
  | "rate_limited"
  | "network"
  | "timeout";

export interface ProbeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ProbeResult {
  /** `${provider}/${model}` — stable across runs so it can key the cache. */
  id: string;
  provider: string;
  model: string;
  status: ProbeStatus;
  /** True only when the model made a real tool call with the expected argument. */
  toolCall: boolean;
  latencyMs: number;
  usage?: ProbeUsage;
  checkedAt: string;
  /** Redacted, bounded error text. Never a key, never a full URL with a query. */
  detail?: string;
}

export interface ProbeTarget {
  provider: string;
  model: string;
}

/**
 * The app's tool schema, borrowed from the coding agent so the probe exercises
 * the same declaration path the product agent will use: a TypeBox object with a
 * single literal argument. A model that cannot emit this is not usable for tools.
 */
export const PROBE_TOOL_NAME = "pupkeep_probe";

export const PROBE_TOOL: Tool = {
  name: PROBE_TOOL_NAME,
  description: "Health check for the Pupkeep agent. Call this tool exactly once.",
  parameters: Type.Object(
    { status: Type.Literal("ok") },
    { additionalProperties: false, description: "Always ok." },
  ),
};

export const PROBE_PROMPT =
  "This is a capability check. Call the pupkeep_probe tool once with status ok, then stop.";

/** A provider call, injectable so tests need neither network nor keys. */
export type ProbeCall = (
  target: ProbeTarget,
  context: Context,
  signal: AbortSignal,
) => Promise<AssistantMessage>;

export interface ProbeOptions {
  /** Per-model timeout. Default 15 s — one turn, as P0-05 recorded. */
  timeoutMs?: number;
  /** Clock, injected so `checkedAt`/latency are deterministic in tests. */
  now?: () => number;
  /** Runs targets concurrently. Default 4; the probe must not stampede a provider. */
  concurrency?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_TOKENS = 64;

/** Map an HTTP-ish failure to a status. Anything unrecognised is `network`. */
export function statusFromError(error: unknown): ProbeStatus {
  if (isAbort(error)) return "timeout";
  const status = httpStatus(error);
  if (status === 410) return "deprecated";
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status !== undefined && status >= 500) return "network";
  return "network";
}

function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

function httpStatus(error: unknown): number | undefined {
  const direct = (error as { status?: unknown } | null)?.status;
  if (typeof direct === "number") return direct;
  const nested = (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof nested === "number") return nested;
  // Providers are inconsistent; fall back to the message, which is the only
  // signal pi-ai surfaces for some adapters ("410 ModelDeprecated", "429 Too Many").
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string") {
    const match = /\b(4\d\d|5\d\d)\b/.exec(message);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** Strip anything that could be a credential or a signed URL before recording it. */
export function redactDetail(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9-_]{8,}/g, "[key]")
    .replace(/\b[A-Za-z0-9-_]{32,}\b/g, "[redacted]")
    .replace(/[?&](?:key|token|api_key|apikey|sig|signature)=[^\s&"']+/gi, "[query]")
    .slice(0, 200);
}

function usageOf(message: AssistantMessage | undefined): ProbeUsage | undefined {
  const usage = message?.usage;
  if (!usage) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: usage.cost?.total ?? 0,
  };
}

/** Did the model actually call our tool with `{status:"ok"}`? */
export function probesToolCall(message: AssistantMessage | undefined): boolean {
  for (const block of message?.content ?? []) {
    if (block.type !== "toolCall" || block.name !== PROBE_TOOL_NAME) continue;
    const args = block.arguments as { status?: unknown } | undefined;
    if (args?.status === "ok") return true;
  }
  return false;
}

export async function runProbe(
  target: ProbeTarget,
  call: ProbeCall,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("probe timeout")), timeoutMs);
  timer.unref?.();

  const context: Context = {
    systemPrompt:
      "You are answering a capability check. Do exactly what the user asks and nothing else.",
    messages: [{ role: "user", content: PROBE_PROMPT, timestamp: started }],
    tools: [PROBE_TOOL],
  };

  const base = {
    id: `${target.provider}/${target.model}`,
    provider: target.provider,
    model: target.model,
    checkedAt: new Date(started).toISOString(),
  };

  try {
    const message = await call(target, context, controller.signal);
    return {
      ...base,
      status: message.stopReason === "error" ? "network" : "ok",
      toolCall: probesToolCall(message),
      latencyMs: Math.max(0, now() - started),
      usage: usageOf(message),
      ...(message.errorMessage ? { detail: redactDetail(message.errorMessage) } : {}),
    };
  } catch (error) {
    return {
      ...base,
      status: statusFromError(error),
      toolCall: false,
      latencyMs: Math.max(0, now() - started),
      detail: redactDetail(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every target, bounded. Results come back in input order. */
export async function runProbes(
  targets: readonly ProbeTarget[],
  call: ProbeCall,
  options: ProbeOptions = {},
): Promise<ProbeResult[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, targets.length || 1));
  const results: ProbeResult[] = new Array(targets.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= targets.length) return;
      results[index] = await runProbe(targets[index]!, call, options);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/**
 * The real call. Resolves the model from pi-ai's builtin catalog and asks it the
 * one question. Throws `ModelMissingError` when the catalog no longer has it,
 * which the probe records as `not_found`.
 */
export class ModelMissingError extends Error {
  readonly status = 404;
  readonly target: ProbeTarget;
  // No parameter property: `erasableSyntaxOnly` keeps this file runnable by
  // node's type stripper, and constructor parameter properties are not erasable.
  constructor(target: ProbeTarget) {
    super(`model not in the catalog: ${target.provider}/${target.model}`);
    this.name = "ModelMissingError";
    this.target = target;
  }
}

export function createPiAiProbeCall(): ProbeCall {
  const models = builtinModels();
  return async (target, context, signal) => {
    const model: Model<Api> | undefined = models.getModel(target.provider, target.model);
    if (!model) throw new ModelMissingError(target);
    return models.completeSimple(model, context, {
      maxTokens: DEFAULT_MAX_TOKENS,
      signal,
    });
  };
}
