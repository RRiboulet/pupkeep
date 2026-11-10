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
  // Verbatim from the pinned binary (`cloudflared 2026.10.5`, arm64 release,
  // checksum matched) against a loopback listener.
  assert.equal(
    parseTunnelUrl(
      "2026-11-10T22:00:08Z INF |  https://territory-enlargement-plane-ripe.trycloudflare.com                                |",
    ),
    "https://territory-enlargement-plane-ripe.trycloudflare.com",
  );
  assert.equal(
    parseTunnelUrl("2026-10-29T10:00:00Z INF |  https://washing-marble-band.trycloudflare.com  |"),
    "https://washing-marble-band.trycloudflare.com",
  );
  assert.equal(parseTunnelUrl("INF Starting tunnel tunnelID=abc"), undefined);
  assert.equal(parseTunnelUrl("https://example.com"), undefined);
  // Only the quick-tunnel hostname counts; a named tunnel is not this path.
  assert.equal(parseTunnelUrl("https://pupkeep.example.com"), undefined);
});

test("the API endpoint is not a tunnel: the real error line parses as nothing", () => {
  // P5-01b cell 5, captured on the phone with a shim in place of the binary. The
  // old rule announced `https://api.trycloudflare.com` as the tunnel and swallowed
  // this line, so the operator saw neither the failure nor the reason.
  const failure =
    'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": ' +
    "dial tcp: lookup api.trycloudflare.com on [::1]:53: read udp [::1]:33747->[::1]:53: read: connection refused";
  assert.equal(parseTunnelUrl(failure), undefined);
  // Even boxed, the API host is not a tunnel hostname — and when it ends the URL
  // (`…com":`), the hostname guard is the only thing that rejects it.
  assert.equal(parseTunnelUrl("INF |  https://api.trycloudflare.com  |"), undefined);
  assert.equal(parseTunnelUrl('failed to request quick Tunnel: Post "https://api.trycloudflare.com": 500'), undefined);
});

test("a URL outside cloudflared's box is still a URL, so a new banner layout is not silent", () => {
  // P5-04 upgrades cloudflared. If its banner moves, the tunnel still works and the
  // launcher must still announce it rather than parse nothing.
  assert.equal(
    parseTunnelUrl("INF Your quick Tunnel has been created! Visit it at https://a-b.trycloudflare.com (it may take some time)"),
    "https://a-b.trycloudflare.com",
  );
  assert.equal(parseTunnelUrl("INF https://a-b-c.trycloudflare.com"), "https://a-b-c.trycloudflare.com");
  // …but a host that is not the whole URL is not the tunnel's.
  assert.equal(parseTunnelUrl("https://a-b-c.trycloudflare.com/extra"), undefined);
});

test("the rest of cloudflared's banner is not mistaken for the tunnel URL", () => {
  for (const line of [
    "2026-11-10T22:00:08Z INF +--------------------------------------------------------------------------------------------+",
    "2026-11-10T22:00:08Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
    "2026-11-10T22:00:08Z INF Requesting new quick Tunnel on trycloudflare.com...",
    // A pre-check row inside a box: a hostname, but not the tunnel's.
    "2026-11-10T22:00:14Z INF |  DNS Resolution    region1.v2.argotunnel.com  PASS    DNS Resolved successfully     |",
    "2026-11-10T22:00:14Z INF |  Cloudflare API    api.cloudflare.com:443     PASS    API is reachable              |",
  ]) {
    assert.equal(parseTunnelUrl(line), undefined, line);
  }
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
