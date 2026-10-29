// The Cloudflare quick tunnel, as a *command* rather than a spawn, so the argv
// this launcher would run can be asserted in a test without a network.
//
// P0-03's finding is the reason this module exists at all: Termux has no
// `cloudflared` package, and the raw arm64 binary fails there — no
// `/etc/resolv.conf` and no CA bundle. It only works as
//
//   SSL_CERT_FILE=/etc/tls/cert.pem termux-chroot ~/.pupkeep/bin/cloudflared …
//
// so the launcher supervises that wrapper, never a bare spawn (PLAN §6.7).

import { existsSync } from "node:fs";

export interface TunnelCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface TunnelOptions {
  port: number;
  /** Absolute path of the cloudflared binary. */
  binary: string;
  /** True on the phone: needs `termux-chroot` and the CA bundle override. */
  termux: boolean;
  /** Absolute path to the cert bundle *inside* the chroot (Termux default). */
  certFile?: string;
}

export const TERMUX_CERT_FILE = "/etc/tls/cert.pem";

/**
 * Are we on Termux? The launcher must not depend on an operator remembering an
 * environment variable: the documented boot script does not set one, and the
 * wrapper is the only reason `cloudflare` mode works on the phone at all.
 *
 * Termux exports `PREFIX=/data/data/com.termux/files/usr` and `TERMUX_VERSION`.
 * `PUPKEEP_TERMUX` stays as an explicit override for tests and odd setups.
 */
export function detectTermux(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = defaultExists,
): boolean {
  const override = env.PUPKEEP_TERMUX;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  if (env.TERMUX_VERSION !== undefined && env.TERMUX_VERSION !== "") return true;
  if (env.PREFIX?.startsWith("/data/data/com.termux/")) return true;
  // Last resort: the Termux filesystem layout, without reading the env at all.
  return exists("/data/data/com.termux/files/usr/bin/termux-chroot");
}

function defaultExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

export function tunnelCommand(options: TunnelOptions): TunnelCommand {
  const tunnelArgs = ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${options.port}`];
  if (!options.termux) {
    return { command: options.binary, args: tunnelArgs, env: {} };
  }
  return {
    command: "termux-chroot",
    args: [options.binary, ...tunnelArgs],
    // `SSL_CERT_FILE` resolves inside the chroot, where it is Termux's own
    // `$PREFIX/etc/tls/cert.pem`. Setting the host path here would be silently
    // wrong: the binary is running in a different root.
    env: { SSL_CERT_FILE: options.certFile ?? TERMUX_CERT_FILE },
  };
}

const QUICK_TUNNEL_URL = /https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com\b/;

/**
 * Pull the public URL out of cloudflared's log. It prints a banner with the URL
 * once the tunnel is registered; before that there is nothing useful to show.
 */
export function parseTunnelUrl(line: string): string | undefined {
  const match = QUICK_TUNNEL_URL.exec(line);
  return match ? `https://${match[1]}.trycloudflare.com` : undefined;
}

/**
 * A quick tunnel gets a new hostname every time the process starts, so a restart
 * is not a recovery — it is a new origin, and any push subscription is now dead.
 * The supervisor uses this to decide whether to announce the change.
 */
export function tunnelChanged(previous: string | undefined, next: string | undefined): boolean {
  if (next === undefined) return false;
  return previous !== undefined && previous !== next;
}
