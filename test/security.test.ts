// P5-06 — the executable half of the security review (PLAN §14.2, §14.3).
//
// The load-bearing claim is the **agent escape**: the product agent's registry
// holds app tools only, and there is no path by which a tool can be handed a
// shell, filesystem, browser, network or SQL capability. A general-purpose tool
// in that registry is a security defect, not a feature gap (§14.3).
//
// "No path" is checked as *code*, not as a comment:
//   * the registry is an exact allowlist — a new tool fails this suite until a
//     human writes it down here, which is the review gate;
//   * no tool name, description or parameter can name a general capability, and
//     every tool takes a closed object schema rather than an opaque string;
//   * the modules that implement tools (and the reminder tasks) may import only
//     a named set of targets, reach no Node built-in, read no environment and
//     call no evaluator — so reaching a capability would take an edit this
//     suite refuses, not a prompt;
//   * the model-facing text (system prompt and tool descriptions) carries no
//     credential shape and no path into the data directory.
//
// The record of the adversarial attempts — what was tried, what was seen, what
// stays open — is `docs/security-review.md`. Each attempt there names the test
// or the command that produced its evidence.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { request } from "node:http";
import { test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { installAppExtensions } from "../src/server/app.ts";
import { SHARED_THREAD_INSTRUCTIONS } from "../src/server/agent/model.ts";
import {
  HSTS_MAX_AGE_SECONDS,
  INVITE_REDEEM_LIMIT,
  REQUEST_HEADER,
  bindOrigins,
  REQUEST_HEADER_VALUE,
  SIGNIN_LIMIT,
  forwardedValue,
  trustedPeer,
} from "../src/server/http.ts";
import { Auth, HOST_SESSION_COOKIE, SESSION_COOKIE } from "../src/server/auth.ts";
import { dataStores } from "../src/server/config.ts";
import { startTestApp } from "./support/app.ts";

/**
 * The app-tool allowlist. Every entry is a care action or a read of care state;
 * none of them takes a free-form command, a path or a URL. Adding a tool means
 * adding a line here — deliberately, in a diff a reviewer sees.
 */
const APP_TOOLS = [
  "add_milestone",
  "create_appointment",
  "end_walk",
  "get_context",
  "get_feeding_day",
  "get_growth",
  "get_puppy",
  "list_appointments",
  "list_milestones",
  "list_showers",
  "log_extra_feeding",
  "log_feeding",
  "log_measurement",
  "log_shower",
  "request_cancel_appointment",
  "request_feeding_schedule_change",
  "start_walk",
  "update_appointment",
  "update_milestone",
  "update_puppy_profile",
] as const;

/** The non-built-in task kinds. `pi.*` kinds are the harness's own. */
const APP_TASKS = ["app.feed.planner", "app.feed.reminder", "app.reminder"] as const;

function snapshot() {
  const registry = createRegistry();
  installAppExtensions(registry);
  return registry.snapshot();
}

test("the agent's registry is an app-tool allowlist, and adding to it needs a human", () => {
  const snap = snapshot();
  const tools = snap.tools().map((entry) => entry.tool.name).sort();
  assert.deepEqual(tools, [...APP_TOOLS].sort());

  const tasks = snap
    .tasks()
    .map((task) => (task as unknown as { definition: { name: string } }).definition.name)
    .filter((name) => !name.startsWith("pi."))
    .sort();
  assert.deepEqual(tasks, [...APP_TASKS].sort(), "the reminder kinds, and nothing that could act as a model");

  // The nine extensions are the care surfaces; none of them is a "system" or
  // "tools" extension whose job would be to load something else.
  assert.deepEqual(
    snap.installed().map((extension) => extension.name).sort(),
    ["approvals", "calendar", "feeding", "growth", "puppy-profile", "reminders", "showers", "training", "walks"],
  );
});

/**
 * The only import targets a tool module may name. Everything here is a pure
 * rule, a domain function, the notification shapes or the harness itself; the
 * list is a review gate, so a new target is a deliberate diff line with a reason
 * (§P5-06, `docs/security-review.md`). Package targets are pinned to the three
 * upstream packages the app already uses.
 */
const ALLOWED_IMPORTS: readonly string[] = [
  "@earendil-works/chord",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/models",
  "@earendil-works/pi-durable",
  "./", // the tool kit and the shared text builders beside the tools
  "../domain/", // the same domain functions HTTP uses, never a second implementation
  "../models/", // the probe cache the model selector reads; it holds no credentials
  "../notifications/", // the intent shapes a reminder task writes
  "../log.ts", // the scrubbing logger
  "../../shared/", // pure shared types, parsers and rules
];

/**
 * Node built-ins a tool module may import. Empty on purpose and kept as a named
 * constant so an exemption is a reviewable line rather than a weakened regex:
 * with none available, reaching the filesystem, the network or a subprocess
 * takes a visible edit to this suite.
 */
const ALLOWED_NODE_IMPORTS: readonly string[] = [];

test("no installed tool can name a general-purpose capability or take an opaque command", () => {
  const forbidden = /(^|[^a-z])(shell|terminal|bash|zsh|spawn|subprocess|exec|eval|sqlite|sql|database query|browser|scrape|curl|wget|dns|socket|filesystem|file system)([^a-z]|$)/i;
  const forbiddenParams = /^(path|file|filename|command|cmd|shell|script|code|sql|query|url|uri|endpoint|host|header|env)(s)?$/i;

  for (const { extension, tool } of snapshot().tools()) {
    const surface = `${extension.name} ${tool.name} ${tool.description}`;
    assert.doesNotMatch(surface, forbidden, `${tool.name} names a general capability`);
    // An object schema with named fields: the declarative surface is what a tool
    // can act on, and no field may name a capability. The schemas are open
    // (`additionalProperties` is absent, TypeBox's default), so an undeclared key
    // is accepted and then ignored by the parser — noise, not capability; the
    // review records that decision rather than pretending it is closed.
    const parameters = tool.parameters as {
      type?: string;
      properties?: Record<string, unknown>;
    };
    assert.equal(parameters.type, "object", `${tool.name} takes an object, not an opaque value`);
    for (const property of Object.keys(parameters.properties ?? {})) {
      assert.doesNotMatch(property, forbiddenParams, `${tool.name}.${property} names a capability`);
    }
  }
});

test("the tool modules may import only named targets, and no built-in at all", async () => {
  // The modules a tool body can use without an import are the ones that matter:
  // reaching the filesystem would need `node:fs` or a filesystem-touching module
  // on one of these lines.
  const files: Array<{ path: string; source: string }> = [];
  // Recursive: a subdirectory added later must not silently drop out of the scan.
  async function scan(root: URL, label: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await scan(new URL(`${entry.name}/`, root), `${label}${entry.name}/`);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: `${label}${entry.name}`, source: await readFile(new URL(entry.name, root), "utf8") });
      }
    }
  }
  for (const dir of ["agent", "reminders"]) {
    await scan(new URL(`../src/server/${dir}/`, import.meta.url), `src/server/${dir}/`);
  }
  assert.ok(files.length > 20, "the scan found the agent and reminder modules");

  // Modules that carry credentials or the database: named separately from the
  // allowlist so the failure says what the import would give a tool.
  const credentialModules = ["../config.ts", "../backup.ts", "../auth.ts", "../json-file.ts", "../lock.ts"];
  const specifier = /\bfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm;

  for (const { path, source } of files) {
    for (const match of source.matchAll(specifier)) {
      const target = match[1] ?? match[2] ?? "";
      assert.ok(
        !target.startsWith("node:") || ALLOWED_NODE_IMPORTS.includes(target),
        `${path} imports the Node built-in ${target}; the product agent has app tools only`,
      );
      assert.ok(
        !credentialModules.some((module) => target.endsWith(module)),
        `${path} imports ${target}, which carries credentials or the database`,
      );
      assert.ok(
        ALLOWED_IMPORTS.some((allowed) => target === allowed || target.startsWith(allowed)),
        `${path} imports ${target}, which is not on the tool allowlist (see ALLOWED_IMPORTS)`,
      );
    }
    // No dynamic import, no CommonJS require, no evaluator, no environment:
    // each is a way around the import scan above.
    assert.doesNotMatch(source, /\bimport\s*\(/, `${path} uses a dynamic import`);
    assert.doesNotMatch(source, /\brequire\s*\(/, `${path} uses require`);
    assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\s*\(/, `${path} evaluates a string`);
    assert.doesNotMatch(source, /\bprocess\s*\.\s*env\b/, `${path} reads the environment`);
  }
});

test("the server hands tools no execution environment", async () => {
  // `api.env` is a shell *and* a filesystem, handed to every tool invocation. It is
  // undefined today only because this call passes no `env`; the module is not on
  // the scan above (it legitimately imports node:fs), so the construction is what
  // gets pinned. Adding `env:` here is the one line that would arm a shell for
  // every tool and every reminder task.
  const source = await readFile(new URL("../src/server/harness.ts", import.meta.url), "utf8");
  // The last occurrence: the module's header comment names the call too.
  const at = source.lastIndexOf("Harness.open(");
  assert.ok(at > 0, "the scan found the Harness.open call");
  const construction = source.slice(at, at + 1200);
  assert.match(construction, /models:/, "the scan captured the options object");
  assert.doesNotMatch(
    construction,
    /\b(env|cwd)\s*:/,
    "the product harness must not be given an execution environment or a working directory",
  );
});

test("the model-facing text names no credential and no path into the data directory", () => {
  const shapes: Array<[string, RegExp]> = [
    ["a sign-in link", /login\?/],
    ["the owner link file", /owner-link/i],
    ["the data directory", /\.pupkeep/],
    ["secrets.json", /secrets\.json/i],
    ["config.json", /config\.json/i],
    ["push.json", /push\.json/i],
    ["a VAPID key", /vapid/i],
    ["a PEM private key", /PRIVATE KEY/],
    ["a provider key", /sk-[A-Za-z0-9]{8,}/],
    ["an opaque 40+ character run", /[A-Za-z0-9_-]{40,}/],
  ];
  const surfaces = [SHARED_THREAD_INSTRUCTIONS, ...snapshot().tools().map((entry) => entry.tool.description)];
  for (const surface of surfaces) {
    for (const [what, shape] of shapes) {
      assert.doesNotMatch(surface, shape, `the model-facing text must not carry ${what}`);
    }
  }
  // The prompt's own refusal rule is deliberate and stays: the model is told it
  // has no shell, filesystem, database or provider credentials.
  assert.match(SHARED_THREAD_INSTRUCTIONS, /Never ask for or reveal shell, filesystem, database, or provider credentials/);
});

test("the documented member-recovery edit really ends the lost session and frees the slot", async () => {
  // PLAN §14.1 carries this to P5-06: v1 has no remove-member/re-invite route, so
  // the operator procedure is a hand edit while the server is stopped. That
  // procedure is only acceptable if it is safe without the app's own purge — the
  // session must die and the house must accept a new invite afterwards.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Auth, AuthError } = await import("../src/server/auth.ts");
  const { dataStores } = await import("../src/server/config.ts");

  const dir = await mkdtemp(join(tmpdir(), "pupkeep-member-recovery-"));
  try {
    const stores = dataStores(dir);
    await stores.config.ensure();
    const auth = new Auth({ config: stores.config });
    const owner = await auth.authenticate((await auth.mintOwner("http://127.0.0.1")).token);
    const partner = await auth.acceptInvite(await auth.createInvite(owner, "Partner"));
    assert.equal((await auth.authenticate(partner.token)).role, "member");

    // Exactly what the runbook tells the operator to do: mark the member removed
    // and clear their sessions, then start again.
    await stores.config.update((current) => ({
      ...current,
      members: current.members.map((member) =>
        member.id === partner.session.memberId
          ? { ...member, removedAt: "2026-01-01T00:00:00.000Z", sessions: [] }
          : member,
      ),
    }));

    await assert.rejects(auth.authenticate(partner.token), AuthError, "the lost session is dead after the edit");
    // The slot is free again: the same owner can invite somebody new.
    const replacement = await auth.acceptInvite(await auth.createInvite(owner, "Partner"));
    assert.equal((await auth.authenticate(replacement.token)).role, "member");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- HTTP surface -----------------------------------------------------------

interface RawResponse {
  status: number;
  body: string;
}

/**
 * A mutation with an explicit `Host`, which `fetch` will not let a test set. A
 * reverse proxy reaches the server as `127.0.0.1` with the public hostname in
 * `Host`, so this is the only way to exercise the same-origin rule it relies
 * on.
 */
function mutate(
  url: string,
  path: string,
  init: { host: string; origin?: string; cookie: string; body: unknown; headers?: Record<string, string> },
): Promise<RawResponse> {
  const payload = JSON.stringify(init.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: Number(new URL(url).port),
        path,
        method: "POST",
        headers: {
          Host: init.host,
          ...(init.origin ? { Origin: init.origin } : {}),
          Cookie: `${SESSION_COOKIE}=${init.cookie}`,
          "Content-Type": "application/json",
          [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
          "Content-Length": Buffer.byteLength(payload),
          ...init.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

test("a mutation is accepted only when Origin's host is the Host asked for", async () => {
  // The server may be reached through a proxy whose hostname it was never told
  // (it binds a loopback or container address), so the same-origin fallback is
  // what makes the proxied path work. This test is that rule: acceptance when
  // the hosts agree, refusal when they do not — the CSRF case (an attacker
  // page's Origin against our Host).
  const app = await startTestApp({ prefix: "pupkeep-security-" });
  try {
    const proxyHost = "pupkeep.example";
    const accepted = await mutate(app.url, "/api/walks/start", {
      host: proxyHost,
      origin: `https://${proxyHost}`,
      cookie: app.cookies.owner,
      body: {},
      headers: { "Idempotency-Key": "security-origin-ok" },
    });
    assert.ok(
      accepted.status === 200 || accepted.status === 201,
      `a same-host Origin is accepted (got ${accepted.status} ${accepted.body})`,
    );

    const forged = await mutate(app.url, "/api/walks/start", {
      host: proxyHost,
      origin: "https://evil.example",
      cookie: app.cookies.owner,
      body: {},
      headers: { "Idempotency-Key": "security-origin-evil" },
    });
    assert.equal(forged.status, 403, "another site's Origin against our Host is refused");

    const missing = await mutate(app.url, "/api/walks/start", {
      host: proxyHost,
      cookie: app.cookies.owner,
      body: {},
      headers: { "Idempotency-Key": "security-origin-none" },
    });
    assert.equal(missing.status, 403, "a mutation with no Origin is refused");

    // The check is inlined at four call sites (message, logout, invite, care). A
    // copy-paste slip at one of them would pass the walks-start case above, so the
    // route that mints a credential is exercised too.
    const inviteAccepted = await mutate(app.url, "/api/invites", {
      host: proxyHost,
      origin: `https://${proxyHost}`,
      cookie: app.cookies.owner,
      body: { displayName: "Proxy Guest" },
    });
    assert.ok(
      inviteAccepted.status === 200 || inviteAccepted.status === 201,
      `an invite from the proxy origin is accepted (got ${inviteAccepted.status})`,
    );

    const inviteForged = await mutate(app.url, "/api/invites", {
      host: proxyHost,
      origin: "https://evil.example",
      cookie: app.cookies.owner,
      body: { displayName: "Forged" },
    });
    assert.equal(inviteForged.status, 403, "the invite route refuses a foreign Origin too");
  } finally {
    await app.stop();
  }
});

// --- P6/R3-R5b: the public origin, the proxy address, and the limiter -------

interface RawHttpResult {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** A request with an explicit `Host`/`Origin` and peer-visible headers. */
function rawRequest(
  url: string,
  path: string,
  init: {
    method?: string;
    host?: string;
    origin?: string;
    cookie?: string;
    cookieName?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<RawHttpResult> {
  const target = new URL(url);
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: Number(target.port),
        path,
        method: init.method ?? (payload === undefined ? "GET" : "POST"),
        headers: {
          Host: init.host ?? target.host,
          ...(init.origin ? { Origin: init.origin } : {}),
          ...(init.cookie ? { Cookie: `${init.cookieName ?? SESSION_COOKIE}=${init.cookie}` } : {}),
          ...(payload === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
                "Content-Length": Buffer.byteLength(payload),
              }),
          ...init.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

test("a configured public origin replaces the loopback origin list entirely", () => {
  assert.deepEqual(bindOrigins("0.0.0.0", 8787, "https://pupkeep.example"), ["https://pupkeep.example"]);
  assert.deepEqual(bindOrigins("0.0.0.0", 8787), ["http://localhost:8787", "http://127.0.0.1:8787"]);
});

test("peer trust is by normalised address, and forwarded values are read from the right", () => {
  assert.equal(trustedPeer("::ffff:10.0.0.2", "10.0.0.2"), true, "IPv4-mapped peer");
  assert.equal(trustedPeer("10.0.0.2", "::ffff:10.0.0.2"), true, "IPv4-mapped proxy");
  assert.equal(trustedPeer("10.0.0.3", "10.0.0.2"), false, "a sibling is not the proxy");
  assert.equal(trustedPeer(undefined, "10.0.0.2"), false);
  assert.equal(trustedPeer("10.0.0.2", undefined), false, "no configured proxy trusts nobody");
  assert.equal(forwardedValue("203.0.113.9, 198.51.100.7", "rightmost"), "198.51.100.7");
  assert.equal(forwardedValue("203.0.113.9, 198.51.100.7", "leftmost"), "203.0.113.9");
  assert.equal(forwardedValue("https, http", "rightmost"), "http");
  assert.equal(forwardedValue(["a, b", "c"], "rightmost"), "c");
  assert.equal(forwardedValue("a, ", "rightmost"), undefined, "a trailing empty value is not trusted");
});

test("the configured public origin is the only origin, and its scheme owns the cookie, HSTS and invite link", async () => {
  const origin = "https://pupkeep.example";
  const app = await startTestApp({ prefix: "pupkeep-public-origin-", publicOrigin: origin });
  try {
    const login = await rawRequest(app.url, `/login?token=${encodeURIComponent(app.cookies.owner)}`, {
      host: "pupkeep.example",
    });
    assert.equal(login.status, 303);
    const setCookie = String(login.headers["set-cookie"] ?? "");
    assert.match(setCookie, new RegExp(`^${HOST_SESSION_COOKIE}=`), "public HTTPS uses the __Host- name");
    assert.match(setCookie, /;\s*Secure/);
    assert.match(setCookie, /Max-Age=2592000/);
    assert.equal(
      login.headers["strict-transport-security"],
      `max-age=${HSTS_MAX_AGE_SECONDS}`,
      "the stated HSTS policy rides every response",
    );
    const cookie = /=([^;]*)/.exec(setCookie)?.[1];
    assert.ok(cookie);

    const invite = await rawRequest(app.url, "/api/invites", {
      host: "pupkeep.example",
      origin,
      cookie,
      cookieName: HOST_SESSION_COOKIE,
      body: { displayName: "Sam" },
    });
    assert.equal(invite.status, 200, invite.body);
    const inviteBody = JSON.parse(invite.body) as { code: string; link: string };
    assert.equal(inviteBody.link, `${origin}/invite?code=${encodeURIComponent(inviteBody.code)}`);

    const wrongHost = await rawRequest(app.url, "/healthz", { host: "evil.example" });
    assert.equal(wrongHost.status, 403, "even a read on another Host is refused");

    const wrongOrigin = await rawRequest(app.url, "/api/invites", {
      host: "pupkeep.example",
      origin: "https://evil.example",
      cookie,
      cookieName: HOST_SESSION_COOKIE,
      body: { displayName: "Eve" },
    });
    assert.equal(wrongOrigin.status, 403);

    // `sameOrigin` would accept this (host and Host agree); the configured
    // origin is compared exactly, so the fallback is gone in public mode.
    const fallback = await rawRequest(app.url, "/api/invites", {
      host: "pupkeep.example",
      origin: "https://pupkeep.example:443",
      cookie,
      cookieName: HOST_SESSION_COOKIE,
      body: { displayName: "Mallory" },
    });
    assert.equal(fallback.status, 403, "the configured origin is the only accepted Origin string");
  } finally {
    await app.stop();
  }
});

test("forwarded headers are honoured only from the configured proxy, rightmost value only", async () => {
  const origin = "https://pupkeep.example";
  const app = await startTestApp({
    prefix: "pupkeep-trusted-proxy-",
    publicOrigin: origin,
    trustedProxy: "::ffff:10.9.8.7",
    remoteAddress: "10.9.8.7",
  });
  try {
    const invalid = (xf?: string, cf?: string) =>
      rawRequest(app.url, "/login?token=guess", {
        host: "pupkeep.example",
        headers: {
          ...(xf === undefined ? {} : { "X-Forwarded-For": xf }),
          ...(cf === undefined ? {} : { "CF-Connecting-IP": cf }),
        },
      });

    // The rightmost entry is the proxy's own view; the forged left side changes
    // every attempt but the limiter key does not.
    for (let attempt = 0; attempt < SIGNIN_LIMIT; attempt += 1) {
      const response = await invalid(`198.51.100.${attempt}, 203.0.113.9`);
      assert.equal(response.status, 401, `attempt ${attempt} is a normal refusal`);
    }
    const limited = await invalid("192.0.2.1, 203.0.113.9");
    assert.equal(limited.status, 429, "the rightmost client address is the bucket");
    const other = await invalid("203.0.113.9, 198.51.100.7");
    assert.equal(other.status, 401, "a different rightmost client is not locked out");

    // CF-Connecting-IP is deleted: distinct values do not create distinct keys.
    for (let attempt = 0; attempt < SIGNIN_LIMIT; attempt += 1) {
      const response = await invalid(undefined, `198.51.100.${attempt}`);
      assert.equal(response.status, 401);
    }
    const cfLimited = await invalid(undefined, "198.51.100.250");
    assert.equal(cfLimited.status, 429, "CF-Connecting-IP no longer names the client");

    const acceptedScheme = await rawRequest(app.url, "/healthz", {
      host: "pupkeep.example",
      headers: { "X-Forwarded-Proto": "https" },
    });
    assert.equal(acceptedScheme.status, 200);
    const contradiction = await rawRequest(app.url, "/healthz", {
      host: "pupkeep.example",
      headers: { "X-Forwarded-Proto": "http" },
    });
    assert.equal(contradiction.status, 400, "a proxy scheme that contradicts the origin is refused");
  } finally {
    await app.stop();
  }
});

test("forwarded headers from any other peer change nothing", async () => {
  const app = await startTestApp({
    prefix: "pupkeep-untrusted-proxy-",
    publicOrigin: "https://pupkeep.example",
    trustedProxy: "10.0.0.9",
    remoteAddress: "10.9.8.7",
  });
  try {
    // The same contradiction from a non-proxy peer is ignored, not refused.
    const health = await rawRequest(app.url, "/healthz", {
      host: "pupkeep.example",
      headers: { "X-Forwarded-Proto": "http" },
    });
    assert.equal(health.status, 200);

    for (let attempt = 0; attempt < SIGNIN_LIMIT; attempt += 1) {
      const response = await rawRequest(app.url, "/login?token=guess", {
        host: "pupkeep.example",
        headers: {
          "X-Forwarded-For": `203.0.113.${attempt}`,
          "CF-Connecting-IP": `198.51.100.${attempt}`,
        },
      });
      assert.equal(response.status, 401);
    }
    const limited = await rawRequest(app.url, "/login?token=guess", {
      host: "pupkeep.example",
      headers: {
        "X-Forwarded-For": "203.0.113.250",
        "CF-Connecting-IP": "198.51.100.250",
      },
    });
    assert.equal(limited.status, 429, "the peer address, not either header, is the key");
  } finally {
    await app.stop();
  }
});

test("failed sign-ins do not block invite redemption, and a correct sign-in resets its bucket", async () => {
  const app = await startTestApp({
    prefix: "pupkeep-limiter-",
    publicOrigin: "https://pupkeep.example",
    trustedProxy: "10.9.8.7",
    remoteAddress: "10.9.8.7",
  });
  try {
    assert.ok(INVITE_REDEEM_LIMIT > SIGNIN_LIMIT, "redemption has the higher ceiling");
    const auth = new Auth({ config: dataStores(app.dir).config });
    const owner = await auth.authenticate(app.cookies.owner);
    const code = await auth.createInvite(owner, "Sam");

    for (let attempt = 0; attempt < SIGNIN_LIMIT; attempt += 1) {
      const response = await rawRequest(app.url, "/login?token=guess", { host: "pupkeep.example" });
      assert.equal(response.status, 401);
    }
    const limited = await rawRequest(app.url, "/login?token=guess", { host: "pupkeep.example" });
    assert.equal(limited.status, 429, "sign-in is throttled");

    // The stranger cannot block the household's door: the invite bucket is
    // separate and higher, so redemption is still tried after sign-ins are out.
    for (let attempt = 0; attempt < SIGNIN_LIMIT + 1; attempt += 1) {
      const response = await rawRequest(app.url, "/invite?code=guess", { host: "pupkeep.example" });
      assert.equal(response.status, 401, `invite attempt ${attempt} is still validated`);
    }
    const accepted = await rawRequest(app.url, `/invite?code=${encodeURIComponent(code)}`, {
      host: "pupkeep.example",
    });
    assert.equal(accepted.status, 303, "a valid invite still lands");

    const good = await rawRequest(app.url, `/login?token=${encodeURIComponent(app.cookies.owner)}`, {
      host: "pupkeep.example",
    });
    assert.equal(good.status, 303, "a correct credential is validated before the limiter");
    const afterReset = await rawRequest(app.url, "/login?token=guess", { host: "pupkeep.example" });
    assert.equal(afterReset.status, 401, "a success reset the bucket instead of consuming it");
  } finally {
    await app.stop();
  }
});
