// Command line and environment for the launcher. Parsing lives in its own module
// so it can be tested without starting anything, and so the error messages — the
// only thing an owner sees when a mode is misconfigured — are ordinary strings a
// test can assert.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ACCESS_MODES, type AccessMode } from "./access.ts";

export interface LauncherOptions {
  mode: AccessMode;
  dataDir: string;
  port: number;
  /** Non-interactive (boot script, systemd-ish): never print the owner link. */
  boot: boolean;
  /** Rotate the owner token and print a fresh link. */
  reissueOwner: boolean;
  /** `--help` was asked for; the caller prints usage and exits 0. */
  help: boolean;
}

export type ParseResult =
  | { ok: true; options: LauncherOptions }
  | { ok: false; error: string };

export const DEFAULT_PORT = 8787;

export const USAGE = `pupkeep — a shared, agent-operated puppy care app

Usage: npm start -- [options]

  --access <mode>     local | lan | tailscale | cloudflare   (default: local)
  --port <n>          HTTP port                              (default: ${DEFAULT_PORT})
  --data <dir>        data directory                         (default: ~/.pupkeep)
  --boot              non-interactive: write the owner link, never print it
  --reissue-owner     rotate the owner token and print a fresh link
  -h, --help          show this help

Environment (development only): PUPKEEP_ACCESS, PUPKEEP_PORT, PUPKEEP_DATA_DIR.

Access modes:
  local       bind 127.0.0.1 — this device only
  lan         bind 0.0.0.0  — explicit opt-in, plain HTTP on the whole network
  tailscale   bind the tailnet address; refuses to start if Tailscale is down
  cloudflare  bind 127.0.0.1 and run a quick tunnel for HTTPS/PWA testing
`;

function isMode(value: string): value is AccessMode {
  return (ACCESS_MODES as readonly string[]).includes(value);
}

/** `~`, `~/x` and `$HOME`-relative paths, without pulling in a shell. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function parseOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ParseResult {
  const access = env.PUPKEEP_ACCESS;
  let mode: AccessMode = "local";
  if (access !== undefined && access !== "") {
    if (!isMode(access)) return { ok: false, error: `PUPKEEP_ACCESS is not an access mode: ${access}` };
    mode = access;
  }

  const envPort = env.PUPKEEP_PORT;
  let port = DEFAULT_PORT;
  if (envPort !== undefined && envPort !== "") {
    const parsed = Number(envPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { ok: false, error: `PUPKEEP_PORT is not a port: ${envPort}` };
    }
    port = parsed;
  }

  let dataDir = env.PUPKEEP_DATA_DIR && env.PUPKEEP_DATA_DIR !== "" ? env.PUPKEEP_DATA_DIR : "~/.pupkeep";
  let boot = false;
  let reissueOwner = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [, flag, inline] = /^(--[a-z-]+)(?:=(.*))?$/.exec(arg) ?? [];
    const takeValue = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) return undefined;
      index += 1;
      return next;
    };

    switch (flag) {
      case "--access": {
        const value = takeValue();
        if (value === undefined) return { ok: false, error: "--access needs a mode" };
        if (!isMode(value)) {
          return { ok: false, error: `--access must be one of ${ACCESS_MODES.join(", ")}; got ${value}` };
        }
        mode = value;
        break;
      }
      case "--port": {
        const value = takeValue();
        if (value === undefined) return { ok: false, error: "--port needs a number" };
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          return { ok: false, error: `--port must be an integer 1..65535; got ${value}` };
        }
        port = parsed;
        break;
      }
      case "--data": {
        const value = takeValue();
        if (value === undefined) return { ok: false, error: "--data needs a directory" };
        dataDir = value;
        break;
      }
      case "--boot":
        boot = true;
        break;
      case "--reissue-owner":
        reissueOwner = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (arg === "-h") {
          help = true;
          break;
        }
        return { ok: false, error: `unknown argument: ${arg}` };
    }
  }

  const expanded = expandHome(dataDir, home);
  return {
    ok: true,
    options: {
      mode,
      port,
      boot,
      reissueOwner,
      help,
      dataDir: isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded),
    },
  };
}
