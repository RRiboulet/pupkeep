// Command line and environment for the launcher. Parsing lives in its own module
// so it can be tested without starting anything, and so the error messages — the
// only thing an owner sees when a mode is misconfigured — are ordinary strings a
// test can assert.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ACCESS_MODES, PUBLIC_ORIGIN_REQUIRED, isCgnatAddress, isPrivateAddress, type AccessMode } from "./access.ts";

export interface LauncherOptions {
  mode: AccessMode;
  /**
   * `PUPKEEP_PUBLIC_ORIGIN`, normalised to `scheme://host[:port]`. Required by
   * `public` (which refuses to start without it) and refused by the plaintext
   * modes, because its presence declares that this process is served publicly.
   */
  publicOrigin?: string;
  dataDir: string;
  port: number;
  /** Non-interactive (boot script, systemd-ish): never print the owner link. */
  boot: boolean;
  /** Rotate the owner token and print a fresh link. */
  reissueOwner: boolean;
  /**
   * Retry the tasks a previous process parked at the harness's restart limit,
   * once, on this start. The operator's only way out of a park: a parked task
   * stays blocked across restarts, and nothing else in the product calls
   * `harness.retryTask()` (P5-01).
   */
  retryParked: boolean;
  /** `--help` was asked for; the caller prints usage and exits 0. */
  help: boolean;
  /**
   * May the launcher print secrets? False on a TTY-less run (the boot script
   * redirects everything into server.log) and with `--boot`. Opting *in* to
   * leaking the owner token is not something an owner should have to remember.
   */
  interactive: boolean;
}

export type ParseResult =
  | { ok: true; options: LauncherOptions }
  | { ok: false; error: string };

export const DEFAULT_PORT = 8787;

export const USAGE = `pupkeep — a shared, agent-operated puppy care app

Usage: npm start -- [options]

  --access <mode>     local | lan | public | tailscale | cloudflare   (default: local)
  --port <n>          HTTP port                              (default: ${DEFAULT_PORT})
  --data <dir>        data directory                         (default: ~/.pupkeep)
  --boot              non-interactive: write the owner link, never print it
  --reissue-owner     rotate the owner token and print a fresh link
  --retry-parked      retry tasks parked at the restart limit, once, on this start
  -h, --help          show this help

Environment (development only): PUPKEEP_ACCESS, PUPKEEP_PORT, PUPKEEP_DATA_DIR.
Environment (deployment): PUPKEEP_PUBLIC_ORIGIN — required by --access public, and
  refused by every other mode.

Access modes:
  local       bind 127.0.0.1 — this device only
  lan         bind 0.0.0.0  — explicit opt-in, plain HTTP on the whole network
  tailscale   bind the tailnet address; refuses to start if Tailscale is down
  cloudflare  bind 127.0.0.1 and run a quick tunnel for HTTPS/PWA testing
  public      bind every interface inside a container, behind a TLS proxy;
              requires PUPKEEP_PUBLIC_ORIGIN and is the only mode that uses it
`;

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
  isTTY: boolean = Boolean(process.stdout.isTTY),
): ParseResult {
  const access = env.PUPKEEP_ACCESS;
  let mode: AccessMode = "local";
  if (access !== undefined && access !== "") {
    if (!isMode(access)) return { ok: false, error: `PUPKEEP_ACCESS is not an access mode: ${access}` };
    mode = access;
  }

  const envPublicOrigin = env.PUPKEEP_PUBLIC_ORIGIN;
  let publicOrigin: string | undefined;
  if (envPublicOrigin !== undefined && envPublicOrigin !== "") {
    const parsedOrigin = parsePublicOrigin(envPublicOrigin);
    if (!parsedOrigin.ok) return { ok: false, error: parsedOrigin.error };
    publicOrigin = parsedOrigin.origin;
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
  let retryParked = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [, flag, inline] = /^(--[a-z-]+)(?:=(.*))?$/.exec(arg) ?? [];
    const takeValue = (): string | undefined => {
      // `--data=` is an empty value, not a fallback to the default: accepting it
      // would resolve the data directory to $HOME and chmod the home directory.
      if (inline !== undefined) return inline === "" ? undefined : inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) return undefined;
      index += 1;
      return next;
    };
    const rejectValue = (flagName: string): { ok: false; error: string } | undefined =>
      inline === undefined ? undefined : { ok: false, error: `${flagName} does not take a value` };

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
      case "--boot": {
        const bad = rejectValue("--boot");
        if (bad) return bad;
        boot = true;
        break;
      }
      case "--reissue-owner": {
        const bad = rejectValue("--reissue-owner");
        if (bad) return bad;
        reissueOwner = true;
        break;
      }
      case "--retry-parked": {
        const bad = rejectValue("--retry-parked");
        if (bad) return bad;
        retryParked = true;
        break;
      }
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

  // Fail in the parser, not after the lock: `public` without an origin has no
  // owner link to mint and no origin to trust, so there is nothing to start.
  // This is the authoritative refusal; `resolveAccess` repeats the same
  // constant only for callers that bypass the parser (P6/R2).
  if (mode === "public" && publicOrigin === undefined) {
    return { ok: false, error: PUBLIC_ORIGIN_REQUIRED };
  }

  const expanded = expandHome(dataDir, home);
  return {
    ok: true,
    options: {
      mode,
      ...(publicOrigin !== undefined ? { publicOrigin } : {}),
      port,
      boot,
      reissueOwner,
      retryParked,
      help,
      interactive: !boot && isTTY,
      dataDir: isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded),
    },
  };
}
