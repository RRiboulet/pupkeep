import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLauncher, type LauncherDeps } from "../src/launcher/main.ts";
import type { ChildLike } from "../src/launcher/supervisor.ts";
import { parseOptions } from "../src/launcher/options.ts";
import { acquireLock, SERVER_LOCK_FILE } from "../src/server/lock.ts";

class FakeChild extends EventEmitter implements ChildLike {
  readonly pid = 9001;
  kill(): boolean {
    return true;
  }
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

/**
 * A child that actually exits when killed, so `stop()` does not wait out the
 * supervisor's 3 s escalation on every test that has a running child.
 */
class StoppableChild extends EventEmitter implements ChildLike {
  readonly pid = 7000;
  kills = 0;
  kill(): boolean {
    this.kills += 1;
    setImmediate(() => this.emit("exit", 0, "SIGTERM"));
    return true;
  }
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

const HOME = "/home/owner";

function options(argv: string[] = ["--access", "local"], isTTY = false) {
  const parsed = parseOptions(argv, {}, HOME, isTTY);
  assert.ok(parsed.ok);
  return parsed.options;
}

function deps(overrides: LauncherDeps = {}): LauncherDeps & { logs: string[]; printed: string[] } {
  const logs: string[] = [];
  const printed: string[] = [];
  return {
    logs,
    printed,
    interfaces: () => [{ name: "tun1", address: "100.90.202.61", family: "IPv4", internal: false }],
    ensureDataDir: async (path: string) => ({ path, created: true, fixedMode: false }),
    acquireLock: async () => ({
      ok: true as const,
      lock: { path: "/tmp/lock", pid: 1, release: async () => {} },
    }),
    spawnChild: () => new FakeChild(),
    log: (line: string) => logs.push(line),
    // Minting needs a real data directory; the launcher tests that are about
    // supervision inject a no-op and test the owner path separately.
    mintOwnerLink: async () => undefined,
    out: (text: string) => printed.push(text),
    ...overrides,
  } as LauncherDeps & { logs: string[]; printed: string[] };
}

test("tailscale without a tailnet address refuses to start, before anything is spawned", async () => {
  let spawned = false;
  const launcher = createLauncher(
    options(["--access", "tailscale"]),
    deps({
      interfaces: () => [],
      spawnChild: () => {
        spawned = true;
        return new FakeChild();
      },
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.match(result.message ?? "", /Tailscale is not connected/);
  assert.equal(spawned, false, "nothing may start when the mode cannot be honoured");
});

test("a second instance is refused with the holder's pid", async () => {
  const launcher = createLauncher(
    options(),
    deps({
      acquireLock: async () => ({ ok: false as const, reason: "held", pid: 4321 }),
    }),
  );
  const result = await launcher.start();
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.match(result.message ?? "", /pid 4321/);
});

test("a detached server left by a dead launcher is refused before a second one is spawned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-orphan-"));
  const serverLock = await acquireLock(dir, process.pid, new Date(), SERVER_LOCK_FILE);
  assert.ok(serverLock.ok);
  try {
    let spawned = false;
    const launcher = createLauncher(
      options(["--access", "local", "--data", dir]),
      deps({
        ensureDataDir: async (path) => ({ path, fixedMode: false }),
        spawnChild: () => {
          spawned = true;
          return new FakeChild();
        },
      }),
    );
    const result = await launcher.start();
    assert.equal(result.ok, false);
    assert.equal(result.code, 3);
    assert.match(result.message ?? "", new RegExp(`pid ${process.pid}`));
    assert.equal(spawned, false, "the orphan must be reported before another writer is started");
  } finally {
    await serverLock.lock.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("without the server program the launcher says which task owns it and releases the lock", async () => {
  let released = false;
  const launcher = createLauncher(
    options(),
    deps({
      acquireLock: async () => ({
        ok: true as const,
        lock: { path: "/tmp/lock", pid: 1, release: async () => void (released = true) },
      }),
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, false);
  assert.equal(result.code, 4);
  assert.match(result.message ?? "", /P1-07/);
  assert.equal(released, true, "a refusal must not leak the lock");
});

test("with a server program the child is spawned with the resolved bind address", async () => {
  const spawned: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const launcher = createLauncher(
    options(["--access", "tailscale", "--port", "9000"]),
    deps({
      serverEntry: { command: "node", args: ["server.ts"] },
      spawnChild: (command, args, env) => {
        spawned.push({ command, args, env });
        return new FakeChild();
      },
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.equal(result.plan?.bindHost, "100.90.202.61");
  assert.deepEqual(spawned[0], {
    command: "node",
    args: ["server.ts"],
    env: {
      PUPKEEP_BIND_HOST: "100.90.202.61",
      PUPKEEP_PORT: "9000",
      PUPKEEP_DATA_DIR: "/home/owner/.pupkeep",
    },
  });
  await launcher.stop();
});

test("--retry-parked reaches the first spawn only, never a supervisor restart", async () => {
  // A task parked for crashing the process must not be retried by every restart:
  // that is the crash loop the harness's `restartLimit` exists to stop. The
  // operator asks for one attempt, so the variable is set on the first child and
  // then withdrawn.
  const spawned: Array<Record<string, string>> = [];
  const children: FakeChild[] = [];
  const launcher = createLauncher(
    options(["--access", "local", "--retry-parked"]),
    deps({
      serverEntry: { command: "node", args: ["server.ts"] },
      spawnChild: (_command, _args, env) => {
        spawned.push(env);
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.equal(spawned[0]?.PUPKEEP_RETRY_PARKED, "1");

  // A crash makes the supervisor spawn again; that child must not carry the flag.
  // The first restart waits the supervisor's 1 s initial backoff.
  children[0]?.emit("exit", 1, null);
  const deadline = Date.now() + 5_000;
  while (spawned.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(spawned.length, 2, "the supervisor restarted the child");
  assert.equal(spawned[1]?.PUPKEEP_RETRY_PARKED, undefined);
  await launcher.stop();
});

test("interactive mode prints the owner link; boot mode writes it and logs only the path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-link-"));
  const link = `http://127.0.0.1:8787/login?token=SECRET-OWNER-TOKEN`;

  for (const boot of [false, true]) {
    const d = deps({
      serverEntry: { command: "node", args: ["server.ts"] },
      mintOwnerLink: async () => ({ link, minted: true }),
    });
    const launcher = createLauncher(
      options(["--access", "local", "--data", dir, ...(boot ? ["--boot"] : [])], true),
      d,
    );

    const result = await launcher.start();
    assert.equal(result.ok, true);
    const written = await readFile(join(dir, "owner-link.txt"), "utf8");
    assert.equal(written, `${link}\n`);
    assert.equal((await stat(join(dir, "owner-link.txt"))).mode & 0o777, 0o600);

    const printedText = d.printed.join("");
    const logged = d.logs.join("\n");
    if (boot) {
      assert.equal(printedText, "", "boot mode must not print the link");
      assert.match(logged, /owner link written to .*owner-link\.txt/);
    } else {
      assert.match(printedText, /SECRET-OWNER-TOKEN/);
    }
    // The token must never reach the log in either mode.
    assert.doesNotMatch(logged, /SECRET-OWNER-TOKEN/);
    await launcher.stop();
  }
});

test("with no mint dependency the launcher says an owner token already exists, links included", async () => {
  // The default mints on first run; a caller that supplies none is told the truth
  // rather than shown a fabricated link.
  const d = deps({ serverEntry: { command: "node", args: ["server.ts"] }, mintOwnerLink: async () => undefined });
  const launcher = createLauncher(options(), d);
  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.equal(result.ownerLink, undefined);
  assert.match(d.logs.join("\n"), /--reissue-owner/);
  await launcher.stop();
});

test("stop() releases the lock only after the child exited", async () => {
  const order: string[] = [];
  class SlowChild extends EventEmitter implements ChildLike {
    readonly pid = 7001;
    kill(): boolean {
      // A graceful server shutting down: the exit arrives after the signal.
      setTimeout(() => this.emit("exit", 0, "SIGTERM"), 20);
      return true;
    }
    stdout = new EventEmitter();
    stderr = new EventEmitter();
  }

  const launcher = createLauncher(
    options(),
    deps({
      serverEntry: { command: "node", args: ["server.ts"] },
      spawnChild: () => new SlowChild(),
      acquireLock: async () => ({
        ok: true as const,
        lock: { path: "/tmp/lock", pid: 1, release: async () => void order.push("lock-released") },
      }),
    }),
  );

  await launcher.start();
  await launcher.stop();
  assert.deepEqual(order, ["lock-released"]);
  // The child must have exited before the lock went; assert it via state().
  assert.equal(launcher.state().server.running, false);
});

test("the tunnel URL is announced and becomes the display URL", async () => {
  const urls: string[] = [];
  class StreamChild extends EventEmitter implements ChildLike {
    readonly pid = 7002;
    kill(): boolean {
      setTimeout(() => this.emit("exit", 0, "SIGTERM"), 0);
      return true;
    }
    stdout = new EventEmitter();
    stderr = new EventEmitter();
  }

  const children: StreamChild[] = [];
  const launcher = createLauncher(
    options(["--access", "cloudflare"]),
    deps({
      serverEntry: { command: "node", args: ["server.ts"] },
      spawnChild: () => {
        const child = new StreamChild();
        children.push(child);
        return child;
      },
      onTunnelUrl: (url: string) => urls.push(url),
      cloudflaredBinary: "/x/cloudflared",
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.equal(result.plan?.bindHost, "127.0.0.1");

  // children[0] is the server, children[1] the tunnel.
  const tunnel = children[1]!;
  tunnel.stdout.emit("data", "2026-10-29T10:00:00Z INF |  https://a-b-c.trycloudflare.com  |\n");

  assert.deepEqual(urls, ["https://a-b-c.trycloudflare.com"]);
  assert.deepEqual(launcher.urls(), {
    display: "https://a-b-c.trycloudflare.com",
    tunnel: "https://a-b-c.trycloudflare.com",
  });
  await launcher.stop();
});

test("cloudflared's failure line reaches the log and is never announced as the tunnel", async () => {
  // The composition that was broken: the swallow rule (`if (stderr && !url)`) only
  // works if the parser refuses the API endpoint. Both halves are asserted here
  // through the launcher, not only through `parseTunnelUrl`.
  const urls: string[] = [];
  class StreamChild extends EventEmitter implements ChildLike {
    readonly pid = 7008;
    kill(): boolean {
      setImmediate(() => this.emit("exit", 0, "SIGTERM"));
      return true;
    }
    stdout = new EventEmitter();
    stderr = new EventEmitter();
  }
  const children: StreamChild[] = [];
  const d = deps({
    serverEntry: { command: "node", args: ["server.ts"] },
    spawnChild: () => {
      const child = new StreamChild();
      children.push(child);
      return child;
    },
    onTunnelUrl: (url: string) => urls.push(url),
    cloudflaredBinary: "/x/cloudflared",
  });
  const launcher = createLauncher(options(["--access", "cloudflare"]), d);
  await launcher.start();

  // What the phone actually emitted when the chroot's DNS failed (cell 5).
  const failure =
    'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": ' +
    "dial tcp: lookup api.trycloudflare.com on [::1]:53: read udp [::1]:33747->[::1]:53: read: connection refused";
  children[1]!.stderr.emit("data", `${failure}\n`);

  assert.deepEqual(urls, [], "cloudflared's API endpoint is not a tunnel origin");
  assert.match(d.logs.join("\n"), /failed to request quick Tunnel/);
  assert.deepEqual(launcher.urls(), {}, "nothing to announce before a real URL");

  // The good direction: a real banner line is consumed, not logged.
  children[1]!.stderr.emit("data", "2026-10-29T10:00:00Z INF |  https://a-b-c.trycloudflare.com  |\n");
  assert.deepEqual(urls, ["https://a-b-c.trycloudflare.com"]);
  assert.doesNotMatch(d.logs.join("\n"), /a-b-c\.trycloudflare\.com/);
  await launcher.stop();
});

test("the tunnel's restart line carries the exit code and signal, as the server's does", async () => {
  class ExitChild extends EventEmitter implements ChildLike {
    readonly pid = 7005;
    kill(): boolean {
      setImmediate(() => this.emit("exit", 0, "SIGTERM"));
      return true;
    }
    stdout = new EventEmitter();
    stderr = new EventEmitter();
  }

  const children: ExitChild[] = [];
  const d = deps({
    serverEntry: { command: "node", args: ["server.ts"] },
    spawnChild: () => {
      const child = new ExitChild();
      children.push(child);
      return child;
    },
    cloudflaredBinary: "/x/cloudflared",
  });
  const launcher = createLauncher(options(["--access", "cloudflare"]), d);

  await launcher.start();
  // children[0] is the server, children[1] the tunnel.
  children[1]!.emit("exit", null, "SIGKILL");
  // P5-01b cell 5: `tunnel restart 3 in 4000 ms` alone left the operator without
  // the cause the server's own line names (code + signal).
  assert.match(d.logs.join("\n"), /tunnel exited \(code null, signal SIGKILL\); restart 1 in 1000 ms/);
  await launcher.stop();
});

test("an existing owner's cloudflare start does not wait for the tunnel", async () => {
  // The opposite mistake to the mint fix: gating every boot on the tunnel would put
  // up to 30 s in front of a household that already has an owner.
  const envs: Array<Record<string, string>> = [];
  const d = deps({
    serverEntry: { command: "node", args: ["server.ts"] },
    spawnChild: (_command, _args, env) => {
      envs.push(env);
      return new StoppableChild();
    },
    cloudflaredBinary: "/x/cloudflared",
  });
  const launcher = createLauncher(options(["--access", "cloudflare"]), d);

  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.doesNotMatch(d.logs.join("\n"), /waiting up to/);
  // children[0] is the server (it gets the bind env), children[1] the tunnel.
  assert.equal(envs[0]?.PUPKEEP_BIND_HOST, "127.0.0.1");
  assert.deepEqual(envs[1], {}, "the tunnel started after the server");
  await launcher.stop();
});

test("the real mint refuses a loopback origin and waits for the tunnel's own", async () => {
  // Every other cloudflare test fakes the minter, so this is the one that pins
  // `defaultMintOwnerLink`'s early return: no token may be minted for an origin that
  // does not exist yet, and a token must be minted once the tunnel names one.
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-real-mint-"));
  const banner = "2026-11-10T22:00:08Z INF |  https://a-b-c.trycloudflare.com  |\n";

  const children: StoppableChild[] = [];
  const launcher = createLauncher(
    options(["--access", "cloudflare", "--data", dir]),
    deps({
      serverEntry: { command: "node", args: ["server.ts"] },
      spawnChild: () => {
        const child = new StoppableChild();
        children.push(child);
        if (children.length === 1) setImmediate(() => child.stdout.emit("data", banner));
        return child;
      },
      mintOwnerLink: undefined,
      cloudflaredBinary: "/x/cloudflared",
      tunnelUrlTimeoutMs: 5_000,
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, true);
  const link = await readFile(join(dir, "owner-link.txt"), "utf8");
  assert.match(link, /^https:\/\/a-b-c\.trycloudflare\.com\/login\?token=[A-Za-z0-9_-]+$/m);
  const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as {
    ownerTokenHash?: string | null;
  };
  assert.equal(typeof config.ownerTokenHash, "string", "one owner token, minted on the tunnel origin");
  await launcher.stop();
  await rm(dir, { recursive: true, force: true });
});

test("a stop during the owner wait is reported as a stop, not a tunnel defect", async () => {
  // Ctrl-C in the first seconds of a fresh `cloudflare` boot used to be diagnosed
  // as "the tunnel reported no URL": a clean operator stop must not look like a bug.
  const d = deps({
    serverEntry: { command: "node", args: ["server.ts"] },
    spawnChild: () => new StoppableChild(),
    mintOwnerLink: async () => "no-origin",
    cloudflaredBinary: "/x/cloudflared",
    tunnelUrlTimeoutMs: 60_000,
  });
  const launcher = createLauncher(options(["--access", "cloudflare"]), d);

  const started = launcher.start();
  // Wait until the launcher is parked on the tunnel's URL, then stop it.
  for (let i = 0; i < 500 && !d.logs.some((line) => line.includes("waiting up to")); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await launcher.stop();

  const result = await started;
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /stopped while waiting/);
  assert.doesNotMatch(d.logs.join("\n"), /fatal:/);
});

test("the owner link is minted for the origin the owner will actually open", async () => {
  const origins: Array<string | undefined> = [];
  const launcher = createLauncher(
    options(["--access", "tailscale"]),
    deps({
      serverEntry: { command: "node", args: ["server.ts"] },
      mintOwnerLink: async (_dir, origin) => {
        origins.push(origin);
        return { link: "http://100.90.202.61:8787/login?token=t", minted: true };
      },
    }),
  );

  await launcher.start();
  assert.deepEqual(origins, ["http://100.90.202.61:8787"]);
  await launcher.stop();
});

test("first boot mints and stores the link; a later boot does not print it again", async () => {
  const { mkdtemp, readFile, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-mint-"));
  const d = deps({ serverEntry: { command: "node", args: ["server.ts"] }, mintOwnerLink: undefined });

  const launcher = createLauncher(options(["--access", "local", "--data", dir], true), d);
  const first = await launcher.start();
  assert.equal(first.ok, true);
  const stored = await readFile(join(dir, "owner-link.txt"), "utf8");
  assert.match(stored, /\/login\?token=/);
  assert.equal((await stat(join(dir, "owner-link.txt"))).mode & 0o777, 0o600);
  await launcher.stop();

  const second = createLauncher(options(["--access", "local", "--data", dir], true), deps({ serverEntry: { command: "node", args: ["server.ts"] }, mintOwnerLink: undefined }));
  const again = await second.start();
  assert.equal(again.ok, true);
  assert.equal(again.ownerLink, undefined, "the link cannot be recovered from the hash");
  await second.stop();
});

test("a fresh cloudflare start mints the owner on the tunnel's origin, never loopback", async () => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-mint-"));
  // Verbatim from the pinned binary (P5-01b Finding 4's fix has to read the real
  // banner, not a hand-written guess).
  const banner =
    "2026-11-10T22:00:08Z INF |  https://territory-enlargement-plane-ripe.trycloudflare.com                                |\n";

  const children: StoppableChild[] = [];
  const origins: Array<string | undefined> = [];
  const launcher = createLauncher(
    options(["--access", "cloudflare", "--data", dir]),
    deps({
      serverEntry: { command: "node", args: ["server.ts"] },
      spawnChild: () => {
        const child = new StoppableChild();
        children.push(child);
        // The tunnel announces its URL on its own schedule, after the spawn.
        if (children.length === 1) setImmediate(() => child.stdout.emit("data", banner));
        return child;
      },
      mintOwnerLink: async (_dir, origin) => {
        origins.push(origin);
        return origin ? { link: `${origin}/login?token=x`, minted: true } : "no-origin";
      },
      cloudflaredBinary: "/x/cloudflared",
      tunnelUrlTimeoutMs: 5_000,
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.deepEqual(origins, [undefined, "https://territory-enlargement-plane-ripe.trycloudflare.com"]);
  assert.equal(children.length, 2, "the tunnel first (to learn the origin), then the server");
  // The stored credential is for the origin the owner will actually open.
  const stored = await readFile(join(dir, "owner-link.txt"), "utf8");
  assert.match(stored, /^https:\/\/territory-enlargement-plane-ripe\.trycloudflare\.com\/login\?token=x$/m);
  await launcher.stop();
  await rm(dir, { recursive: true, force: true });
});

test("a fresh cloudflare start with no tunnel URL refuses instead of booting ownerless", async () => {
  const spawned: StoppableChild[] = [];
  const origins: Array<string | undefined> = [];
  let released = false;
  const launcher = createLauncher(
    options(["--access", "cloudflare"]),
    deps({
      acquireLock: async () => ({
        ok: true as const,
        lock: { path: "/tmp/lock", pid: 1, release: async () => void (released = true) },
      }),
      serverEntry: { command: "node", args: ["server.ts"] },
      spawnChild: () => {
        const child = new StoppableChild();
        spawned.push(child);
        return child;
      },
      mintOwnerLink: async (_dir, origin) => {
        origins.push(origin);
        return "no-origin";
      },
      cloudflaredBinary: "/x/cloudflared",
      tunnelUrlTimeoutMs: 20,
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, false);
  assert.equal(result.code, 6);
  assert.match(result.message ?? "", /reported no URL within 20 ms/);
  // A loopback link is a credential nobody can use, so it is never minted — and
  // with no URL there is not even a second mint attempt to make.
  assert.deepEqual(origins, [undefined]);
  assert.equal(spawned.length, 1, "the tunnel only: an ownerless server would crash-loop");
  // The refusal is a clean stop, not a leak: the tunnel child and the lock are gone.
  assert.ok(spawned[0]!.kills > 0, "the tunnel was stopped");
  assert.equal(released, true, "the data-directory lock was released");
});

test("--reissue-owner in cloudflare mode rotates onto the tunnel origin", async () => {
  // The runbook's "rotate onto the current tunnel origin" only works if the
  // reissue also waits for the tunnel: with no origin the mint refuses.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-reissue-"));
  const children: StoppableChild[] = [];
  const origins: Array<string | undefined> = [];
  const launcher = createLauncher(
    options(["--access", "cloudflare", "--data", dir, "--reissue-owner"]),
    deps({
      serverEntry: { command: "node", args: ["server.ts"] },
      spawnChild: () => {
        const child = new StoppableChild();
        children.push(child);
        if (children.length === 1) {
          setImmediate(() =>
            child.stdout.emit("data", "INF |  https://d-e-f.trycloudflare.com  |\n"),
          );
        }
        return child;
      },
      mintOwnerLink: async (_dir, origin) => {
        origins.push(origin);
        return origin ? { link: `${origin}/login?token=x`, minted: true } : "no-origin";
      },
      cloudflaredBinary: "/x/cloudflared",
      tunnelUrlTimeoutMs: 5_000,
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.deepEqual(origins, [undefined, "https://d-e-f.trycloudflare.com"]);
  await launcher.stop();
  await rm(dir, { recursive: true, force: true });
});
