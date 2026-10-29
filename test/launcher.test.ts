import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLauncher, type LauncherDeps } from "../src/launcher/main.ts";
import type { ChildLike } from "../src/launcher/supervisor.ts";
import { parseOptions } from "../src/launcher/options.ts";

class FakeChild extends EventEmitter implements ChildLike {
  readonly pid = 9001;
  kill(): boolean {
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
    env: { PUPKEEP_BIND_HOST: "100.90.202.61", PUPKEEP_PORT: "9000" },
  });
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

test("nothing is announced when the auth module cannot mint a link yet", async () => {
  const d = deps({ serverEntry: { command: "node", args: ["server.ts"] } });
  const launcher = createLauncher(options(), d);
  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.equal(result.ownerLink, undefined);
  assert.match(d.logs.join("\n"), /P1-06/);
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
