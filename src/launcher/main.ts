// Composition: resolve access, take the lock, supervise the server, supervise
// the tunnel when the mode needs one, and tell the owner where to go.
//
// Everything it touches is injectable, because the interesting behaviour — a
// mode refusing to start, a second instance being turned away, a tunnel URL
// changing, a boot that must not print a token — is all cheap to test with fakes
// and expensive to test against a phone.
//
// Ordering is the part that matters and is easy to get wrong: the data-directory
// lock is released **last**, after both children have actually exited. A launcher
// that frees the lock while the server still holds its SQLite file hands the next
// instance a second writer, which is the exact invariant PLAN §3.2 relies on.

import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import type { LauncherOptions } from "./options.ts";
import { lanAddress, resolveAccess, type AccessMode, type BindPlan, type InterfaceAddress } from "./access.ts";
import { Supervisor, type ChildLike } from "./supervisor.ts";
import { detectTermux, parseTunnelUrl, tunnelCommand, tunnelChanged, type TunnelCommand } from "./tunnel.ts";
import { announceOwnerLink, type AnnounceResult } from "./owner.ts";
import { ensureDataDir, ownerLinkPath, type DataDir } from "../server/config.ts";
import { acquireLock, type LockHandle } from "../server/lock.ts";

export interface LauncherDeps {
  /** Network view; defaults to the real interfaces. */
  interfaces?: () => InterfaceAddress[];
  spawnChild?: (command: string, args: string[], env: Record<string, string>) => ChildLike;
  ensureDataDir?: (path: string) => Promise<DataDir>;
  acquireLock?: (dataDir: string) => Promise<{ ok: true; lock: LockHandle } | { ok: false; reason: string; pid?: number }>;
  /** P1-06 mints the token; until then the launcher can only announce one it is given. */
  mintOwnerLink?: (
    dataDir: string,
    origin: string | undefined,
    reissue: boolean,
  ) => Promise<{ link: string; minted: boolean }>;
  /** The server program. Missing until P1-07 lands, which is reported, not guessed. */
  serverEntry?: { command: string; args: string[] };
  /** True on the phone: the tunnel needs the termux-chroot wrapper. Auto-detected. */
  termux?: boolean;
  cloudflaredBinary?: string;
  log?: (line: string) => void;
  out?: (text: string) => void;
  now?: () => number;
  /** The public origin appeared or changed (cloudflare mode). */
  onTunnelUrl?: (url: string) => void;
  /** Supervision gave up; the caller should exit non-zero so its supervisor restarts it. */
  onFatal?: (reason: string) => void;
}

export interface StartResult {
  ok: boolean;
  code: number;
  message?: string;
  plan?: BindPlan;
  dataDir?: string;
  ownerLink?: AnnounceResult;
}

// 0 ok, 2 access refused, 3 another instance holds the lock, 4 the server program
// is missing, 5 the data directory or lock failed for a real reason.
const EXIT_ACCESS = 2;
const EXIT_LOCKED = 3;
const EXIT_NO_SERVER = 4;
const EXIT_DATA_DIR = 5;

export interface LauncherHandle {
  start(): Promise<StartResult>;
  stop(): Promise<void>;
  urls(): { display?: string; tunnel?: string };
  state(): { server: ReturnType<Supervisor["state"]>; tunnel?: ReturnType<Supervisor["state"]> };
}

export function createLauncher(options: LauncherOptions, deps: LauncherDeps = {}): LauncherHandle {
  const log = deps.log ?? ((line: string) => console.error(line));
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const spawnChild =
    deps.spawnChild ??
    ((command, args, env) =>
      spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        // Detached so the supervisor can signal the whole group: on the phone the
        // tunnel's direct child is `termux-chroot`, and killing only that would
        // orphan a live cloudflared.
        detached: true,
        env: { ...process.env, ...env },
      }) as unknown as ChildLike);

  let server: Supervisor | undefined;
  let tunnel: Supervisor | undefined;
  let lock: LockHandle | undefined;
  let tunnelUrl: string | undefined;
  let bindPlan: BindPlan | undefined;
  let starting: Promise<StartResult> | undefined;
  let failing = false;

  async function stop(): Promise<void> {
    // Children first, lock last: see the header.
    await tunnel?.stop();
    await server?.stop();
    tunnel = undefined;
    server = undefined;
    if (lock) {
      await lock.release();
      lock = undefined;
    }
  }

  function fatal(reason: string): void {
    if (failing) return;
    failing = true;
    log(`fatal: ${reason}`);
    void stop().then(() => deps.onFatal?.(reason));
  }

  return {
    start(): Promise<StartResult> {
      if (!starting) starting = startInternal();
      return starting;
    },

    stop,

    urls() {
      if (tunnelUrl) return { display: tunnelUrl, tunnel: tunnelUrl };
      return bindPlan?.displayUrl ? { display: bindPlan.displayUrl } : {};
    },

    state() {
      return {
        server: server?.state() ?? { running: false, stopping: false, attempts: 0, restarts: 0 },
        ...(tunnel ? { tunnel: tunnel.state() } : {}),
      };
    },
  };

  async function startInternal(): Promise<StartResult> {
    const mode: AccessMode = options.mode;
    const interfaces = (deps.interfaces ?? networkInterfacesList)();
    const access = resolveAccess(mode, interfaces, options.port);
    if (!access.ok) {
      log(`refusing to start: ${access.reason}`);
      return { ok: false, code: EXIT_ACCESS, message: access.reason };
    }
    const plan = access.plan;
    bindPlan = plan;
    if (plan.warning) log(`warning: ${plan.warning}`);

    let dataDir: DataDir;
    try {
      dataDir = await (deps.ensureDataDir ?? ensureDataDir)(options.dataDir);
    } catch (error) {
      const message = (error as Error).message;
      log(`refusing to start: ${message}`);
      return { ok: false, code: EXIT_DATA_DIR, message };
    }
    if (dataDir.fixedMode) log(`tightened the data directory mode to 0700: ${dataDir.path}`);

    const acquired = await (deps.acquireLock ?? ((dir: string) => acquireLock(dir)))(dataDir.path);
    if (!acquired.ok) {
      const held = acquired.reason === "held";
      const reason = held
        ? `another instance already owns ${dataDir.path} (pid ${acquired.pid}); one server per data directory`
        : `could not take the lock in ${dataDir.path}: ${acquired.reason}`;
      log(`refusing to start: ${reason}`);
      return { ok: false, code: held ? EXIT_LOCKED : EXIT_DATA_DIR, message: reason, plan, dataDir: dataDir.path };
    }
    lock = acquired.lock;

    const entry = deps.serverEntry;
    if (!entry) {
      const message =
        "the server program does not exist yet (task P1-07). The launcher resolved the access " +
        "mode and the lock, then stopped; nothing was started.";
      log(message);
      await stop();
      return { ok: false, code: EXIT_NO_SERVER, message, plan, dataDir: dataDir.path };
    }

    server = new Supervisor({
      name: "server",
      spawn: () => spawnChild(entry.command, entry.args, serverEnv(plan.bindHost, options.port)),
      onOutput: (line, stream) => (stream === "stderr" ? log(line) : out(`${line}\n`)),
      onError: (error) => log(`server could not start: ${error.message}`),
      onRestart: ({ attempt, delayMs, lastExit }) =>
        log(
          `server exited (code ${lastExit.code ?? "null"}, signal ${lastExit.signal ?? "none"}` +
            `${lastExit.error ? `, ${lastExit.error}` : ""}); restart ${attempt} in ${delayMs} ms`,
        ),
      onGiveUp: ({ attempts }) => fatal(`server gave up after ${attempts} restarts`),
      ...(deps.now ? { now: deps.now } : {}),
    });
    server.start();

    if (mode === "cloudflare") {
      const command: TunnelCommand = tunnelCommand({
        port: options.port,
        binary: deps.cloudflaredBinary ?? `${dataDir.path}/bin/cloudflared`,
        termux: deps.termux ?? detectTermux(),
      });
      tunnel = new Supervisor({
        name: "tunnel",
        spawn: () => spawnChild(command.command, command.args, command.env),
        onOutput: (line, stream) => {
          const url = parseTunnelUrl(line);
          if (url) {
            if (tunnelChanged(tunnelUrl, url)) {
              log(
                `the quick tunnel restarted with a new URL (${tunnelUrl} → ${url}); ` +
                  "PWA installs and push subscriptions on the old origin are dead",
              );
            }
            tunnelUrl = url;
            deps.onTunnelUrl?.(url);
          }
          if (stream === "stderr" && !url) log(line);
        },
        onError: (error) => log(`tunnel could not start: ${error.message}`),
        onRestart: ({ attempt, delayMs }) => log(`tunnel restart ${attempt} in ${delayMs} ms`),
        onGiveUp: ({ attempts }) => fatal(`tunnel gave up after ${attempts} restarts`),
        ...(deps.now ? { now: deps.now } : {}),
      });
      tunnel.start();
    }

    let ownerLink: AnnounceResult | undefined;
    const mint = deps.mintOwnerLink;
    if (mint) {
      try {
        // The origin is passed in so P1-06 can mint a link for the URL the owner
        // will actually open — the tunnel's, once it exists.
        const { link, minted } = await mint(dataDir.path, tunnelUrl ?? plan.displayUrl, options.reissueOwner);
        ownerLink = await announceOwnerLink({
          link,
          path: ownerLinkPath(dataDir.path),
          interactive: options.interactive,
          // Only a mint or reissue writes the file; an ordinary boot announces
          // whatever already exists without touching it (PLAN §6.3).
          writeFile: minted || options.reissueOwner,
          writeOut: out,
          log,
        });
      } catch (error) {
        log(`owner link could not be announced: ${(error as Error).message}`);
      }
    } else {
      log(
        "no owner link to announce: the token is minted by P1-06's auth module, which is not " +
          "implemented yet. The launcher is running without one.",
      );
    }

    if (plan.mode === "lan") {
      const address = lanAddress(interfaces);
      if (address) log(`LAN peers should open http://${address}:${options.port}`);
    }

    return {
      ok: true,
      code: 0,
      plan,
      dataDir: dataDir.path,
      ...(ownerLink ? { ownerLink } : {}),
    };
  }
}

function serverEnv(bindHost: string, port: number): Record<string, string> {
  return { PUPKEEP_BIND_HOST: bindHost, PUPKEEP_PORT: String(port) };
}

function networkInterfacesList(): InterfaceAddress[] {
  const result: InterfaceAddress[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      result.push({ name, address: address.address, family: address.family, internal: address.internal });
    }
  }
  return result;
}
