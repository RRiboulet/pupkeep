// The deployment's trust anchor and the proxy that may speak for it (P6/R3/R4).
//
// Two processes have to agree on these answers, so they live here and nowhere
// else:
//
//   * **the origin** is `PUPKEEP_PUBLIC_ORIGIN`. The launcher mints the owner
//     link on it and refuses `--access public` without it; the server accepts
//     mutations only from it and derives `Secure`, the `__Host-` name and HSTS
//     from its scheme. Each used to parse it separately and the server's copy
//     was the weaker one, so a value the launcher refused could still start a
//     server — one authority is the fix, not two conforming parsers.
//   * **the proxy** is `PUPKEEP_TRUSTED_PROXY`, the one peer address allowed to
//     supply `X-Forwarded-*`. It is only meaningful with an origin, and with an
//     origin it is required: a missing address does not fail, it silently
//     stops the rightmost-header read and collapses every client into one
//     rate-limit bucket. Failing closed is the only honest default.
//
// This file lives in `src/shared/` because it is the server's and the
// launcher's contract, not because the browser uses it: `node:net` is imported
// here, so the client never loads it.

import { isIP } from "node:net";

/**
 * The configured public origin, normalised. It is the trust anchor for the whole
 * deployment: the owner link is minted on it, mutations are accepted only from
 * it, and its scheme decides `Secure` cookies and HSTS. So it is parsed once,
 * strictly, and never re-derived later from a request.
 */
export function parsePublicOrigin(
  value: string,
): { ok: true; origin: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: `PUPKEEP_PUBLIC_ORIGIN is not a URL: ${value}` };
  }
  // `new URL` reads `https:example.com` as the same host as `https://example.com`
  // and normalises `%2e%2e` away, so the raw text is the only thing that can say
  // whether the operator wrote a bare origin. Requiring the `//` also keeps the
  // accepted spellings to ones a browser would send in an `Origin` header.
  if (!/^https:\/\//i.test(value)) {
    return { ok: false, error: `PUPKEEP_PUBLIC_ORIGIN must be https://, got ${value}` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "PUPKEEP_PUBLIC_ORIGIN must not carry credentials" };
  }
  // Compare the path as written, not `url.pathname`: the parser resolves
  // `/a/%2e%2e/` to `/`, which would let a real path look like a bare origin.
  const afterScheme = value.slice("https://".length);
  const pathStart = afterScheme.search(/[/?#]/);
  const rawPath = pathStart === -1 ? "" : afterScheme.slice(pathStart);
  if (rawPath !== "" && rawPath !== "/") {
    return { ok: false, error: `PUPKEEP_PUBLIC_ORIGIN must be a bare origin, got ${value}` };
  }
  if (url.hostname === "") {
    return { ok: false, error: `PUPKEEP_PUBLIC_ORIGIN has no host: ${value}` };
  }
  // Port 0 survives `URL` (unlike the default :443) and is not an origin a
  // browser or a proxy can reach: it asks each bind for a fresh ephemeral port.
  if (url.port === "0") {
    return { ok: false, error: `PUPKEEP_PUBLIC_ORIGIN must not use port 0: ${value}` };
  }
  if (url.hostname.endsWith(".")) {
    return { ok: false, error: `PUPKEEP_PUBLIC_ORIGIN must not end its host with a dot: ${value}` };
  }
  // A "public" origin that is a loopback, private, link-local or CGNAT literal
  // is a typo that fails at sign-in time with no diagnostic, so refuse it here.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (literal === "localhost" || literal.includes(":") || isPrivateAddress(literal) || isCgnatAddress(literal)) {
    return { ok: false, error: `PUPKEEP_PUBLIC_ORIGIN must be a public host, got ${url.hostname}` };
  }
  // `URL.origin` lower-cases the host, drops a default :443 and the trailing
  // slash, which is exactly the comparison form `allowedOrigins` needs.
  return { ok: true, origin: url.origin };
}

/**
 * The one sentence both processes print when an origin is set without a proxy
 * address. It names the variable and the value it must have, because the
 * operator's next step is to compare it with Caddy's static address in
 * `docker-compose.yml` — a mismatch here is otherwise invisible.
 */
export const TRUSTED_PROXY_REQUIRED =
  "PUPKEEP_TRUSTED_PROXY must be the address the proxy connects from " +
  "(Caddy's ipv4_address in docker-compose.yml, for example 172.28.0.11) when " +
  "PUPKEEP_PUBLIC_ORIGIN is set; without it forwarded headers are ignored and " +
  "every client shares one rate-limit bucket";

/**
 * Validate `PUPKEEP_TRUSTED_PROXY`.
 *
 * Required with an origin (see `TRUSTED_PROXY_REQUIRED`), optional without one:
 * `local`, `lan` and `tailscale` never read forwarded headers, so an absent
 * address is simply "ignore them". A present-but-malformed value is refused in
 * every mode — a hostname or a `host:port` would never equal a peer address,
 * which is the same silent no-match this check exists to prevent.
 *
 * Brackets are stripped so an IPv6 literal may be written either way; the rest
 * is handed on exactly as written, because `trustedPeer` compares normalised
 * addresses (`::ffff:a.b.c.d` is normalised at the comparison, not here).
 */
export function resolveTrustedProxy(
  publicOrigin: string | undefined,
  rawValue: string | undefined,
): { ok: true; trustedProxy?: string } | { ok: false; error: string } {
  const written = rawValue?.trim() ?? "";
  if (written === "") {
    // Absent, not empty: the server spreads the key only when it has a value.
    if (publicOrigin !== undefined) return { ok: false, error: TRUSTED_PROXY_REQUIRED };
    return { ok: true, trustedProxy: undefined };
  }
  const bracketed = /^\[(.*)\]$/.exec(written);
  const address = bracketed ? bracketed[1]! : written;
  if (isIP(address) === 0) {
    return {
      ok: false,
      error: `PUPKEEP_TRUSTED_PROXY must be one IP address (the proxy's address, not a host or host:port), got ${written}`,
    };
  }
  return { ok: true, trustedProxy: address };
}

/** 100.64.0.0/10, the shared address space Tailscale and carrier NAT use. */
export function isCgnatAddress(address: string): boolean {
  const raw = address.split(".");
  if (raw.length !== 4) return false;
  const first = /^\d{1,3}$/.test(raw[0]!) ? Number(raw[0]) : Number.NaN;
  const second = /^\d{1,3}$/.test(raw[1]!) ? Number(raw[1]) : Number.NaN;
  return first === 100 && second >= 64 && second <= 127;
}

/** RFC1918 and loopback: what "the LAN" means for the fail-closed checks here. */
export function isPrivateAddress(address: string): boolean {
  const raw = address.split(".");
  if (raw.length !== 4) return false;
  const parts = raw.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
