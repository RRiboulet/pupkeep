// The one redaction implementation. Everything that writes a log line, an error
// detail or a Settings field goes through this, because the alternative — each
// module scrubbing what it remembers to scrub — is how an owner token ends up in
// `server.log` (PLAN §6.3, §14.4).
//
// Two rules, learned by being wrong twice:
//   * redact by *shape* and by *name*, not by parameter name alone. P1-06 has not
//     fixed the owner-link format, and a Web Push `auth` secret is exactly 22
//     characters, so a 24-character floor misses a real key while destroying every
//     ULID in the same log line.
//   * know when *not* to redact. A correlation id (`requestId`, `memberId`) is
//     what makes a log useful; callers mark those fields and `keepOpaque` lets
//     them through the catch-all while the named rules still apply.

const PARAM = "token|key|code|invite|secret|password|sig|signature|auth|apikey|api_key|topic";

const PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
  // Headers whose whole value is a credential.
  { pattern: /\b(authorization|cookie|set-cookie|x-api-key|api-key)\s*:\s*[^\n\r]+/gi, replace: "$1: [redacted]" },
  { pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: "Bearer [redacted]" },
  // Provider keys by prefix: sk-…, pk-…, rk-…
  { pattern: /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, replace: "[key]" },
  // A URL query value, whatever its length, when the name says it is a secret.
  {
    pattern: new RegExp(`([?&][A-Za-z0-9_]*(?:${PARAM})[A-Za-z0-9_]*=)([^&\\s"'<>#]+)`, "gi"),
    replace: "$1[redacted]",
  },
  // A JSON pair with a secret-shaped key: `"tokenHash": "…"`, `"keys":{"auth":"…"}`.
  {
    pattern: new RegExp(`("(?:[A-Za-z0-9_]*?(?:${PARAM})[A-Za-z0-9_]*)"\\s*:\\s*")[^"]*(")`, "gi"),
    replace: "$1[redacted]$2",
  },
  // `key=value` in free text, e.g. a logged error string.
  {
    pattern: new RegExp(`\\b([A-Za-z0-9_]*(?:${PARAM})[A-Za-z0-9_]*)\\s*[=:]\\s*(?!\\[redacted\\])([^\\s,;)}\\]'"]{4,})`, "gi"),
    replace: "$1=[redacted]",
  },
  // A token riding a known auth route, e.g. `/login/<token>`.
  { pattern: /(\/(?:login|invite|auth|join|s|session)\/)[A-Za-z0-9_-]{6,}/gi, replace: "$1[redacted]" },
  // A fragment only when it looks like a token; `#12` is a pull request number.
  { pattern: /#([A-Za-z0-9_~+/-]{12,})/g, replace: "#[redacted]" },
  // Catch-all for long opaque values, including standard base64 (`+`, `/`, `=`).
  { pattern: /[A-Za-z0-9+/=_-]{24,}/g, replace: "[redacted]" },
];

/** Patterns that must still apply when a caller asks to keep opaque values. */
const NAMED_RULES = PATTERNS.slice(0, -1);

export interface ScrubOptions {
  /**
   * Skip the long-opaque-value catch-all. Used for fields whose *name* marks them
   * as correlation ids: the named rules above still scrub them if they look like a
   * credential, but a 26-character ULID survives.
   */
  keepOpaque?: boolean;
}

/** Scrub secrets out of a single line. Idempotent. */
export function scrub(text: string, options: ScrubOptions = {}): string {
  let value = text;
  for (const { pattern, replace } of options.keepOpaque ? NAMED_RULES : PATTERNS) {
    value = value.replace(pattern, replace);
  }
  return value;
}

/**
 * Bounded, scrubbed text for a recorded `detail` field. Keeps the first 200
 * characters — enough to diagnose, small enough not to become a secret dump.
 */
export function redactDetail(text: string, limit = 200): string {
  return scrub(text).slice(0, limit);
}

/** Redact a value that is known to be secret, for a log line that names it. */
export function redactValue(value: string): string {
  if (value.length === 0) return "";
  return `[redacted ${value.length} chars]`;
}
