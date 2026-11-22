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

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): Promise<string> => readFile(join(ROOT, path), "utf8");

/**
 * 100.64.0.0/10, the same shape `scripts/termux-sshd.sh` re-derives for its own
 * bind decision. The launcher's copy of this predicate is gone with the retired
 * `tailscale` mode (P6-08); the sshd script is operator tooling and keeps its
 * own range check, which this test pins independently of any launcher code.
 */
function isTailnetAddress(address: string): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(address);
  if (!match) return false;
  return match[1] === "100" && Number(match[2]) >= 64 && Number(match[2]) <= 127;
}

const SCRIPTS = [
  "scripts/termux-install.sh",
  "scripts/termux-boot.sh",
  "scripts/termux-sshd.sh",
  "scripts/termux-tunnel.sh",
];

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
  // The mode is `lan` (P6-08): plain HTTP on the household LAN, with the
  // launcher's RFC1918 guard as the fail-closed safety net.
  assert.match(boot, /--access lan/, "the boot path is the offline LAN fallback");
  assert.doesNotMatch(boot, /--access (tailscale|cloudflare)/, "the retired modes are gone");
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
  // Operator SSH is attempted but never fatal, and never waited on: the app's
  // access mode no longer depends on the tailnet (P6-08), so a slow Tailscale
  // reconnect cannot hold the care app hostage at boot.
  assert.match(boot, /"\$\{BASH:-\$\{PREFIX\}\/bin\/bash\}" "\$REPO_ROOT\/scripts\/termux-sshd\.sh"/);
  assert.match(boot, /sshd not started/, "a failed sshd attempt is logged, not fatal");
  assert.doesNotMatch(boot, /TAILNET_WAIT/, "the boot-time tailnet wait is gone with the mode");
  assert.doesNotMatch(boot, /sleep /, "and with it every boot-time polling loop");
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

test("the install script refuses a non-arm64 host and installs only the package allowlist", async () => {
  const install = await read("scripts/termux-install.sh");
  // The cloudflared pin is gone with the retired `cloudflare` mode (P6-08); a
  // re-introduced third-party binary download would be a new decision, not a
  // forgotten leftover, so its absence is asserted rather than assumed.
  assert.doesNotMatch(install, /cloudflared/i);
  assert.doesNotMatch(install, /CLOUDFLARED_/);
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

test("the runbook is the fallback operator path: three modes, boot, sshd, notifications, backup", async () => {
  const doc = await read("docs/PHONE-RUNBOOK.md");
  for (const needle of [
    "--access lan",
    "--access local",
    "public",
    "--reissue-owner",
    "owner-link.txt",
    "scripts/termux-install.sh",
    "scripts/termux-boot.sh",
    "scripts/termux-sshd.sh",
    "scripts/termux-tunnel.sh",
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
  // P6-08: the retired modes are named as deleted, never offered as commands,
  // and the quick tunnel's chroot wrapper is gone with the mode.
  assert.match(doc, /`--access tailscale`[^.]*deleted|deleted[^.]*`--access tailscale`/);
  assert.doesNotMatch(doc, /npm start -- --access (tailscale|cloudflare)/);
  assert.doesNotMatch(doc, /SSL_CERT_FILE=\/etc\/tls\/cert\.pem termux-chroot/);
  assert.doesNotMatch(doc, /trycloudflare/i);
  // The limits that keep the product honest, stated where an operator will read
  // them rather than only in the plan: the fallback is HTTP and the box is the
  // HTTPS path.
  assert.match(doc, /no service worker, no PWA install and no Web Push/);
  assert.match(doc, /public origin/);
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
  // The tunnel mode is deleted (P6-08), so the runbook carries neither a live
  // tunnel origin nor a placeholder for one. A bare quick-tunnel hostname was a
  // live origin when the mode existed; the shape placeholder went with it.
  assert.doesNotMatch(doc, /trycloudflare/i);
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

test("the plan records P6-08 as landed, with what it deleted and deliberately left", async () => {
  const plan = await read("docs/PLAN.md");
  const entry = /- \[x\] \*\*P6-08\*\*[\s\S]*?(?=\n- \[)/.exec(plan);
  assert.ok(entry, "PLAN §16 must tick P6-08");
  // The deletion itself, and the one mode the fallback keeps.
  assert.match(entry[0], /local \| lan \| public/);
  assert.match(entry[0], /--access lan/);
  assert.match(entry[0], /termux\.ts/);
  // The two things left on purpose, named so a later cleanup does not "finish"
  // the retirement by deleting the dev container's HTTPS tool or the operator's
  // SSH path.
  assert.match(entry[0], /devcontainer\.test\.ts/);
  assert.match(entry[0], /operator tooling/);
  // The plan must not still claim the modes parse "until P6-08".
  assert.doesNotMatch(plan, /still parses until/);
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

  // 1b. The script's range rule is its own now (P6-08 deleted the launcher's
  // copy), so this pins it in isolation: if it is widened to all of 100/8,
  // sshd would bind an address outside the tailnet's shared space.
  for (const outside of ["100.63.255.255", "100.128.0.1", "192.168.1.20"]) {
    assert.equal(isTailnetAddress(outside), false, `${outside} is not in 100.64.0.0/10`);
    const refusedOutside = run(outside);
    assert.equal(refusedOutside.status, 2, outside);
    assert.match(refusedOutside.stderr, /Tailscale is not connected/);
  }
  assert.equal(isTailnetAddress("100.101.102.61"), true);

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

// --- P4-09: the caregivers' access and notification guide -------------------

const ACCESS_GUIDE = "docs/access-and-notifications.md";

test("the caregivers' guide covers the public origin, the invite, Web Push, ntfy and the fallback", async () => {
  const doc = await read(ACCESS_GUIDE);
  for (const needle of [
    // The daily origin, and the invite flow the Settings card implements.
    "https://pupkeep.duckdns.org",
    "Invite your partner",
    "15 minutes",
    // The notification paths, with the in-app centre named as the record.
    "notification centre",
    "Web Push",
    "ntfy",
    "128 bits",
    // The device step and iOS's gate.
    "Enable notifications on this device",
    "iOS 16.4",
    // The fallback, and the two things it cannot carry.
    "LAN fallback",
    "no Web Push",
  ]) {
    assert.ok(doc.includes(needle), `the guide must mention ${needle}`);
  }
  // The limits that keep the product honest for a *user* (not only an operator).
  assert.match(doc, /plain HTTP/);
  assert.match(doc, /no named tunnel/i);
  assert.match(doc, /category-only/i);
  // A decision cannot be taken from a notification; the guide names the Agent
  // screen's proposal card as the place a caregiver decides.
  assert.match(doc, /never.*notification|never.*in a notification/i);
  assert.match(doc, /Waiting for your confirmation/);
  assert.match(doc, /\bConfirm\b/);
  assert.match(doc, /\bDecline\b/);
  assert.match(doc, /24 hours/);
  // The partner-delivery claim stays with P0-10.
  assert.match(doc, /P0-10/);
});

test("the caregivers' guide carries no credential, topic or real host address", async () => {
  const doc = await read(ACCESS_GUIDE);
  // Same guardrail as the operator runbook: reference secrets by path or shape.
  assert.doesNotMatch(doc, /[?&](token|invite|code)=[A-Za-z0-9_%.-]{4,}/, "no token, invite or code value");
  assert.doesNotMatch(doc, /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}:8787/);
  assert.match(doc, /192\.168\.x\.y:8787/, "the LAN example stays a placeholder");
  // The mode is deleted (P6-08): the guide must not carry a tunnel origin or a
  // placeholder for one.
  assert.doesNotMatch(doc, /trycloudflare/i, "no tunnel origin: the mode is gone");
  // An ntfy topic is a bearer secret; the guide must talk about it, never show one.
  assert.doesNotMatch(doc, /\bntfy\.sh\/[A-Za-z0-9_-]{22,}/, "no real ntfy topic");
});

test("the plan records P4-09 as landed and lists the guide in the layout", async () => {
  const plan = await read("docs/PLAN.md");
  const entry = /- \[x\] \*\*P4-09\*\*[\s\S]*?(?=\n- \[)/.exec(plan);
  assert.ok(entry, "PLAN §16 must tick P4-09");
  // The two limits the task exists to keep straight.
  assert.match(entry[0], /P0-10/);
  assert.match(entry[0], /named tunnel/i);
  const layout = plan.slice(plan.indexOf("## 4. Repository layout"), plan.indexOf("## 5. Devcontainer"));
  assert.ok(layout.includes("access-and-notifications.md"), "PLAN §4 must list the caregivers' guide");
});
