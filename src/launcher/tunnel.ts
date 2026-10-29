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
