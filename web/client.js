// The browser's HTTP client: the half of the contract in PLAN §14.2.
//
// The file is `client.js`, not `api.js`, so it cannot be mistaken for the
// server's `/api/*` namespace (which the service worker never caches) and does
// not trip the static-layer parity test that guards that namespace.
//
// Every mutation must carry `X-Pupkeep-Request: 1` and a JSON content type; the
// server refuses a request without them, and a cross-site form cannot set the
// header. Centralising it here is what keeps a future view from forgetting it.
//
// An HTTP failure is an ordinary answer, not an exception: the caller switches on
// `status` (a 409 stale profile is a UI state, not an error). Only a transport
// failure throws, because there is nothing to switch on.

export const REQUEST_HEADER = "X-Pupkeep-Request";
export const REQUEST_HEADER_VALUE = "1";

export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * GET or JSON mutation. Returns `{ status, ok, body }`; `body` is the parsed
 * JSON answer, or `undefined` when there was none.
 */
export async function requestJson(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = { Accept: "application/json", ...(options.headers ?? {}) };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (method !== "GET" && method !== "HEAD") headers[REQUEST_HEADER] = REQUEST_HEADER_VALUE;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  let response;
  try {
    response = await fetch(path, { method, headers, body, credentials: "same-origin" });
  } catch {
    throw new NetworkError("Could not reach Pupkeep. Check the connection and try again.");
  }

  const text = await response.text();
  let parsed;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

/**
 * A key for one intended save, so a double-tap or a retried request is the same
 * action rather than two revisions. `crypto.randomUUID` exists only in a secure
 * context, and the partner's daily Tailscale origin is plain HTTP, so the
 * fallback is the normal path there.
 */
export function newIdempotencyKey() {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (crypto?.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let key = "";
    for (const byte of bytes) key += byte.toString(16).padStart(2, "0");
    return key;
  }
  // No Web Crypto at all: still unique enough to dedupe one double-tap.
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
