import assert from "node:assert/strict";
import { test } from "node:test";
import { detectTermux, parseTunnelUrl, tunnelChanged, tunnelCommand, TERMUX_CERT_FILE } from "../src/launcher/tunnel.ts";

// P0-03's finding, encoded: on the phone the raw binary does not work, and the
// launcher must never spawn it directly (PLAN §6.7).

test("on Termux the command is the chroot wrapper with the CA bundle", () => {
  const command = tunnelCommand({
    port: 8787,
    binary: "/data/data/com.termux/files/home/.pupkeep/bin/cloudflared",
    termux: true,
  });

  assert.equal(command.command, "termux-chroot");
  assert.deepEqual(command.args, [
    "/data/data/com.termux/files/home/.pupkeep/bin/cloudflared",
    "tunnel",
    "--no-autoupdate",
    "--url",
    "http://127.0.0.1:8787",
  ]);
  assert.deepEqual(command.env, { SSL_CERT_FILE: TERMUX_CERT_FILE });
});

test("elsewhere the binary runs directly, with no env override", () => {
  const command = tunnelCommand({ port: 9000, binary: "/usr/local/bin/cloudflared", termux: false });
  assert.equal(command.command, "/usr/local/bin/cloudflared");
  assert.deepEqual(command.args, ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:9000"]);
  assert.deepEqual(command.env, {});
});

test("the tunnel always points at loopback, never the tailnet address", () => {
  const command = tunnelCommand({ port: 8787, binary: "/x/cloudflared", termux: true });
  assert.ok(command.args.includes("http://127.0.0.1:8787"));
  assert.ok(!command.args.some((arg) => arg.startsWith("http://100.")));
});

test("the quick tunnel URL is read from cloudflared's output", () => {
  assert.equal(
    parseTunnelUrl("2026-10-29T10:00:00Z INF |  https://washing-marble-band.trycloudflare.com  |"),
    "https://washing-marble-band.trycloudflare.com",
  );
  assert.equal(parseTunnelUrl("INF Starting tunnel tunnelID=abc"), undefined);
  assert.equal(parseTunnelUrl("https://example.com"), undefined);
  // Only the quick-tunnel hostname counts; a named tunnel is not this path.
  assert.equal(parseTunnelUrl("https://pupkeep.example.com"), undefined);
});

test("a restart with a new URL is reported as a new origin, not a recovery", () => {
  const first = "https://a-b-c.trycloudflare.com";
  const second = "https://d-e-f.trycloudflare.com";
  assert.equal(tunnelChanged(undefined, first), false, "the first URL is not a change");
  assert.equal(tunnelChanged(first, first), false);
  assert.equal(tunnelChanged(first, second), true);
  assert.equal(tunnelChanged(first, undefined), false);
});

test("Termux is detected without an operator-set variable", () => {
  // The documented boot script sets nothing; relying on PUPKEEP_TERMUX meant the
  // phone spawned the raw binary, which P0-03 proved cannot work.
  assert.equal(detectTermux({ TERMUX_VERSION: "0.118.3" }), true);
  assert.equal(detectTermux({ PREFIX: "/data/data/com.termux/files/usr" }), true);
  assert.equal(detectTermux({}, (path) => path.includes("termux-chroot")), true);
  assert.equal(detectTermux({ PREFIX: "/usr" }, () => false), false);

  // The override still wins, for tests and unusual installs.
  assert.equal(detectTermux({ PUPKEEP_TERMUX: "1", PREFIX: "/usr" }, () => false), true);
  assert.equal(detectTermux({ PUPKEEP_TERMUX: "0", PREFIX: "/data/data/com.termux/files/usr" }), false);
});
