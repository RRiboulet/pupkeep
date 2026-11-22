import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCgnatAddress,
  isPrivateAddress,
  lanAddress,
  resolveAccess,
  ACCESS_MODES,
  type AccessMode,
  type InterfaceAddress,
} from "../src/launcher/access.ts";

const interfaces: InterfaceAddress[] = [
  { name: "lo", address: "127.0.0.1", family: "IPv4", internal: true },
  { name: "wlan0", address: "192.168.178.20", family: "IPv4", internal: false },
  { name: "tun1", address: "100.90.202.61", family: "IPv4", internal: false },
  { name: "tun1", address: "fd7a:115c:a1e0::62d:ca3e", family: "IPv6", internal: false },
];

test("the retired modes are gone from the list and fail closed (P6-08)", () => {
  // R13's offline fallback deleted the phone-only modes. A deleted mode must be
  // *rejected*, not merely absent from a list: a caller that kept passing one
  // (a stale boot line, a copied command) gets a refusal instead of a listener
  // configured the way the mode used to be.
  assert.deepEqual(ACCESS_MODES, ["local", "lan", "public"]);
  for (const retired of ["tailscale", "cloudflare"] as const) {
    const result = resolveAccess(retired as AccessMode, interfaces, 8787);
    assert.ok(!result.ok, `${retired} must be refused`);
    assert.match(result.reason, /unknown access mode/);
  }
});

test("local binds loopback and shows a loopback URL", () => {
  const result = resolveAccess("local", interfaces, 8787);
  assert.ok(result.ok);
  assert.equal(result.plan.bindHost, "127.0.0.1");
  assert.equal(result.plan.displayUrl, "http://127.0.0.1:8787");
  assert.equal(result.plan.warning, undefined);
});

test("lan is the only mode that opens every interface, and it says so", () => {
  const result = resolveAccess("lan", interfaces, 8787);
  assert.ok(result.ok);
  assert.equal(result.plan.bindHost, "0.0.0.0");
  assert.match(result.plan.warning ?? "", /plain HTTP/);
});

test("an impossible port is refused before any bind decision", () => {
  const result = resolveAccess("local", interfaces, 0);
  assert.ok(!result.ok);
  assert.match(result.reason, /port must be an integer/);
});

test("lan resolves a real address for the printed URL, not a placeholder", () => {
  const result = resolveAccess("lan", interfaces, 8787);
  assert.ok(result.ok);
  assert.equal(result.plan.displayUrl, "http://192.168.178.20:8787");

  // No usable IPv4: no URL is better than a placeholder pretending to be one.
  const empty = resolveAccess("lan", interfaces.filter((i) => i.family !== "IPv4"), 8787);
  assert.ok(empty.ok);
  assert.equal(empty.plan.displayUrl, undefined);
});

test("lanAddress skips loopback and link-local addresses", () => {
  assert.equal(lanAddress(interfaces), "192.168.178.20");
  assert.equal(lanAddress([{ name: "lo", address: "127.0.0.1", family: "IPv4", internal: true }]), undefined);
  assert.equal(lanAddress([{ name: "wlan0", address: "169.254.3.4", family: "IPv4", internal: false }]), undefined);
});

test("public binds every interface inside the container and trusts only its origin", () => {
  const result = resolveAccess("public", [], 8787, "https://pupkeep.duckdns.org");
  assert.ok(result.ok);
  assert.equal(result.plan.bindHost, "0.0.0.0");
  // The mint reads `origin`, not the discovered address (P6).
  assert.equal(result.plan.origin, "https://pupkeep.duckdns.org");
  assert.equal(result.plan.displayUrl, "https://pupkeep.duckdns.org");
});

test("public without an origin refuses to plan anything", () => {
  const result = resolveAccess("public", [], 8787);
  assert.ok(!result.ok);
  assert.match(result.reason, /needs PUPKEEP_PUBLIC_ORIGIN/);
});

test("public refuses an origin that did not come from the parser", () => {
  // The plan's origin is compared byte-for-byte with a browser's Origin header
  // and pasted into the owner link, so a string that is not already normalised
  // is a silent mismatch. Validate at the point of use instead of trusting
  // every caller to have called `parsePublicOrigin` (P6/R3).
  const cases = [
    "HTTPS://pupkeep.example",
    "https://pupkeep.example/",
    "https://pupkeep.example/login",
    "https://pupkeep.example:443",
    "http://pupkeep.example",
    "not a url",
  ];
  for (const origin of cases) {
    const result = resolveAccess("public", [], 8787, origin);
    assert.ok(!result.ok, `${origin} must be refused`);
    assert.match(result.reason, /not a normalised https origin/);
  }

  // The parser's own output — normalised, with a non-default port kept — passes.
  const ok = resolveAccess("public", [], 8787, "https://pupkeep.example:8443");
  assert.ok(ok.ok);
  assert.equal(ok.plan.origin, "https://pupkeep.example:8443");
});

test("a configured origin makes the plaintext modes refuse", () => {
  for (const mode of ["local", "lan"] as const) {
    const result = resolveAccess(mode, [{ name: "eth0", address: "192.168.1.9", family: "IPv4", internal: false }], 8787, "https://pupkeep.duckdns.org");
    assert.ok(!result.ok, `${mode} must refuse with an origin set`);
    assert.match(result.reason, /--access local|--access lan/);
  }
});

test("lan fails closed when the address it would print is public", () => {
  // On a VPS the "LAN" address *is* the public one; binding it is a plaintext
  // sign-in screen on the internet (P6).
  const result = resolveAccess("lan", [{ name: "eth0", address: "92.5.131.133", family: "IPv4", internal: false }], 8787);
  assert.ok(!result.ok);
  assert.match(result.reason, /not a private address/);
});

test("lan guards every exposed interface, not only the one it prints", () => {
  // A bridge or a second NIC would otherwise put the plaintext screen on the
  // internet while the guard looked at a private address.
  const result = resolveAccess(
    "lan",
    [
      { name: "docker0", address: "172.17.0.1", family: "IPv4", internal: false },
      { name: "eth0", address: "92.5.131.133", family: "IPv4", internal: false },
    ],
    8787,
  );
  assert.ok(!result.ok);
  assert.match(result.reason, /92\.5\.131\.133/);
});

test("the private/CGNAT predicates are a table, not a vibe", () => {
  const cases: Array<[string, boolean, boolean]> = [
    // address, isPrivate, isCgnat
    ["10.0.0.1", true, false],
    ["127.0.0.1", true, false],
    ["172.15.255.255", false, false],
    ["172.16.0.1", true, false],
    ["172.31.255.254", true, false],
    ["172.32.0.1", false, false],
    ["192.168.0.1", true, false],
    ["100.64.0.1", false, true],
    ["100.90.202.61", false, true],
    ["100.128.0.1", false, false],
    ["92.5.131.133", false, false],
    ["192.168..1", false, false],
    ["999.1.1.1", false, false],
    ["not an address", false, false],
  ];
  for (const [address, priv, cgnat] of cases) {
    assert.equal(isPrivateAddress(address), priv, `isPrivateAddress(${address})`);
    assert.equal(isCgnatAddress(address), cgnat, `isCgnatAddress(${address})`);
  }
});

test("a phone with only the tailnet up can still start lan (R13's fallback)", () => {
  const result = resolveAccess(
    "lan",
    [
      { name: "tun1", address: "100.90.202.61", family: "IPv4", internal: false },
      { name: "lo", address: "127.0.0.1", family: "IPv4", internal: true },
    ],
    8787,
  );
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.equal(result.plan.bindHost, "0.0.0.0");
});
