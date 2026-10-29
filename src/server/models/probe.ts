// Startup model probe: one bounded request per candidate model, recorded in the
// shape P0-05 specifies. The probe exists because the catalog is not a promise —
// `minimax-m3.1-flash-free` was still listed after it started returning 410.
//
// Two halves, deliberately separated so the interesting half is testable offline:
//   * `runProbe()` decides what a result *means* (status, tool call, latency) and
//     takes an injected `ProbeCall`, so the suite runs with no network and no keys.
//   * `createPiAiProbeCall(models)` is the only code that talks to a provider. The
//     caller owns the `Models` collection, and therefore credentials and catalog:
//     Pupkeep keeps keys in `~/.pupkeep/secrets.json` (P1-05), never in the
//     environment, so a default that read `process.env` would be the wrong seam.
//
// IMPORTANT — how pi-ai reports failure. `Models.completeSimple()` does not reject
// on an HTTP error or an abort; every adapter catches, records `stopReason`
// (`"error"` or `"aborted"`) plus `errorMessage`, and *resolves* the message. So a
// probe that only inspects thrown errors records a hung provider as `ok` and a
// 410-dead model as `ok` — both were true of the first version of this file, and
// the tests agreed with it because they modelled a rejection contract the runtime
// never exhibits. Map from the message, and treat the `catch` as a fallback for
// errors thrown before any message exists.

import type { Api, AssistantMessage, Context, Model, Tool } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";

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
  /** Redacted, bounded text from the provider. Never a key, never a full URL. */
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
  /**
   * Optional sweep-level cancel, so a boot budget can stop the whole probe
   * without waiting out one model's timeout. Composed with the per-model
   * deadline; a cancelled probe is recorded as `timeout` (unknown, kept).
   */
  signal?: AbortSignal;
  /** Clock, injected so `checkedAt`/latency are deterministic in tests. */
  now?: () => number;
  /** Runs targets concurrently. Default 4; the probe must not stampede a provider. */
  concurrency?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_TOKENS = 64;

/**
 * Map a provider failure to a status. Only `deprecated`, `not_found` and
 * `unauthorized` remove a model; everything unrecognised is `network`, which is
 * "unknown" and keeps the last-known-good entry.
 */
export function statusFromError(error: unknown): ProbeStatus {
  if (isAbort(error)) return "timeout";

  const status = httpStatus(error);
  if (status !== undefined) return fromCode(status);

  // Provider adapters that report the code only in text. Kept narrow on purpose:
  // a bare "\b410\b" matches model ids (`mimo-v4.1-410`) and URL paths
  // (`/v1/401`), which would silently drop the wrong model.
  const text = messageOf(error);
  if (!text) return "network";

  // Pi AI formats a provider failure in three shapes (see `formatProviderError`):
  //   "410: {body}"                    — openai-completions
  //   "Some API error (410): {body}"   — openai-responses, azure-openai-responses
  //   a bare message.
  // The parenthesised form matters: without it, a 410 from those adapters is
  // `network` (kept forever) unless the body happens to say "deprecated".
  const leading = /^\s*(?:error[: ]\s*)?(?:http\s+|status\s*)?(\d{3})\b/i.exec(text);
  if (leading) return fromCode(Number(leading[1]));
  const parenthesised = /^\s*[^0-9\s][^()]{0,60}\(\s*(\d{3})\s*\)\s*[:!]/i.exec(text);
  if (parenthesised) return fromCode(Number(parenthesised[1]));

  if (/\b(?:model\s*deprecated|model_deprecated|410\s+gone)\b/i.test(text)) return "deprecated";
  if (/\b(?:too\s*many\s*requests|rate[\s-]?limit(?:ed)?)\b/i.test(text)) return "rate_limited";

  const coded = /\b(?:http|status(?:\s*code)?|error\s*code)\s*[:=]?\s*(4\d\d|5\d\d)\b/i.exec(text);
  if (coded) return fromCode(Number(coded[1]));
  return "network";
}

function fromCode(status: number): ProbeStatus {
  if (status === 410) return "deprecated";
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  return "network";
}

function messageOf(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : undefined;
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

/**
 * The status of a *resolved* message — which is how pi-ai reports failure.
 * `aborted` is our own timeout; `error` carries the provider's code in
 * `errorMessage`; anything else completed and is `ok` as far as reachability
 * goes (whether it could call the tool is a separate field, gated by the
 * allowlist).
 */
export function statusFromMessage(message: AssistantMessage): ProbeStatus {
  if (message.stopReason === "aborted") return "timeout";
  if (message.stopReason === "error") {
    const detail = message.errorMessage ?? "";
    return detail ? statusFromError(new Error(detail)) : "network";
  }
  // Not finished is not "reachable": a deferred or pending resolution says
  // nothing about this model yet, so it is unknown rather than ok.
  if (message.stopReason === "deferred" || message.stopReason === "pending") return "network";
  return "ok";
}

function reasonOf(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(signal ? "probe cancelled" : "probe timeout");
  error.name = "TimeoutError";
  return error;
}

function timeoutError(timeoutMs: number): Error {
  // Named, so a caller that inspects the reason sees a timeout rather than a
  // generic abort. (fetch would reject with this value verbatim.)
  const error = new Error(`probe timed out after ${timeoutMs} ms`);
  error.name = "TimeoutError";
  return error;
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
  const external = options.signal;
  const cancel = () => controller.abort(reasonOf(external));
  if (external) {
    if (external.aborted) cancel();
    else external.addEventListener("abort", cancel, { once: true });
  }

  const base = {
    id: `${target.provider}/${target.model}`,
    provider: target.provider,
    model: target.model,
    checkedAt: new Date(started).toISOString(),
  };

  const context: Context = {
    systemPrompt:
      "You are answering a capability check. Do exactly what the user asks and nothing else.",
    messages: [{ role: "user", content: PROBE_PROMPT, timestamp: started }],
    tools: [PROBE_TOOL],
  };

  // The bound is structural: even a provider adapter that ignores the signal and
  // never settles loses the race. The timer is not unref'd — while a probe is in
  // flight the process should stay alive to record its result, and `finally`
  // clears it either way.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  // A call that ignores its signal still loses to a cancel; the deadline already
  // covers the timer case.
  const cancelled = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) reject(reasonOf(controller.signal));
    else controller.signal.addEventListener("abort", () => reject(reasonOf(controller.signal)), { once: true });
  });

  try {
    const message = await Promise.race([
      call(target, context, controller.signal),
      deadline,
      cancelled,
    ]);
    return {
      ...base,
      status: statusFromMessage(message),
      toolCall: probesToolCall(message),
      latencyMs: Math.max(0, now() - started),
      usage: usageOf(message),
      ...(message.errorMessage ? { detail: redactDetail(message.errorMessage) } : {}),
    };
  } catch (error) {
    // Reached when the provider throws before producing a message, or when the
    // deadline wins. An abort we caused is a timeout regardless of error shape.
    const status = controller.signal.aborted ? "timeout" : statusFromError(error);
    return {
      ...base,
      status,
      toolCall: false,
      latencyMs: Math.max(0, now() - started),
      detail: redactDetail(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    external?.removeEventListener("abort", cancel);
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
 * The real call. The caller supplies the `Models` collection — that is where
 * credentials live (Pupkeep's come from `secrets.json` via P1-05) and where the
 * catalog comes from, so this function deliberately has no default: an env-keyed
 * default would be the wrong seam for this app.
 *
 * Throws `ModelMissingError` when the catalog no longer has the model, which the
 * probe records as `not_found`.
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

export function createPiAiProbeCall(models: Models): ProbeCall {
  return async (target, context, signal) => {
    const model: Model<Api> | undefined = models.getModel(target.provider, target.model);
    if (!model) throw new ModelMissingError(target);
    return models.completeSimple(model, context, {
      maxTokens: DEFAULT_MAX_TOKENS,
      signal,
    });
  };
}
