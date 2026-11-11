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
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { SESSION_COOKIE } from "../src/server/auth.ts";
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
 * A mutation with an explicit `Host`, which `fetch` will not let a test set. The
 * quick tunnel reaches the server as `127.0.0.1` with the tunnel's hostname in
 * `Host`, so this is the only way to exercise the same-origin rule it relies on.
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

test("a mutation is accepted from the quick tunnel only when Origin's host is the Host asked for", async () => {
  // The server never learns the tunnel's hostname (it is born before the tunnel
  // exists), so the same-origin fallback is what makes P4-09's tunnel path work.
  // This test is that rule: acceptance when the hosts agree, refusal when they do
  // not — the CSRF case (an attacker page's Origin against our Host).
  const app = await startTestApp({ prefix: "pupkeep-security-" });
  try {
    const tunnelHost = "random-words-here.trycloudflare.com";
    const accepted = await mutate(app.url, "/api/walks/start", {
      host: tunnelHost,
      origin: `https://${tunnelHost}`,
      cookie: app.cookies.owner,
      body: {},
      headers: { "Idempotency-Key": "security-origin-ok" },
    });
    assert.ok(
      accepted.status === 200 || accepted.status === 201,
      `a same-host Origin is accepted (got ${accepted.status} ${accepted.body})`,
    );

    const forged = await mutate(app.url, "/api/walks/start", {
      host: tunnelHost,
      origin: "https://evil.example",
      cookie: app.cookies.owner,
      body: {},
      headers: { "Idempotency-Key": "security-origin-evil" },
    });
    assert.equal(forged.status, 403, "another site's Origin against our Host is refused");

    const missing = await mutate(app.url, "/api/walks/start", {
      host: tunnelHost,
      cookie: app.cookies.owner,
      body: {},
      headers: { "Idempotency-Key": "security-origin-none" },
    });
    assert.equal(missing.status, 403, "a mutation with no Origin is refused");

    // The check is inlined at four call sites (message, logout, invite, care). A
    // copy-paste slip at one of them would pass the walks-start case above, so the
    // route that mints a credential is exercised too.
    const inviteAccepted = await mutate(app.url, "/api/invites", {
      host: tunnelHost,
      origin: `https://${tunnelHost}`,
      cookie: app.cookies.owner,
      body: { displayName: "Tunnel Guest" },
    });
    assert.ok(
      inviteAccepted.status === 200 || inviteAccepted.status === 201,
      `an invite from the tunnel origin is accepted (got ${inviteAccepted.status})`,
    );

    const inviteForged = await mutate(app.url, "/api/invites", {
      host: tunnelHost,
      origin: "https://evil.example",
      cookie: app.cookies.owner,
      body: { displayName: "Forged" },
    });
    assert.equal(inviteForged.status, 403, "the invite route refuses a foreign Origin too");
  } finally {
    await app.stop();
  }
});
