// Composition: resolve access, take the lock, supervise the server, supervise
// the tunnel when the mode needs one, and tell the owner where to go.
//
// Everything it touches is injectable, because the interesting behaviour — a
// mode refusing to start, a second instance being turned away, a tunnel URL
// changing, a boot that must not print a token — is all cheap to test with fakes
// and expensive to test against a phone.

import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import type { LauncherOptions } from "./options.ts";
import {
  resolveAccess,
  type AccessMode,
  type BindPlan,
  type InterfaceAddress,
} from "./access.ts";
import { Supervisor, type ChildLike } from "./supervisor.ts";
import { parseTunnelUrl, tunnelCommand, tunnelChanged, type TunnelCommand } from "./tunnel.ts";
import { announceOwnerLink, type AnnounceResult } from "./owner.ts";
import { ensureDataDir, ownerLinkPath, type DataDir } from "../server/config.ts";
import { acquireLock, type LockHandle } from "../server/lock.ts";

export interface LauncherDeps {
  interfaces?: () => InterfaceAddress[];
  spawnChild?: (command: string, args: string[], env: Record<string, string>) => ChildLike;
  ensureDataDir?: (path: string) => Promise<DataDir>;
  acquireLock?: (dataDir: string) => Promise<{ ok: true; lock: LockHandle } | { ok: false; reason: string; pid?: number }>;
  announce?: (options: {
    link: string;
    path: string;
    interactive: boolean;
    writeFile: boolean;
    writeOut?: (text: string) => void;
    log?: (line: string) => void;
  }) => Promise<AnnounceResult>;
  /** P1-06 mints the token; until then the launcher can only announce one it is given. */
  mintOwnerLink?: (dataDir: string, reissue: boolean) => Promise<{ link: string; minted: boolean }>;
  /** The server program. Missing until P1-07 lands, which is reported, not guessed. */
  serverEntry?: { command: string; args: string[] };
  /** True on the phone: the tunnel needs the termux-chroot wrapper. */
  termux?: boolean;
  cloudflaredBinary?: string;
  log?: (line: string) => void;
  out?: (text: string) => void;
  now?: () => number;
  onTunnelUrl?: (url: string) => void;
}

export interface StartResult {
  ok: boolean;
  code: number;
  message?: string;
  plan?: BindPlan;
  dataDir?: string;
  ownerLink?: AnnounceResult;
}

const EXIT_ACCESS = 2;
const EXIT_LOCKED = 3;
const EXIT_NO_SERVER = 4;

export interface LauncherHandle {
  start(): Promise<StartResult>;
  stop(): Promise<void>;
  urls(): { display?: string; tunnel?: string };
  state(): { server: ReturnType<Supervisor["state"]>; tunnel?: ReturnType<Supervisor["state"]> };
}

export function createLauncher(
  options: LauncherOptions,
  deps: LauncherDeps = {},
): LauncherHandle {
  const log = deps.log ?? ((line: string) => console.error(line));
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const spawnChild =
    deps.spawnChild ??
    ((command, args, env) =>
      spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      }) as unknown as ChildLike);

  let server: Supervisor | undefined;
  let tunnel: Supervisor | undefined;
  let lock: LockHandle | undefined;
  let tunnelUrl: string | undefined;
  let bindPlan: BindPlan | undefined;

  async function stop(): Promise<void> {
    tunnel?.stop();
    server?.stop();
    tunnel = undefined;
    server = undefined;
    if (lock) {
      await lock.release();
      lock = undefined;
    }
  }

  return {
    async start(): Promise<StartResult> {
      const mode: AccessMode = options.mode;
      const access = resolveAccess(mode, (deps.interfaces ?? networkInterfacesList)(), options.port);
      if (!access.ok) {
        log(`refusing to start: ${access.reason}`);
        return { ok: false, code: EXIT_ACCESS, message: access.reason };
      }
      const plan = access.plan;
      bindPlan = plan;
      if (plan.warning) log(`warning: ${plan.warning}`);

      const dataDir = await (deps.ensureDataDir ?? ensureDataDir)(options.dataDir);
      if (dataDir.fixedMode) log(`tightened the data directory mode to 0700: ${dataDir.path}`);

      const acquired = await (deps.acquireLock ?? ((dir: string) => acquireLock(dir)))(dataDir.path);
      if (!acquired.ok) {
        const held = "reason" in acquired && acquired.reason === "held";
        const reason = held
          ? `another instance already owns ${dataDir.path} (pid ${acquired.pid}); one server per data directory`
          : `could not take the lock in ${dataDir.path}`;
        log(`refusing to start: ${reason}`);
        return { ok: false, code: EXIT_LOCKED, message: reason };
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
        onRestart: ({ attempt, delayMs, lastExit }) =>
          log(
            `server exited (code ${lastExit.code ?? "null"}, signal ${lastExit.signal ?? "none"}); ` +
              `restart ${attempt} in ${delayMs} ms`,
          ),
        onGiveUp: ({ attempts }) => log(`server gave up after ${attempts} restarts; see the log above`),
        ...(deps.now ? { now: deps.now } : {}),
      });
      server.start();

      if (mode === "cloudflare") {
        const command: TunnelCommand = tunnelCommand({
          port: options.port,
          binary: deps.cloudflaredBinary ?? `${dataDir.path}/bin/cloudflared`,
          termux: deps.termux ?? false,
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
            if (stream === "stderr") log(line);
          },
          onRestart: ({ attempt, delayMs }) => log(`tunnel restart ${attempt} in ${delayMs} ms`),
          onGiveUp: ({ attempts }) => log(`tunnel gave up after ${attempts} restarts`),
          ...(deps.now ? { now: deps.now } : {}),
        });
        tunnel.start();
      }

      let ownerLink: AnnounceResult | undefined;
      const mint = deps.mintOwnerLink;
      if (mint) {
        const { link, minted } = await mint(dataDir.path, options.reissueOwner);
        ownerLink = await (deps.announce ?? announceOwnerLink)({
          link,
          path: ownerLinkPath(dataDir.path),
          interactive: !options.boot,
          // Only a mint or reissue writes the file; an ordinary boot announces
          // whatever already exists without touching it (PLAN §6.3).
          writeFile: minted || options.reissueOwner,
          writeOut: out,
          log,
        });
      } else {
        log(
          "no owner link to announce: the token is minted by P1-06's auth module, which is not " +
            "implemented yet. The launcher is running without one.",
        );
      }

      return {
        ok: true,
        code: 0,
        plan,
        dataDir: dataDir.path,
        ...(ownerLink ? { ownerLink } : {}),
      };
    },

    stop,

    urls() {
      return {
        ...(tunnelUrl ? { display: tunnelUrl, tunnel: tunnelUrl } : bindPlan?.displayUrl ? { display: bindPlan.displayUrl } : {}),
      };
    },

    state() {
      return {
        server: server?.state() ?? { running: false, stopping: false, attempts: 0, restarts: 0 },
        ...(tunnel ? { tunnel: tunnel.state() } : {}),
      };
    },
  };
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
