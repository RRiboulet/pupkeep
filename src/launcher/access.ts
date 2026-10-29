// Access modes: which address the server binds, and what URL to tell the owner
// about. Two rules from Phase 0 are encoded here rather than documented and
// hoped for:
//
//   * tailscale mode fails closed. If no tailnet address is present the launcher
//     refuses to start — it never falls back to 0.0.0.0 (P0-03's scratch server
//     proved why: the LAN address is reachable, the tailnet one is private).
//   * only an explicit `lan` opens every interface, and it says so.

export const ACCESS_MODES = ["local", "lan", "tailscale", "cloudflare"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export interface InterfaceAddress {
  name: string;
  address: string;
  family: string;
  internal: boolean;
}

export interface BindPlan {
  mode: AccessMode;
  bindHost: string;
  /** What the owner opens. For `cloudflare` this is filled in once the tunnel is up. */
  displayUrl?: string;
  /** Something the owner must know about this mode. */
  warning?: string;
}

export type AccessResult = { ok: true; plan: BindPlan } | { ok: false; reason: string };

/** 100.64.0.0/10 — the shared address space Tailscale uses. */
export function isTailscaleAddress(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  if (!Number.isInteger(first) || !Number.isInteger(second)) return false;
  return first === 100 && second >= 64 && second <= 127;
}

/**
 * The phone's tailnet IPv4 address. Tailscale's Android app puts it on `tun*`;
 * the address family filter matters because the same interface also carries an
 * IPv6 address and a link-local one, and binding those would be a different
 * (and unasked-for) decision.
 */
export function tailscaleAddress(interfaces: readonly InterfaceAddress[]): string | undefined {
  for (const iface of interfaces) {
    if (iface.internal || iface.family !== "IPv4") continue;
    if (!iface.name.startsWith("tun")) continue;
    if (isTailscaleAddress(iface.address)) return iface.address;
  }
  return undefined;
}

export function resolveAccess(
  mode: AccessMode,
  interfaces: readonly InterfaceAddress[],
  port: number,
): AccessResult {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `port must be an integer 1..65535, got ${port}` };
  }

  switch (mode) {
    case "local":
      return {
        ok: true,
        plan: { mode, bindHost: "127.0.0.1", displayUrl: `http://127.0.0.1:${port}` },
      };

    case "lan":
      return {
        ok: true,
        plan: {
          mode,
          bindHost: "0.0.0.0",
          displayUrl: `http://<this-device-LAN-address>:${port}`,
          warning:
            "LAN mode binds every interface over plain HTTP. Anyone on the network can reach " +
            "the sign-in screen, and there is no HTTPS, so no service worker or Web Push.",
        },
      };

    case "tailscale": {
      const address = tailscaleAddress(interfaces);
      if (!address) {
        return {
          ok: false,
          reason:
            "Tailscale is not connected: no 100.64.0.0/10 address on a tun interface. " +
            "Start Tailscale (and set Android's Always-on VPN), or choose another --access mode. " +
            "Refusing to bind 0.0.0.0 instead.",
        };
      }
      return {
        ok: true,
        plan: { mode, bindHost: address, displayUrl: `http://${address}:${port}` },
      };
    }

    case "cloudflare":
      // Loopback only: the public side is the tunnel, never the bind.
      return {
        ok: true,
        plan: {
          mode,
          bindHost: "127.0.0.1",
          warning:
            "The quick tunnel is for HTTPS/PWA/Web Push testing only. Its URL changes on every " +
            "restart and push subscriptions must be renewed; it is not the daily access path.",
        },
      };

    default: {
      const unreachable: never = mode;
      return { ok: false, reason: `unknown access mode: ${String(unreachable)}` };
    }
  }
}
