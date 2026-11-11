// The phone scripts run where nobody can watch them: `~/.termux/boot` at reboot,
// and under `sv`/runit. Both start a process with a minimal environment — no
// PATH, and on the daily phone no PREFIX or HOME either — so the failure that
// matters is not "the script is wrong" but "the script needs something that is
// not there at that moment".
//
// That is exactly what P5-01b found on 2026-11-10: after a real reboot the app
// was down, no `boot:` line was written, and the cause was two environment
// assumptions — a `#!/usr/bin/env bash` shebang that cannot resolve on Termux
// (there is no `/usr/bin/env`) and `set -u` reaching an unset `PREFIX`.
//
// These tests run the real scripts with `env` replaced entirely, so a regression
// has to be a real one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): Promise<string> => readFile(join(ROOT, path), "utf8");

interface Phone {
  readonly root: string;
  readonly bin: string;
  readonly prefix: string;
  readonly home: string;
  readonly data: string;
  /** Replace an existing environment entirely, the way runit and Termux:Boot do. */
  run(script: string, args: readonly string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string };
  cleanup(): Promise<void>;
}

/** A fake Termux: a prefix with `bin/`, stub binaries, and a data directory. */
async function makePhone(): Promise<Phone> {
  const root = await mkdtemp(join(tmpdir(), "pupkeep-termux-"));
  const prefix = join(root, "prefix");
  const bin = join(prefix, "bin");
  const home = join(root, "home");
  const data = join(root, "data");
  await mkdir(bin, { recursive: true });
  await mkdir(join(prefix, "etc", "ssh"), { recursive: true });
  await mkdir(home, { recursive: true });

  // Only what the scripts actually call, so the PATH really is minimal: the
  // scripts must find these through the PATH they set themselves.
  for (const tool of ["mkdir", "chmod", "mv", "cat", "awk", "tr", "sleep", "dirname", "basename", "touch", "rm"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    assert.ok(found !== "", `${tool} is needed to build the fake phone`);
    await symlink(found, join(bin, tool));
  }

  const stub = async (name: string, body: string): Promise<void> => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };

  await stub("date", "echo 2026-11-10T15:00:00+01:00");
  await stub("termux-wake-lock", "exit 0");
  // The launcher itself: record the arguments the boot script execs it with.
  await stub("node", 'printf "%s\\n" "$@" > "$NODE_ARGS_FILE"');
  // A tailnet address only when the test asks for one (Tailscale up or down).
  await stub(
    "ip",
    `if [ -n "\${TAILNET_ADDRESS:-}" ]; then
  echo "3: tun1    inet $TAILNET_ADDRESS/32 scope global tun1"
fi`,
  );
  await stub("ifconfig", "exit 0");
  await stub("ssh-keygen", `touch "${prefix}/etc/ssh/ssh_host_ed25519_key"`);
  await stub("pgrep", "exit 1");
  await stub(
    "sshd",
    `if [ "\${1:-}" = "--sleep" ]; then
  sleep 30
  exit 0
fi
"$0" --sleep </dev/null >/dev/null 2>&1 &
echo "$!" > "$(awk '$1 == "PidFile" { print $2 }' "$2")"`,
  );
  // `ssh -G` answers with whatever the test wrote, so the preflight is exercised
  // against a real effective-config shape instead of a guess.
  await stub(
    "ssh",
    `if [ "\${1:-}" = "-G" ]; then
  cat "$SSH_G_OUT" 2>/dev/null
  exit 0
fi
printf "%s\\n" "$@" >> "$SSH_ARGS_FILE"`,
  );

  return {
    root,
    bin,
    prefix,
    home,
    data,
    run(script, args, env) {
      const result = spawnSync("bash", [join(ROOT, script), ...args], {
        encoding: "utf8",
        // Deliberately not spreading process.env: the whole point is that these
        // scripts cannot rely on it.
        env,
      });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("the boot script starts the app with no PATH and no HOME, and writes the boot line", async () => {
  const phone = await makePhone();
  const nodeArgs = join(phone.root, "node-args");
  try {
    const result = phone.run("scripts/termux-boot.sh", [], {
      PREFIX: phone.prefix,
      PUPKEEP_DATA_DIR: phone.data,
      TAILNET_ADDRESS: "100.101.102.61",
      NODE_ARGS_FILE: nodeArgs,
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    const log = await readFile(join(phone.data, "server.log"), "utf8");
    assert.match(log, /^boot: 2026-11-10T15:00:00\+01:00 \(boot_id /m, "the boot line is the reboot marker");
    assert.match(log, /termux-sshd: listening on 100\.101\.102\.61:8022/);

    // The launcher is exec'd with the same flags `npm start` uses, so the boot
    // path is one entry point rather than a second variant of the app.
    const args = (await readFile(nodeArgs, "utf8")).trim().split("\n");
    assert.deepEqual(args, [
      "--env-file-if-exists=.env",
      "bin/pupkeep.js",
      "--access",
      "tailscale",
      "--boot",
      "--data",
      phone.data,
    ]);
  } finally {
    await phone.cleanup();
  }
});

test("the boot script still starts the app when sshd cannot (no Tailscale)", async () => {
  // A phone with no operator shell beats a phone with no care app: the sshd
  // failure is logged and the launcher runs anyway.
  const phone = await makePhone();
  const nodeArgs = join(phone.root, "node-args");
  try {
    const result = phone.run("scripts/termux-boot.sh", [], {
      PREFIX: phone.prefix,
      PUPKEEP_DATA_DIR: phone.data,
      NODE_ARGS_FILE: nodeArgs,
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const log = await readFile(join(phone.data, "server.log"), "utf8");
    assert.match(log, /sshd not started; run scripts\/termux-sshd\.sh/);
    assert.match(log, /^boot: /m);
    assert.match(await readFile(nodeArgs, "utf8"), /--access\n?tailscale/);
  } finally {
    await phone.cleanup();
  }
});

test("the tunnel refuses a config that already owns the remote port", async () => {
  const phone = await makePhone();
  const g = join(phone.root, "ssh-g");
  try {
    // The exact shape that cost an hour on 2026-11-10: an interactive session's
    // RemoteForward wins the bind, and the supervised tunnel then cannot have it.
    await writeFile(
      g,
      [
        "hostname vps.example",
        "user ubuntu",
        "remoteforward 0.0.0.0:8022 127.0.0.1:8022",
        "localforward 127.0.0.1:8787 127.0.0.1:8787",
        "",
      ].join("\n"),
    );
    // `--dry-run` is the "check and tell me" mode: it runs the preflights once
    // and exits with their verdict instead of retrying under a supervisor.
    const result = phone.run("scripts/termux-tunnel.sh", ["oracle", "--dry-run"], {
      PREFIX: phone.prefix,
      PUPKEEP_DATA_DIR: phone.data,
      SSH_G_OUT: g,
      TAILNET_ADDRESS: "100.101.102.61",
    });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /already forwards remote port 8022/);
    assert.match(result.stderr, /Remove the RemoteForward line/, "the message says what to do");
  } finally {
    await phone.cleanup();
  }
});

test("the tunnel refuses when sshd is not listening, instead of accepting and resetting", async () => {
  const phone = await makePhone();
  const g = join(phone.root, "ssh-g");
  try {
    await writeFile(g, "hostname vps.example\nuser ubuntu\n");
    const result = phone.run("scripts/termux-tunnel.sh", ["oracle", "--dry-run"], {
      PREFIX: phone.prefix,
      PUPKEEP_DATA_DIR: phone.data,
      SSH_G_OUT: g,
    });
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stderr, /accept and reset/);
  } finally {
    await phone.cleanup();
  }
});

test("the tunnel builds one supervised ssh command and nothing else", async () => {
  const phone = await makePhone();
  const g = join(phone.root, "ssh-g");
  try {
    await writeFile(g, "hostname vps.example\nuser ubuntu\n");
    const result = phone.run("scripts/termux-tunnel.sh", ["oracle", "--dry-run"], {
      PREFIX: phone.prefix,
      PUPKEEP_DATA_DIR: phone.data,
      SSH_G_OUT: g,
      TAILNET_ADDRESS: "100.101.102.61",
    });
    assert.equal(result.status, 0, result.stderr);
    const command = result.stdout.trim();
    // The remote bind is explicit: `-R 8022:...` binds the VPS's loopback, which
    // nothing outside the VPS can reach.
    assert.match(command, /-R 0\.0\.0\.0:8022:127\.0\.0\.1:8022/);
    // A stranded port is a loud failure, not a warning nobody reads.
    assert.match(command, /-o ExitOnForwardFailure=yes/);
    assert.match(command, /-o ServerAliveInterval=15/);
    assert.match(command, / oracle$/);
  } finally {
    await phone.cleanup();
  }
});

test("the scripts never depend on the repo shebang for an exec", async () => {
  // The repo keeps `#!/usr/bin/env bash` so the devcontainer can run and parse the
  // scripts; Termux has no `/usr/bin/env`, so anything *exec'd* from them must
  // pass the interpreter. This is the assertion that would have caught P5-01b.
  const boot = await read("scripts/termux-boot.sh");
  assert.match(boot, /"\$\{BASH:-\$\{PREFIX\}\/bin\/bash\}" "\$REPO_ROOT\/scripts\/termux-sshd\.sh"/);
  // …and the environment it needs is established before the first use.
  assert.match(boot, /^: "\$\{PREFIX:=/m);
  assert.match(boot, /^: "\$\{HOME:=/m);
  assert.match(boot, /^PATH="\$\{PREFIX\}\/bin:/m);

  const tunnel = await read("scripts/termux-tunnel.sh");
  assert.match(tunnel, /^: "\$\{PREFIX:=/m);
  assert.match(tunnel, /^PATH="\$\{PREFIX\}\/bin:/m);
  assert.match(tunnel, /trap stop TERM INT/, "runsv signals the script, not its child");
});

test("the install script wires the boot wrapper and the tunnel unit with explicit interpreters", async () => {
  const install = await read("scripts/termux-install.sh");
  // The wrapper execs bash by absolute path: `exec <script>` would rely on the
  // shebang and fail under Termux:Boot's minimal environment.
  assert.match(install, /exec "%s\/bin\/bash" "%s\/scripts\/termux-boot\.sh"/);
  // The tunnel is opt-in and supervised, because SSH is not the product path.
  assert.match(install, /--with-tunnel/);
  assert.match(install, /var\/service\/pupkeep-tunnel/);
  assert.match(install, /termux-tunnel\.sh/);
  assert.match(install, /sv-enable pupkeep-tunnel/);
});
