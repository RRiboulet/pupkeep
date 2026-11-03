// P1-13: the phone runbook and the Termux scripts are the only part of the
// product a human follows by hand on the host, and every mistake in them is
// either a security mistake (a wildcard SSH bind, a token in the log) or an
// outage (a pinned tailnet address that stops binding). These tests are the
// cheap half of the check; P5-01/P5-04 walk the runbook on the phone.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { isTailscaleAddress } from "../src/launcher/access.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): Promise<string> => readFile(join(ROOT, path), "utf8");

const SCRIPTS = ["scripts/termux-install.sh", "scripts/termux-boot.sh", "scripts/termux-sshd.sh"];

test("the Termux scripts are executable bash and parse", async () => {
  for (const path of SCRIPTS) {
    const source = await read(path);
    assert.match(source, /^#!\/usr\/bin\/env bash\n/, `${path} needs the env bash shebang`);
    assert.match(source, /^set -euo pipefail$/m, `${path} must fail fast`);
    const mode = (await stat(join(ROOT, path))).mode;
    assert.ok(mode & 0o100, `${path} must be executable`);
    // A syntax error in a boot script is invisible until the phone reboots.
    const parsed = spawnSync("bash", ["-n", join(ROOT, path)], { encoding: "utf8" });
    assert.equal(parsed.status, 0, `${path}: ${parsed.stderr}`);
  }
});

test("the boot script runs the launcher through --boot and logs into the data dir", async () => {
  const boot = await read("scripts/termux-boot.sh");
  // `--boot` and a non-TTY stdout are both required; either alone is one edit
  // away from a boot that writes the owner token into server.log (PLAN §6.3).
  assert.match(boot, /--access tailscale/, "the boot path is the daily tailscale mode");
  assert.match(boot, /--boot/);
  assert.match(boot, /server\.log/);
  assert.match(boot, /termux-wake-lock/);
  // The supervised pid must *be* the launcher: `npm start` would put npm and its
  // `sh -c` in between, so `sv down` would signal npm and leave the launcher
  // holding `launcher.pid` — which refuses the restart runit then performs.
  assert.match(boot, /^exec "\$PREFIX\/bin\/node" \\$/m);
  assert.match(boot, /^ {2}bin\/pupkeep\.js \\$/m);
  assert.doesNotMatch(boot, /^exec .*npm/m);
  // The flags mirror `npm start`'s `--env-file-if-exists=.env`, so the boot path
  // is the same entry point with the same environment file.
  assert.match(boot, /^ {2}--env-file-if-exists=\.env \\$/m);
  // Operator SSH is attempted but never fatal: a phone with no shell beats a
  // phone with no care app.
  assert.match(boot, /if ! "\$REPO_ROOT\/scripts\/termux-sshd\.sh"/);
});

test("sshd is started on demand, re-resolves the tailnet address and never binds everything", async () => {
  const sshd = await read("scripts/termux-sshd.sh");
  // The P0-06 finding this script exists for: a stored address goes stale.
  assert.match(sshd, /100\\\.\(6\[4-9\]/, "the tailnet range is re-derived, not read from a file");
  assert.match(sshd, /tun/, "the tailnet interface is the one Tailscale creates");
  // Two listeners, and the second one is the resolved address.
  assert.match(sshd, /ListenAddress 127\.0\.0\.1/);
  assert.match(sshd, /ListenAddress \$\{address\}/);
  assert.doesNotMatch(sshd, /ListenAddress\s+0\.0\.0\.0/, "a wildcard SSH bind is never an option");
  assert.doesNotMatch(sshd, /ListenAddress\s+::/, "nor is the IPv6 wildcard");
  // Fail closed: no address means no sshd, with an actionable message.
  assert.match(sshd, /Tailscale is not connected/);
  // Port and key handling are Termux defaults, not guesses.
  assert.match(sshd, /PUPKEEP_SSH_PORT:-8022/);
  assert.match(sshd, /ssh-keygen -A/);
  assert.match(sshd, /PasswordAuthentication no/);
  // A stray sshd (the old all-interfaces config) would otherwise surface as a
  // bare "Address already in use".
  assert.match(sshd, /pgrep -x sshd/);
});

test("the install script pins cloudflared by version and checksum and refuses a non-arm64 host", async () => {
  const install = await read("scripts/termux-install.sh");
  assert.match(install, /CLOUDFLARED_VERSION=2026\.10\.5/);
  assert.match(install, /CLOUDFLARED_SHA256_ARM64=[0-9a-f]{64}/);
  // The checksum is verified, not printed: a bare download would make a rebuild
  // a different binary (PLAN §5.1 says the same for the devcontainer).
  assert.match(install, /sha256sum -c -/);
  assert.match(install, /aarch64 \| arm64/);
  // The package list is an allowlist, not a search: `cloudflared` does not exist
  // in the Termux repo (P0-03) and nothing else may appear without this test
  // being edited deliberately.
  assert.match(
    install,
    /pkg install -y \\\n  nodejs git curl termux-api sqlite rclone age expect tar termux-services tmux openssh/,
  );
  assert.match(install, /npm ci --omit=dev/);
  // The boot wrapper is a hop into the tracked script, not a second copy of it.
  assert.match(install, /\.termux\/boot/);
  assert.match(install, /termux-boot\.sh/);
});

test("the runbook is the operator path: modes, boot, sshd, tunnel wrapper, notifications, backup", async () => {
  const doc = await read("docs/PHONE-RUNBOOK.md");
  for (const needle of [
    "--access tailscale",
    "--access cloudflare",
    "--reissue-owner",
    "owner-link.txt",
    "scripts/termux-install.sh",
    "scripts/termux-boot.sh",
    "scripts/termux-sshd.sh",
    "termux-wake-lock",
    "Termux:Boot",
    "ntfy",
    "8022",
    "128 bits",
    "npm run backup",
    "npm run restore",
  ]) {
    assert.ok(doc.includes(needle), `the runbook must mention ${needle}`);
  }
  // The payload rule that makes a third-party relay acceptable (P0-08).
  assert.match(doc, /category-only/i);
  // PLAN §6.7's wrapper, verbatim enough that copying it works.
  assert.match(doc, /SSL_CERT_FILE=\/etc\/tls\/cert\.pem termux-chroot/);
  // The limits that keep the product honest, stated where an operator will read
  // them rather than only in the plan.
  assert.match(doc, /HTTP, not HTTPS|no service worker, no PWA install and no Web Push/);
  assert.match(doc, /testing only|Testing only/);
});

test("the runbook carries no credential and no real host address", async () => {
  const doc = await read("docs/PHONE-RUNBOOK.md");
  // The guardrail: reference the owner link by path, never paste one. A shape
  // placeholder (`?token=…`) is how the runbook explains the tunnel sign-in;
  // an actual value is what must never appear.
  assert.doesNotMatch(doc, /[?&](token|invite|code)=[A-Za-z0-9_%.-]{4,}/, "no token or invite value");
  assert.doesNotMatch(doc, /pupkeep_owner|owner_token/i);
  // Example addresses stay placeholders, so a copied command cannot be aimed at
  // somebody's phone, and a real one cannot be committed by accident.
  assert.doesNotMatch(doc, /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}:8787/, "use 100.x.y.z in examples");
  assert.match(doc, /100\.x\.y\.z/);
  // A bare quick-tunnel hostname is a live origin; only the shape belongs here.
  assert.doesNotMatch(doc, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  assert.match(doc, /https:\/\/<random>\.trycloudflare\.com/);
});

test("every script in scripts/ is listed in the plan's repository layout", async () => {
  // PLAN §4 is the layout the plan promises; a script nobody documented is one a
  // new operator will not find in the runbook either.
  const plan = await read("docs/PLAN.md");
  const layout = plan.slice(plan.indexOf("## 4. Repository layout"), plan.indexOf("## 5. Devcontainer"));
  for (const path of [...SCRIPTS, "scripts/backup.ts", "scripts/restore.ts"]) {
    const name = path.replace("scripts/", "");
    assert.ok(layout.includes(name), `PLAN §4 must list ${path}`);
  }
});

test("the plan records P1-13 as landed", async () => {
  const plan = await read("docs/PLAN.md");
  const entry = /- \[x\] \*\*P1-13\*\*[\s\S]*?(?=\n- \[)/.exec(plan);
  assert.ok(entry, "PLAN §16 must tick P1-13");
  // The draft is honest about what is not done: a phone walk remains P5-01/P5-04.
  assert.match(entry[0], /P5-0[14]/);
});

// The scripts only ever run on a phone, which is exactly why their logic has to
// be exercised somewhere else. This drives `scripts/termux-sshd.sh` against
// stubs: `ip` reporting a tailnet interface, `ssh-keygen`/`sshd` standing in for
// Termux's binaries. It asserts the config the phone would run, the refusal when
// Tailscale is down, and the restart when the address moved — the three
// behaviours P0-06 lost the operator shell over.
test("termux-sshd.sh writes a two-listener config, fails closed and follows the address", async () => {
  const { mkdtemp, mkdir, writeFile, chmod, readFile: rf } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "pupkeep-sshd-"));
  const bin = join(root, "bin");
  const prefix = join(root, "prefix");
  const home = join(root, "home");
  const data = join(root, "data");
  await mkdir(bin, { recursive: true });
  await mkdir(join(prefix, "etc", "ssh"), { recursive: true });
  await mkdir(home, { recursive: true });

  const stub = async (name: string, body: string): Promise<void> => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };

  // `ip -o -4 addr show`: loopback, Wi-Fi and a Tailscale tunnel.
  await stub(
    "ip",
    `if [ -n "\${TAILNET_ADDRESS:-}" ]; then
  echo "3: tun1    inet $TAILNET_ADDRESS/32 scope global tun1"
fi
echo "1: lo    inet 127.0.0.1/8 scope host lo"
echo "2: wlan0    inet 192.168.1.20/24 scope global wlan0"`,
  );
  // The fallback parser: `ip` and `ifconfig` ship in different Termux packages.
  await stub(
    "ifconfig",
    `if [ -n "\${IFCONFIG_ADDRESS:-}" ]; then
  echo "tun1: flags=4305<UP,POINTOPOINT,RUNNING,NOARP,MULTICAST>  mtu 1500"
  echo "        inet $IFCONFIG_ADDRESS  netmask 255.255.255.255  destination $IFCONFIG_ADDRESS"
fi`,
  );
  await stub("ssh-keygen", `touch "${prefix}/etc/ssh/ssh_host_ed25519_key"`);
  await stub("pgrep", "exit 1");
  // sshd daemonises: leave a live process named after the stub in the PidFile the
  // config asks for. The re-exec matters — `running_pid` refuses a pid whose
  // /proc cmdline is not sshd, so a plain `sleep` would look like a stale file.
  await stub(
    "sshd",
    `if [ "\${1:-}" = "--sleep" ]; then
  sleep 30
  exit 0
fi
"$0" --sleep </dev/null >/dev/null 2>&1 &
echo "$!" > "$(awk '$1 == "PidFile" { print $2 }' "$2")"`,
  );

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    PREFIX: prefix,
    PUPKEEP_DATA_DIR: data,
  };
  const run = (address: string | undefined, interfaces: { ifconfig?: string } = {}) =>
    spawnSync("bash", [join(ROOT, "scripts/termux-sshd.sh")], {
      encoding: "utf8",
      env: { ...env, TAILNET_ADDRESS: address ?? "", IFCONFIG_ADDRESS: interfaces.ifconfig ?? "" },
    });

  // 1. Tailscale down: no address, no sshd, a message an operator can act on.
  const refused = run("");
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /Tailscale is not connected/);
  await assert.rejects(rf(join(data, "sshd", "sshd_config")), "no config is written without an address");

  // 1b. The script's rule and the launcher's rule are the same rule. If one is
  // widened to all of 100/8, this is where it shows: the launcher is the
  // authority (`src/launcher/access.ts`) and the phone must not disagree.
  for (const outside of ["100.63.255.255", "100.128.0.1", "192.168.1.20"]) {
    assert.equal(isTailscaleAddress(outside), false, `${outside} is not in 100.64.0.0/10`);
    const refusedOutside = run(outside);
    assert.equal(refusedOutside.status, 2, outside);
    assert.match(refusedOutside.stderr, /Tailscale is not connected/);
  }
  assert.equal(isTailscaleAddress("100.101.102.61"), true);

  // 2. Tailscale up: two listeners, the tailnet one and loopback, never a wildcard.
  const started = run("100.101.102.61");
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /listening on 100\.101\.102\.61:8022/);
  const config = await rf(join(data, "sshd", "sshd_config"), "utf8");
  assert.match(config, /^Port 8022$/m);
  assert.match(config, /^ListenAddress 127\.0\.0\.1$/m);
  assert.match(config, /^ListenAddress 100\.101\.102\.61$/m);
  assert.doesNotMatch(config, /ListenAddress 0\.0\.0\.0/);
  assert.doesNotMatch(config, /192\.168\.1\.20/, "the Wi-Fi address is never a listener");
  assert.match(config, /^HostKey .*ssh_host_ed25519_key$/m);
  assert.match(config, /^PasswordAuthentication no$/m);
  assert.match(config, /^PermitRootLogin no$/m);

  // 3. Same address again: reuse, do not restart and do not churn the pid.
  const reused = run("100.101.102.61");
  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, /already listening/);

  // 3b. A pid file left behind pointing at an unrelated live process is not our
  // sshd: the script starts its own instead of reporting a listener that is not
  // there (and, on the restart path, instead of killing a stranger).
  const { spawn } = await import("node:child_process");
  const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    await writeFile(join(data, "sshd", "sshd.pid"), `${stranger.pid}\n`);
    const recycled = run("100.101.102.61");
    assert.equal(recycled.status, 0, recycled.stderr);
    assert.doesNotMatch(recycled.stdout, /already listening/);
    assert.match(recycled.stdout, /listening on 100\.101\.102\.61:8022/);
  } finally {
    stranger.kill("SIGKILL");
  }

  // 4. The address moved: the stale listener is stopped and the config follows.
  const moved = run("100.101.102.62");
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /the tailnet address or port changed/);
  const updated = await rf(join(data, "sshd", "sshd_config"), "utf8");
  assert.match(updated, /^ListenAddress 100\.101\.102\.62$/m);
  assert.doesNotMatch(updated, /^ListenAddress 100\.101\.102\.61$/m);

  // 5. `ip` present but blind (no permission, an odd build) must not be the last
  // word: the ifconfig fallback finds the same address and the config follows.
  const fallback = run(undefined, { ifconfig: "100.101.102.70" });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /listening on 100\.101\.102\.70:8022/);
  const viaIfconfig = await rf(join(data, "sshd", "sshd_config"), "utf8");
  assert.match(viaIfconfig, /^ListenAddress 100\.101\.102\.70$/m);
});
