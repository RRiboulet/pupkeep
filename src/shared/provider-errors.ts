// Provider-failure classification, shared rather than buried in the model probe.
//
// P4-08 needs exactly this mapping twice: once to build the startup allowlist
// (P1-03's probe) and once to decide what "Retry with fallback model" means when a
// live turn fails (PLAN §11.3). Two copies would drift, and the one that drifted
// would be the one behind a UI button.
//
// The important fact this encodes: Pi AI **resolves** provider failures instead of
// throwing them. Each adapter catches, sets `stopReason: "aborted" | "error"` plus
// `errorMessage`, and calls `stream.end()`. A classifier that only inspects thrown
// errors therefore reports a hung provider as healthy and a 410-dead model as
// alive — which is exactly what happened to the first version of the probe.

/** Statuses the app distinguishes. Only the dropping ones remove a model. */
export type ProviderFailureStatus =
  | "ok"
  | "deprecated"
  | "not_found"
  | "unauthorized"
  | "rate_limited"
  | "network"
  | "timeout";

/** Map an HTTP-ish code to a status. */
export function fromCode(status: number): ProviderFailureStatus {
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

/**
 * Classify a thrown error. Kept narrow on purpose: a bare `\b410\b` matches model
 * ids (`mimo-v4.1-410`) and URL paths (`/v1/401`), which would silently drop or
 * hide the wrong model.
 */
export function statusFromError(error: unknown): ProviderFailureStatus {
  if (isAbort(error)) return "timeout";

  const status = httpStatus(error);
  if (status !== undefined) return fromCode(status);

  const text = messageOf(error);
  if (!text) return "network";

  // Pi AI formats provider failures as `${status}: ${body}` or
  // `Some API error (410): ${body}` (see `formatProviderError`); the parenthesised
  // form is what openai-responses and azure-openai-responses use.
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

/**
 * Classify a *resolved* assistant message. `deferred`/`pending` are "not finished",
 * which says nothing about the model, so they are unknown rather than ok.
 */
export function statusFromMessage(message: {
  stopReason: string;
  errorMessage?: string | undefined;
}): ProviderFailureStatus {
  if (message.stopReason === "aborted") return "timeout";
  if (message.stopReason === "error") {
    const detail = message.errorMessage ?? "";
    return detail ? statusFromError(new Error(detail)) : "network";
  }
  if (message.stopReason === "deferred" || message.stopReason === "pending") return "network";
  return "ok";
}
