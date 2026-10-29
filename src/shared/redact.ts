// The one redaction implementation. Everything that writes a log line, an error
// detail or a Settings field goes through this, because the alternative — each
// module scrubbing what it remembers to scrub — is how an owner token ends up in
// `server.log` (PLAN §6.3, §14.4).
//
// The rule it encodes: redact by *shape*, not by parameter name. P1-06 has not
// fixed the owner-link format yet, and a scrubber that only knows `?token=`
// would leak a `#fragment` or a `/login/<opaque>` path the day that changes.

const PATTERNS: Array<{ pattern: RegExp; replace: string | ((...args: string[]) => string) }> = [
  // `Authorization: Bearer …`, `Cookie: …`, `Set-Cookie: …`
  { pattern: /\b(authorization|cookie|set-cookie)\s*:\s*[^\n\r]+/gi, replace: "$1: [redacted]" },
  { pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: "Bearer [redacted]" },
  // Provider keys by prefix: sk-…, pk-…, rk-…
  { pattern: /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, replace: "[key]" },
  // A URL fragment or query: whatever it carries, drop the value.
  { pattern: /#([^\s"'<>]+)/g, replace: "#[redacted]" },
  {
    pattern: /([?&][A-Za-z0-9_]*(?:token|key|code|invite|secret|password)[A-Za-z0-9_]*=)([^&\s"'<>#]+)/gi,
    replace: "$1[redacted]",
  },
  // A token riding a known auth route, e.g. `/login/<token>` or `/invite/<code>`.
  { pattern: /(\/(?:login|invite|auth|join|s|session)\/)[A-Za-z0-9_-]{6,}/gi, replace: "$1[redacted]" },
  // Any remaining long opaque value: invite codes, session tokens, ntfy topics,
  // VAPID keys. 24+ characters of base64url is never prose in this app.
  { pattern: /\b[A-Za-z0-9_-]{24,}\b/g, replace: "[redacted]" },
];

/** Scrub secrets out of a single line. Idempotent. */
export function scrub(text: string): string {
  let value = text;
  for (const { pattern, replace } of PATTERNS) {
    value = value.replace(pattern, replace as string);
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
