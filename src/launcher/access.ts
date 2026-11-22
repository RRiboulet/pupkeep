// Access modes: which address the server binds, and what URL to tell the owner
// about. Two rules are encoded here rather than documented and hoped for:
//
//   * a mode that cannot be honoured fails closed. Phase 6 retired the
//     `tailscale` and `cloudflare` modes entirely (P6-08): an unknown mode is
//     refused, never approximated — the same rule the old tailscale mode applied
//     to a missing address (never fall back to 0.0.0.0).
//   * only an explicit `lan` opens every interface, and it says so.

import { isCgnatAddress, isPrivateAddress } from "../shared/public-origin.ts";

// The two address predicates moved to `shared/public-origin.ts` when the origin
// parser they serve became shared with the server. Re-exported rather than
// deleted: they are address facts, not access-mode facts, and callers that only
// need "is this RFC1918?" should not have to import the deployment contract.
export { isCgnatAddress, isPrivateAddress };

export const ACCESS_MODES = ["local", "lan", "public"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

/**
 * The one refusal for `public` without an origin. `parseOptions` is the
 * authority — nothing starts without passing it — and `resolveAccess` repeats
 * this sentence only as a defensive check for a caller that builds a plan
 * directly. Both import the constant so the two layers cannot tell an operator
 * two different stories (P6/R2).
 */
export const PUBLIC_ORIGIN_REQUIRED =
  "public mode needs PUPKEEP_PUBLIC_ORIGIN (for example https://pupkeep.duckdns.org) " +
  "so the owner link has an origin to be minted on";

export interface InterfaceAddress {
  name: string;
  address: string;
  family: string;
  internal: boolean;
}

export interface BindPlan {
  mode: AccessMode;
  bindHost: string;
  /** What the owner opens. */
  displayUrl?: string;
  /**
   * The configured public origin, for `public`. It is the origin the owner link
   * is minted on and the only origin the server accepts mutations from — never
   * a discovered address (P6).
   */
  origin?: string;
  /** Something the owner must know about this mode. */
  warning?: string;
}

export type AccessResult = { ok: true; plan: BindPlan } | { ok: false; reason: string };

/** The first non-internal IPv4 address — what a same-Wi-Fi peer would open. */
export function lanAddress(interfaces: readonly InterfaceAddress[]): string | undefined {
  for (const iface of interfaces) {
    if (iface.internal || iface.family !== "IPv4") continue;
    if (iface.address.startsWith("169.254.")) continue; // link-local, not useful
    // 100.64/10 is the CGNAT space a phone's tailnet/VPN interface carries: a
    // phone with the VPN up would otherwise be told its "LAN" address is public
    // and refuse to start (R13's offline fallback must keep working).
    if (isCgnatAddress(iface.address)) continue;
    return iface.address;
  }
  return undefined;
}

/**
 * True for the exact shape `parsePublicOrigin` emits and the server compares
 * against a browser's `Origin` header: `https://host[:port]` with a lower-case
 * host, no default port, no credentials, no path — so `new URL(value).origin ===
 * value`.
 */
function isNormalisedHttpsOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.origin === value;
}

export function resolveAccess(
  mode: AccessMode,
  interfaces: readonly InterfaceAddress[],
  port: number,
  publicOrigin?: string,
): AccessResult {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `port must be an integer 1..65535, got ${port}` };
  }

  // A configured public origin is a declaration that this process is served on
  // the internet. The plaintext modes then have no business starting: `lan`
  // would put a sign-in screen on the wire with no Secure cookie, and `local`
  // would mint a link nobody outside the box can open (P6).
  if (publicOrigin !== undefined && mode !== "public") {
    return {
      ok: false,
      reason:
        `PUPKEEP_PUBLIC_ORIGIN is set (${publicOrigin}), so --access ${mode} is refused: ` +
        "a configured public origin means the process is served publicly, and only " +
        "--access public honours it. Use --access public.",
    };
  }

  switch (mode) {
    case "local":
      return {
        ok: true,
        plan: { mode, bindHost: "127.0.0.1", displayUrl: `http://127.0.0.1:${port}` },
      };

    case "lan": {
      const address = lanAddress(interfaces);
      // The bind is 0.0.0.0, so *every* interface is exposed, not only the one
      // the URL prints. Guarding the printed address alone lets a bridge or a
      // second NIC put the plaintext sign-in screen on the internet (P6).
      const exposed = interfaces.filter(
        (iface) => !iface.internal && iface.family === "IPv4" && !isPrivateAddress(iface.address) &&
          !isCgnatAddress(iface.address),
      );
      if (exposed.length > 0) {
        return {
          ok: false,
          reason:
            `LAN mode would bind ${exposed.map((iface) => iface.address).join(", ")}, which is not a ` +
            "private address. Refusing: that is a plaintext sign-in screen on the internet. Use --access public.",
        };
      }
      if (address !== undefined && !isPrivateAddress(address) && !isCgnatAddress(address)) {
        return {
          ok: false,
          reason:
            `LAN mode would bind ${address}, which is not a private address. ` +
            "Refusing: that is a plaintext sign-in screen on the internet. Use --access public.",
        };
      }
      return {
        ok: true,
        plan: {
          mode,
          bindHost: "0.0.0.0",
          ...(address !== undefined ? { displayUrl: `http://${address}:${port}` } : {}),
          warning:
            "LAN mode binds every interface over plain HTTP. Anyone on the network can reach " +
            "the sign-in screen, and there is no HTTPS, so no service worker or Web Push.",
        },
      };
    }

    case "public": {
      // Defensive only: the parser refuses first, but a caller that skips it must
      // not hand an unvalidated string to the mint and the origin comparison.
      if (publicOrigin === undefined) return { ok: false, reason: PUBLIC_ORIGIN_REQUIRED };
      // "Parsed once, strictly" must not depend on every future caller: the
      // origin is compared byte-for-byte with a browser's `Origin` header, so a
      // trailing slash, an upper-case host or a path is a silent mismatch.
      if (!isNormalisedHttpsOrigin(publicOrigin)) {
        return {
          ok: false,
          reason:
            `PUPKEEP_PUBLIC_ORIGIN is not a normalised https origin ` +
            `(https://host[:port], no path or trailing slash): ${publicOrigin}`,
        };
      }
      // Bind every interface *inside the container*: the proxy is the only thing
      // that reaches it, and only the proxy publishes a port.
      return {
        ok: true,
        plan: { mode, bindHost: "0.0.0.0", displayUrl: publicOrigin, origin: publicOrigin },
      };
    }

    default: {
      // Retired modes (`tailscale`, `cloudflare`) and any future typo land here:
      // a mode that is not in ACCESS_MODES must fail closed, never start a
      // listener a deleted mode would have configured (P6-08).
      const unknown: never = mode;
      return { ok: false, reason: `unknown access mode: ${String(unknown)}` };
    }
  }
}
