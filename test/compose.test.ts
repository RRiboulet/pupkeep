// The compose file is the deployment's other half, and two of its values are a
// contract with the code rather than a setting:
//
//   * `PUPKEEP_TRUSTED_PROXY` must equal Caddy's static address. The app reads
//     forwarded headers only from that exact peer; a mismatch does not fail, it
//     silently collapses every client into one rate-limit bucket (P6/R4). Both
//     sides therefore come from one substitution, and this file pins that.
//   * Only Caddy may pin an `ipv4_address`. `docker compose run --no-deps
//     pupkeep` (the nightly backup) inherits the service's network config,
//     static address included, so an address on the app makes the one-shot
//     request an address the running app holds — "Address already in use", and
//     the unattended backup never starts.
//
// Read as text, like test/ci.test.ts and test/image-workflow.test.ts, because a
// YAML dependency for two assertions is not worth the supply chain.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { test } from "node:test";

const composePath = new URL("../docker-compose.yml", import.meta.url);

/**
 * The body of one `services:` entry: from its two-space key to the next
 * two-space key (or the next root key). Indented lines inside the service are
 * kept, which is what the scalar reader below scans.
 */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `docker-compose.yml declares a ${name} service`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^ {2}[A-Za-z0-9_-]+:/.test(line) || /^[A-Za-z]/.test(line)) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** A one-line scalar under `key`, unquoted and without a trailing comment. */
function scalar(block: string, key: string): string | undefined {
  // `- key:` is a list item (`subnet:` under `ipam.config`), `key:` a mapping.
  const match = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.*)$`, "m").exec(block);
  if (match === null) return undefined;
  const written = match[1]!.trim();
  if (written === "" || written.startsWith("#")) return undefined; // a mapping, not a scalar
  const quoted = /^"([^"]*)"/.exec(written) ?? /^'([^']*)'/.exec(written);
  if (quoted !== null) return quoted[1]!;
  return written.replace(/\s+#.*$/, "").trim();
}

interface ComposeValue {
  /** The variable of a `${VAR:-default}` substitution, when there is one. */
  variable?: string;
  /** What the value resolves to with no `.env` present (the checkout's default). */
  value: string;
}

function resolveValue(written: string): ComposeValue {
  const substituted = /^\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}$/.exec(written);
  if (substituted !== null) return { variable: substituted[1]!, value: substituted[2]! };
  return { value: written };
}

/** True when `address` is inside `cidr`; only IPv4, which is all this file uses. */
function inSubnet(address: string, cidr: string): boolean {
  const [network, rawBits] = cidr.split("/");
  const bits = Number(rawBits);
  if (network === undefined || isIP(address) !== 4 || isIP(network) !== 4 || !Number.isInteger(bits)) {
    return false;
  }
  const toInt = (value: string): number =>
    value.split(".").reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(address) & mask) === (toInt(network) & mask);
}

test("the app trusts exactly Caddy's static address, and one variable sets both", async () => {
  const compose = await readFile(composePath, "utf8");

  const proxyWritten = scalar(serviceBlock(compose, "pupkeep"), "PUPKEEP_TRUSTED_PROXY");
  assert.ok(proxyWritten !== undefined, "the app service must set PUPKEEP_TRUSTED_PROXY");

  const addressWritten = scalar(serviceBlock(compose, "caddy"), "ipv4_address");
  assert.ok(addressWritten !== undefined, "the caddy service must have a static address to trust");

  const proxy = resolveValue(proxyWritten);
  const address = resolveValue(addressWritten);
  // The comparison the server actually makes: the peer's address against this
  // value. A different spelling (a hostname, a different host) is a silent
  // no-match, so the two sides must resolve identically.
  assert.equal(proxy.value, address.value, "PUPKEEP_TRUSTED_PROXY must be Caddy's address");
  // And if either side is a substitution, both must be the same one: a literal
  // here plus a `.env` override there is the drift this test exists to stop.
  if (proxy.variable !== undefined || address.variable !== undefined) {
    assert.equal(proxy.variable, address.variable, "both sides must read the same variable");
  }

  assert.notEqual(isIP(proxy.value), 0, `${proxy.value} must be an IP address, not a host name`);
  const rootNetworks = compose.slice(compose.indexOf("\nnetworks:"));
  const subnet = scalar(rootNetworks, "subnet");
  assert.ok(subnet !== undefined, "the compose network declares its subnet");
  assert.ok(inSubnet(proxy.value, subnet), `${proxy.value} must be inside ${subnet}`);
});

test("the app service sets the public origin it is served on", async () => {
  const compose = await readFile(composePath, "utf8");
  const app = serviceBlock(compose, "pupkeep");

  const written = scalar(app, "PUPKEEP_PUBLIC_ORIGIN");
  assert.ok(written !== undefined, "the app service must set PUPKEEP_PUBLIC_ORIGIN");
  const origin = resolveValue(written);
  assert.match(origin.value, /^https:\/\/[^/]+$/, "the origin must be a bare https origin");

  // The origin is only the trust anchor when the process is in `public` mode; a
  // compose edit that dropped the flag would leave the origin refused at start
  // (`resolveAccess` refuses it in every other mode), so pin the pair.
  assert.match(scalar(app, "command") ?? "", /"public"/, "the app service runs --access public");
});

test("only Caddy pins an address, so the nightly compose run one-shot can start", async () => {
  const compose = await readFile(composePath, "utf8");
  const services = [...compose.matchAll(/^ {2}([a-z0-9_-]+):$/gm)].map((match) => match[1]!);
  assert.ok(services.includes("pupkeep") && services.includes("caddy"), "the services are found");
  for (const name of services) {
    // `docker compose run --no-deps pupkeep` creates a one-off from the service
    // definition and inherits `networks:` — static address included — while the
    // app container still holds that address. Docker then refuses the one-shot
    // with "Address already in use", so the backup silently never runs.
    if (name === "caddy") continue;
    assert.equal(
      scalar(serviceBlock(compose, name), "ipv4_address"),
      undefined,
      `${name} must not pin an address: a one-off copy would collide with the running container`,
    );
  }

  // The app still has to be attached to the named network (a service without a
  // `networks:` key would join a different, generated default network and Caddy's
  // `pupkeep:8787` upstream would stop resolving).
  assert.match(
    serviceBlock(compose, "pupkeep"),
    /^\s+networks:\n\s+pupkeep:\s*$/m,
    "the app joins the declared `pupkeep` network without a static address",
  );
});
