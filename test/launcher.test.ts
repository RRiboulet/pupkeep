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

test("a deleted access mode fails closed: refusal before anything is spawned (P6-08)", async () => {
  // `parseOptions` refuses `tailscale`/`cloudflare` now, so this test builds the
  // options directly: a caller that bypasses the parser still must not get a
  // listener configured the way a deleted mode used to be.
  let spawned = false;
  const launcher = createLauncher(
    {
      mode: "cloudflare" as Parameters<typeof createLauncher>[0]["mode"],
      port: 8787,
      dataDir: "/home/owner/.pupkeep",
      boot: true,
      reissueOwner: false,
      retryParked: false,
      help: false,
      interactive: false,
    },
    deps({
      spawnChild: () => {
        spawned = true;
        return new FakeChild();
      },
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.match(result.message ?? "", /unknown access mode/);
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
    options(["--access", "lan", "--port", "9000"]),
    deps({
      interfaces: () => [{ name: "wlan0", address: "192.168.178.20", family: "IPv4", internal: false }],
      serverEntry: { command: "node", args: ["server.ts"] },
      spawnChild: (command, args, env) => {
        spawned.push({ command, args, env });
        return new FakeChild();
      },
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.equal(result.plan?.bindHost, "0.0.0.0");
  assert.deepEqual(spawned[0], {
    command: "node",
    args: ["server.ts"],
    env: {
      PUPKEEP_BIND_HOST: "0.0.0.0",
      PUPKEEP_PORT: "9000",
      PUPKEEP_DATA_DIR: "/home/owner/.pupkeep",
    },
  });
  await launcher.stop();
});

test("public mode forwards the normalised origin to the server environment", async () => {
  const parsed = parseOptions(
    ["--access", "public", "--port", "9000"],
    {
      PUPKEEP_PUBLIC_ORIGIN: "https://PUPPKEEP.example:443/",
      // Public mode requires the proxy address too; it reaches the server through
      // the inherited environment, not through `serverEnv` (P6/R4).
      PUPKEEP_TRUSTED_PROXY: "172.28.0.11",
    },
    HOME,
  );
  assert.ok(parsed.ok);
  const spawned: Array<Record<string, string>> = [];
  const launcher = createLauncher(
    parsed.options,
    deps({
      serverEntry: { command: "node", args: ["server.ts"] },
      spawnChild: (_command, _args, env) => {
        spawned.push(env);
        return new StoppableChild();
      },
    }),
  );

  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.equal(spawned[0]?.PUPKEEP_PUBLIC_ORIGIN, "https://puppkeep.example");
  assert.equal(result.plan?.origin, "https://puppkeep.example");
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

test("the server's restart line carries the exit code and signal, like the supervisor's own", async () => {
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
  });
  const launcher = createLauncher(options(["--access", "local"]), d);

  await launcher.start();
  // P5-01b cell 5: a bare `server restart 3 in 4000 ms` left the operator without
  // the cause; the line must name the code and the signal it died from.
  children[0]!.emit("exit", null, "SIGKILL");
  assert.match(d.logs.join("\n"), /server exited \(code null, signal SIGKILL\); restart 1 in 1000 ms/);
  await launcher.stop();
});

test("the owner link is minted for the origin the owner will actually open", async () => {
  const origins: Array<string | undefined> = [];
  const launcher = createLauncher(
    options(["--access", "lan"]),
    deps({
      interfaces: () => [{ name: "wlan0", address: "192.168.178.20", family: "IPv4", internal: false }],
      serverEntry: { command: "node", args: ["server.ts"] },
      mintOwnerLink: async (_dir, origin) => {
        origins.push(origin);
        return { link: "http://192.168.178.20:8787/login?token=t", minted: true };
      },
    }),
  );

  await launcher.start();
  assert.deepEqual(origins, ["http://192.168.178.20:8787"]);
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

