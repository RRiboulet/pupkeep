import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTailscaleAddress,
  lanAddress,
  resolveAccess,
  tailscaleAddress,
  type InterfaceAddress,
} from "../src/launcher/access.ts";

const interfaces: InterfaceAddress[] = [
  { name: "lo", address: "127.0.0.1", family: "IPv4", internal: true },
  { name: "wlan0", address: "192.168.178.20", family: "IPv4", internal: false },
  { name: "tun1", address: "100.90.202.61", family: "IPv4", internal: false },
  { name: "tun1", address: "fd7a:115c:a1e0::62d:ca3e", family: "IPv6", internal: false },
];

test("100.64.0.0/10 is recognised and nothing else is", () => {
  assert.equal(isTailscaleAddress("100.64.0.1"), true);
  assert.equal(isTailscaleAddress("100.127.255.254"), true);
  assert.equal(isTailscaleAddress("100.128.0.1"), false);
  assert.equal(isTailscaleAddress("192.168.1.2"), false);
  assert.equal(isTailscaleAddress("fd7a:115c:a1e0::1"), false);
  assert.equal(isTailscaleAddress("100.90"), false);
});

test("the tailnet address is found on tun*, IPv4 only", () => {
  assert.equal(tailscaleAddress(interfaces), "100.90.202.61");
  // A LAN address is not a tailnet address, however private it looks.
  assert.equal(tailscaleAddress(interfaces.filter((i) => i.name === "wlan0")), undefined);
  // The interface list the phone shows before Tailscale connects.
  assert.equal(tailscaleAddress(interfaces.filter((i) => i.name !== "tun1")), undefined);
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

test("tailscale binds the tailnet address", () => {
  const result = resolveAccess("tailscale", interfaces, 8787);
  assert.ok(result.ok);
  assert.equal(result.plan.bindHost, "100.90.202.61");
  assert.equal(result.plan.displayUrl, "http://100.90.202.61:8787");
});

test("tailscale fails closed when the address is missing — never 0.0.0.0", () => {
  for (const list of [[], interfaces.filter((i) => i.name !== "tun1")]) {
    const result = resolveAccess("tailscale", list, 8787);
    assert.ok(!result.ok);
    assert.match(result.reason, /Tailscale is not connected/);
    assert.match(result.reason, /Refusing to bind 0\.0\.0\.0/);
  }
});

test("cloudflare binds loopback and waits for the tunnel for its URL", () => {
  const result = resolveAccess("cloudflare", interfaces, 8787);
  assert.ok(result.ok);
  assert.equal(result.plan.bindHost, "127.0.0.1");
  assert.equal(result.plan.displayUrl, undefined);
  assert.match(result.plan.warning ?? "", /URL changes on every restart/);
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
