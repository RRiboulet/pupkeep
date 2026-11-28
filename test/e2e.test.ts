// P1-12: the Phase-1 vertical slice as one run (PLAN §15.1, §15.3, G1) plus
// the assertions this task owns beyond the unit suites:
//
//   * a real restart loses nothing — both caregivers' sessions, the shared
//     thread's transcript and the puppy profile survive a close/reopen of the
//     same data directory, and the reopened server answers a new message;
//   * a real `server.log` from that full run carries none of the secret shapes
//     the redaction suite exercises (PLAN §6.3, §14.4);
//   * the tunnel's forwarded scheme is trusted only from a loopback peer, and
//     `X-Forwarded-Host` cannot widen the origin check (§14.2).
//
// Everything here is the production path: real HTTP, the real SQLite harness in
// a temp directory (never the workspace mount), the P1-06 auth routes, the
// P1-09 thread/SSE and the P1-11 profile. Pi AI's faux provider stands in for a
// model, exactly as the other integration suites do.

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Auth, SESSION_COOKIE } from "../src/server/auth.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { dataStores } from "../src/server/config.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { createLogger } from "../src/server/log.ts";
import { PROBE_CACHE_VERSION } from "../src/server/models/cache.ts";
import type { ThreadSnapshot, TranscriptEntry } from "../src/shared/chat.ts";
import type { PuppyProfile } from "../src/shared/profile.ts";

const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_MODEL = "mimo-v2.6-flash";

// The same synthetic shapes `test/log.test.ts` exercises. They are not real
// credentials; they are shaped like the ones the scrubber must catch.
const PROVIDER_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
// The first-launch leg's dummy key: a fixture, never a real credential. It is
// deliberately not one of the redaction shapes above — those stay reserved for
// the log-scrubbing test's own assertions.
const SETUP_DUMMY_KEY = "sk-test-first-launch-000000000000";

// The meal schedule a realistic first launch would save (the shape `PATCH
// /api/feeding/slots` accepts, as `test/setup.test.ts` pins it).
const SETUP_BREAKFAST = { id: "slot-a", label: "Breakfast", timeLocal: "07:00", active: true };
const SETUP_DINNER = { id: "slot-b", label: "Dinner", timeLocal: "18:00", active: true };
const BEARER = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
const NTFY_TOPIC = "QUy9P9Hw4c2MH_NRGZFasFv8U34hBxHu";
const VAPID_KEY = "f8s7d6f5g4h3j2k1l0q9w8e7r6t5y4u3i2o1p0a9s8d7f6g5h4j3k2l1";

type ResponseStep = AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

interface Fixture {
  dir: string;
  app: AppHandle;
  url: string;
  faux: ReturnType<typeof fauxProvider>;
  auth: Auth;
  logPath: string;
  ownerCookie: string;
  memberCookie: string;
  ownerToken: string;
  inviteCode: string;
}

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, budgetMs = 5000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Start the production app on a fresh data directory with a file-backed logger.
 * The owner exists before boot (the launcher mints it); the partner joins through
 * the real invite route in `fullCycle`.
 */
async function startSlice(responses: readonly ResponseStep[]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-e2e-"));
  const stores = dataStores(dir);
  await stores.config.ensure();
  const now = "2026-10-29T10:00:00.000Z";
  await stores.config.update((config) => ({
    ...config,
    members: [{ id: "owner", role: "owner", displayName: "Alex", createdAt: now, sessions: [] }],
  }));
  // The P1-03 probe cache the phone writes at boot: without it the thread would
  // still pick the plan default, but seeding it keeps this run on the normal path.
  await stores.models.update(() => ({
    version: PROBE_CACHE_VERSION,
    checkedAt: new Date().toISOString(),
    results: [
      {
        id: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        status: "ok",
        toolCall: true,
        latencyMs: 5,
        checkedAt: new Date().toISOString(),
      },
    ],
  }));

  const faux = fauxProvider({ provider: DEFAULT_PROVIDER, models: [{ id: DEFAULT_MODEL }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);

  const logPath = join(dir, "server.log");
  const logger = createLogger({
    scope: "server",
    level: "debug",
    // Synchronous on purpose: the assertions read the file as soon as the run
    // ends, without racing a buffered sink.
    sink: (line) => appendFileSync(logPath, `${line}\n`, "utf8"),
  });
  const result = await startApp(
    { dataDir: dir, host: "127.0.0.1", port: 0, models },
    { logger },
  );
  assert.ok(result.ok, "the app must start with the shared thread wired");

  return {
    dir,
    app: result.app,
    url: result.app.url,
    faux,
    auth: new Auth({ config: stores.config }),
    logPath,
    ownerCookie: "",
    memberCookie: "",
    ownerToken: "",
    inviteCode: "",
  };
}

async function stop(fixture: Fixture): Promise<void> {
  await fixture.app.close();
  await rm(fixture.dir, { recursive: true, force: true });
}

function cookieFor(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

function firstCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = /pupkeep_session=([^;]*)/.exec(header)?.[1];
  assert.ok(value !== undefined && value !== "", "the response sets a session cookie");
  return value;
}

/**
 * One request from a chosen local address. `peerIsLoopback` trusts only the
 * literal loopback addresses, so binding the source to 127.0.0.2 reproduces a
 * non-loopback peer without a second network namespace.
 */
function requestFrom(
  origin: string,
  path: string,
  localAddress: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; setCookie: string }> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        localAddress,
        headers,
      },
      (res) => {
        const setCookie = res.headers["set-cookie"]?.[0] ?? "";
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, setCookie }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A cookie mutation: JSON, the fixed header and the same-origin Origin. */
async function mutate(
  fixture: Fixture,
  path: string,
  cookieToken: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${fixture.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      Cookie: cookieFor(cookieToken),
      Origin: fixture.url,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function patchProfile(
  fixture: Fixture,
  cookieToken: string,
  body: Record<string, unknown>,
  key: string,
): Promise<Response> {
  return fetch(`${fixture.url}/api/puppy`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      "Idempotency-Key": key,
      Cookie: cookieFor(cookieToken),
      Origin: fixture.url,
    },
    body: JSON.stringify(body),
  });
}

/** A PATCH care write: JSON, the fixed header, the same-origin Origin, an idempotency key. */
async function patchCare(
  fixture: Fixture,
  path: string,
  cookieToken: string,
  body: Record<string, unknown>,
  actionId: string,
): Promise<Response> {
  return fetch(`${fixture.url}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      "Idempotency-Key": actionId,
      Cookie: cookieFor(cookieToken),
      Origin: fixture.url,
    },
    body: JSON.stringify(body),
  });
}

/** The owner-only provider-key write: JSON, the fixed header, the same-origin Origin, an idempotency key. */
async function putProviderKey(
  fixture: Fixture,
  cookieToken: string,
  body: Record<string, unknown>,
  actionId: string,
): Promise<Response> {
  return fetch(`${fixture.url}/api/models/keys`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      "Idempotency-Key": actionId,
      Cookie: cookieFor(cookieToken),
      Origin: fixture.url,
    },
    body: JSON.stringify(body),
  });
}

/** The care-state read every setup card and gate decision is derived from. */
async function careProfile(fixture: Fixture, cookieToken: string): Promise<PuppyProfile> {
  const response = await fetch(`${fixture.url}/api/puppy`, {
    headers: { Cookie: cookieFor(cookieToken) },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as PuppyProfile;
}

async function postMessage(
  fixture: Fixture,
  cookieToken: string,
  text: string,
  clientMessageId: string,
): Promise<Response> {
  return mutate(fixture, "/api/agent/messages", cookieToken, { text, clientMessageId });
}

async function threadOf(fixture: Fixture, cookieToken: string): Promise<ThreadSnapshot> {
  const response = await fetch(`${fixture.url}/api/agent/thread`, {
    headers: { Cookie: cookieFor(cookieToken) },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as ThreadSnapshot;
}

interface Frame {
  event: string;
  data: unknown;
}

async function* framesOf(response: Response): AsyncGenerator<Frame> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) break;
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (event !== undefined) {
        yield { event, data: data === undefined ? undefined : JSON.parse(data) };
      }
    }
  }
}

async function nextFrame(iterator: AsyncGenerator<Frame>, budgetMs = 5000): Promise<Frame> {
  const pull = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("the SSE stream ended");
      return next.value;
    }
  })();
  const timeout: Promise<typeof NO_FRAME> = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(NO_FRAME), budgetMs);
    timer.unref?.();
  });
  const value = await Promise.race([pull, timeout]);
  if (value === NO_FRAME) throw new Error("no SSE frame in time");
  return value;
}

const NO_FRAME = Symbol("no frame");

/**
 * The whole Phase-1 slice: the owner link, the invite, both caregivers reading
 * and editing the profile, the member's authz refusal, one agent run and the
 * live `profile` frame.
 */
async function fullCycle(fixture: Fixture): Promise<void> {
  const minted = await fixture.auth.mintOwner("http://127.0.0.1");
  fixture.ownerToken = minted.token;
  const login = await fetch(`${fixture.url}/login?token=${encodeURIComponent(minted.token)}`, {
    redirect: "manual",
  });
  assert.equal(login.status, 303, "the owner link signs a browser in");
  fixture.ownerCookie = firstCookie(login);

  const invite = await mutate(fixture, "/api/invites", fixture.ownerCookie, { displayName: "Sam" });
  assert.equal(invite.status, 200, "only the owner creates invites");
  const { code, link } = (await invite.json()) as { code: string; link: string };
  fixture.inviteCode = code;
  const accepted = await fetch(link, { redirect: "manual" });
  assert.equal(accepted.status, 303);
  fixture.memberCookie = firstCookie(accepted);

  const read = await fetch(`${fixture.url}/api/puppy`, {
    headers: { Cookie: cookieFor(fixture.memberCookie) },
  });
  assert.equal(read.status, 200, "a member may read care state");
  const patched = await patchProfile(fixture, fixture.memberCookie, { rev: 0, name: "Biscuit" }, "e2e-member");
  assert.equal(patched.status, 200, "a member may perform a care action");

  // The authz matrix over HTTP: a member is refused the owner-only route.
  const refused = await mutate(fixture, "/api/invites", fixture.memberCookie, { displayName: "Imposter" });
  assert.equal(refused.status, 403);

  const posted = await postMessage(fixture, fixture.ownerCookie, "The pup is Biscuit", "m-e2e-1");
  assert.equal(posted.status, 202);
  await until(async () => {
    const snapshot = await threadOf(fixture, fixture.ownerCookie);
    return snapshot.entries.some((entry) => entry.kind === "assistant") ? true : undefined;
  });

  // The live stream carries committed care state to the other caregiver.
  const events = await fetch(`${fixture.url}/api/agent/events`, {
    headers: { Cookie: cookieFor(fixture.memberCookie) },
  });
  assert.equal(events.status, 200);
  const frames = framesOf(events);
  const snapshotFrame = await nextFrame(frames);
  assert.equal(snapshotFrame.event, "snapshot");
  const livePatch = await patchProfile(fixture, fixture.ownerCookie, { rev: 1, breed: "Beagle" }, "e2e-live");
  assert.equal(livePatch.status, 200);
  const liveFrame = await nextFrame(frames);
  assert.equal(liveFrame.event, "profile");
  assert.equal((liveFrame.data as { puppy: { breed: string } }).puppy.breed, "Beagle");
}

test("the vertical slice survives a restart: sessions, profile and shared thread", async () => {
  const fixture = await startSlice([() => fauxAssistantMessage("Noted, Biscuit is logged.")]);
  try {
    await fullCycle(fixture);

    // Close cleanly, then reopen the same data directory — the G1 restart gate.
    await fixture.app.close();
    fixture.faux.appendResponses([() => fauxAssistantMessage("After the restart.")]);

    const models = createModels();
    models.setProvider(fixture.faux.provider);
    const reopened = await startApp(
      { dataDir: fixture.dir, host: "127.0.0.1", port: 0, models },
      {
        logger: createLogger({
          scope: "server",
          level: "debug",
          sink: (line) => appendFileSync(fixture.logPath, `${line}\n`, "utf8"),
        }),
      },
    );
    assert.ok(reopened.ok, "the server reopens the same data directory");
    fixture.app = reopened.app;
    fixture.url = reopened.app.url;

    // Sessions are rows in config.json, not process memory: both browsers stay
    // signed in across the restart.
    for (const cookieToken of [fixture.ownerCookie, fixture.memberCookie]) {
      const me = await fetch(`${fixture.url}/api/session`, { headers: { Cookie: cookieFor(cookieToken) } });
      assert.equal(me.status, 200, "a session survives a restart");
    }

    const profile = (await (
      await fetch(`${fixture.url}/api/puppy`, { headers: { Cookie: cookieFor(fixture.memberCookie) } })
    ).json()) as { rev: number; puppy: { name: string; breed: string | null } };
    assert.equal(profile.puppy.name, "Biscuit");
    assert.equal(profile.puppy.breed, "Beagle");
    assert.equal(profile.rev, 2, "the live edit's revision survived");

    const before = await threadOf(fixture, fixture.ownerCookie);
    const chats = before.entries
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "chat" }> => entry.kind === "chat")
      .map((entry) => entry.text);
    assert.deepEqual(chats, ["The pup is Biscuit"], "the transcript survives");
    assert.equal(
      before.entries.some((entry) => entry.kind === "assistant"),
      true,
      "the answer survives",
    );

    // A reopened server still runs the shared thread: `resume()` + the fanout.
    const posted = await postMessage(fixture, fixture.memberCookie, "Who fed the pup?", "m-e2e-2");
    assert.equal(posted.status, 202);
    const after = await until(async () => {
      const snapshot = await threadOf(fixture, fixture.ownerCookie);
      const replies = snapshot.entries.filter((entry) => entry.kind === "assistant");
      return replies.length >= 2 ? snapshot : undefined;
    });
    assert.equal(
      after.entries.some((entry) => entry.kind === "assistant" && entry.text === "After the restart."),
      true,
    );
  } finally {
    await stop(fixture);
  }
});

test("a full run's server.log carries none of the redaction shapes", async () => {
  const fixture = await startSlice([() => fauxAssistantMessage("Noted.")]);
  try {
    await fullCycle(fixture);

    // The integration half of the log-scrub requirement: the same shapes
    // `test/log.test.ts` exercises travel through a full run's real routes — a
    // provider key in a query and a bearer token in a header (both ignored by
    // the route), a bad session cookie, and secret-shaped free text. The
    // scrubber's own shape table stays unit-tested there; Phase-1 routes have
    // no path that writes user or task text as a log field.
    const shapes = [
      { name: "owner token", value: fixture.ownerToken },
      { name: "invite code", value: fixture.inviteCode },
      { name: "owner cookie", value: fixture.ownerCookie },
      { name: "member cookie", value: fixture.memberCookie },
      { name: "provider key", value: PROVIDER_KEY },
      { name: "bearer", value: BEARER },
      { name: "ntfy topic", value: NTFY_TOPIC },
      { name: "vapid private key", value: VAPID_KEY },
    ];

    const probe = await fetch(`${fixture.url}/api/agent/thread?token=${PROVIDER_KEY}`, {
      headers: { Cookie: cookieFor(BEARER), Authorization: `Bearer ${BEARER}` },
    });
    assert.equal(probe.status, 401, "a credential in a URL is not a session");
    // The household is full after the cycle, so this is a refused request — the
    // shape still travelled through a route and must not reach the log.
    const named = await mutate(fixture, "/api/invites", fixture.ownerCookie, { displayName: NTFY_TOPIC });
    assert.equal(named.status, 409);
    const badPatch = await patchProfile(fixture, fixture.ownerCookie, { rev: 2, name: VAPID_KEY }, "e2e-secret");
    assert.equal(badPatch.status, 200, "the route stores free text; the log must still not carry it");

    const content = await readFile(fixture.logPath, "utf8");
    assert.ok(content.length > 0, "the run wrote a real server.log");
    assert.match(content, /listening/, "the log is the production logger's output");
    assert.match(content, /a request was refused/, "the secret-bearing refusals went through the mapper");
    for (const shape of shapes) {
      assert.equal(content.includes(shape.value), false, `${shape.name} reached server.log`);
    }
  } finally {
    await stop(fixture);
  }
});

test("the tunnel scheme is trusted only from loopback, and X-Forwarded-* never widens the origin check", async () => {
  const fixture = await startSlice([]);
  try {
    const minted = await fixture.auth.mintOwner("http://127.0.0.1");

    // cloudflared's quick tunnel connects from loopback and sets this header.
    // A plain-HTTP request must not get a Secure cookie, or the partner's
    // Tailscale browser would drop it (PLAN §14.2).
    const tunnel = await fetch(`${fixture.url}/login?token=${encodeURIComponent(minted.token)}`, {
      redirect: "manual",
      headers: { "X-Forwarded-Proto": "https" },
    });
    assert.equal(tunnel.status, 303);
    const tunnelCookie = tunnel.headers.get("set-cookie") ?? "";
    assert.match(tunnelCookie, /;\s*Secure/, "the HTTPS tunnel path sets a Secure cookie");
    assert.doesNotMatch(tunnelCookie, /Domain=/i, "the cookie is host-only, not shared across origins");
    const cookie = firstCookie(tunnel);

    const plain = await fetch(`${fixture.url}/login?token=${encodeURIComponent(minted.token)}`, {
      redirect: "manual",
    });
    assert.doesNotMatch(plain.headers.get("set-cookie") ?? "", /Secure/, "plain HTTP must not set Secure");

    // The counterpart: the same header from a peer that is not one of the
    // loopback addresses is ignored. A tiny loopback alias makes the peer
    // 127.0.0.2, which `peerIsLoopback` deliberately does not trust.
    const nonLoopback = await requestFrom(
      fixture.url,
      `/login?token=${encodeURIComponent(minted.token)}`,
      "127.0.0.2",
      { "X-Forwarded-Proto": "https" },
    );
    assert.equal(nonLoopback.status, 303);
    assert.doesNotMatch(nonLoopback.setCookie, /Secure/, "a non-loopback peer's forwarded scheme is ignored");

    // The invite link follows the scheme the browser saw, while the origin
    // check still uses the real Host header.
    const invite = await mutate(fixture, "/api/invites", cookie, { displayName: "Sam" }, {
      Origin: fixture.url,
      "X-Forwarded-Proto": "https",
    });
    assert.equal(invite.status, 200);
    const body = (await invite.json()) as { link: string };
    assert.match(body.link, /^https:\/\/127\.0\.0\.1:\d+\/invite\?code=/);

    // A spoofed forwarded origin is not an origin: reads may ignore Origin,
    // but a mutation must be refused and must not carry CORS permission.
    const refused = await mutate(fixture, "/api/invites", cookie, { displayName: "Eve" }, {
      Origin: "https://evil.example",
      "X-Forwarded-Host": "evil.example",
      "X-Forwarded-Proto": "https",
    });
    assert.equal(refused.status, 403, "X-Forwarded-Host cannot stand in for the request's origin");

    const read = await fetch(`${fixture.url}/api/session`, {
      headers: { Cookie: cookieFor(cookie), Origin: "https://evil.example" },
    });
    assert.equal(read.status, 200, "a read is authenticated, not origin-checked");
    assert.equal(read.headers.get("access-control-allow-origin"), null, "there is no CORS surface");
    assert.match(read.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  } finally {
    await stop(fixture);
  }
});

/**
 * The first-launch walk over the real APIs (the mandatory first-run setup):
 * the owner link signs in, the care profile reports all five steps missing in
 * the setup page's order, and each step's own route completes exactly one
 * derived step with one care commit. A partner invited after completion reads
 * a complete profile on their very first read — the gate is household-wide,
 * never per-member (R8/AC9).
 *
 * The seam is honest: this suite drives HTTP, not a browser. The visual lock —
 * the forced `#/setup` route, the missing navigation, the loading state — is
 * already pinned by `test/client.test.js`, `test/pwa.test.ts` and the
 * real-browser `test/browser-render.test.ts`; what this leg pins is the
 * first-launch API walk a locked client drives, and the never-gated partner.
 */
test("the first launch: five setup steps, then a partner who is never gated", async () => {
  const fixture = await startSlice([]);
  try {
    // The owner link: the same sign-in the launcher's printed link drives.
    const minted = await fixture.auth.mintOwner("http://127.0.0.1");
    fixture.ownerToken = minted.token;
    const login = await fetch(`${fixture.url}/login?token=${encodeURIComponent(minted.token)}`, {
      redirect: "manual",
    });
    assert.equal(login.status, 303, "the owner link signs a browser in");
    fixture.ownerCookie = firstCookie(login);

    const initial = await careProfile(fixture, fixture.ownerCookie);
    assert.deepEqual(initial.setup, {
      complete: false,
      missing: ["name", "timezone", "puppy", "meals", "key"],
    }, "a fresh household reports all five steps missing, in setup order");

    // Step 1 — the household name, confirmed even though it is unchanged (the
    // confirm-if-unchanged semantics the name step exists for).
    const named = await patchCare(fixture, "/api/household", fixture.ownerCookie, {
      rev: initial.household.rev,
      name: initial.household.name,
    }, "e2e-setup-name");
    assert.equal(named.status, 200, "confirming the default name is still a write");
    const afterName = ((await named.json()) as { profile: PuppyProfile }).profile;
    assert.ok(afterName.household.nameConfirmedAt);
    assert.deepEqual(afterName.setup.missing, ["timezone", "puppy", "meals", "key"]);

    // Step 2 — the timezone, confirmed with a real zone.
    const zoned = await patchCare(fixture, "/api/household", fixture.ownerCookie, {
      rev: afterName.household.rev,
      timezone: "Europe/Paris",
    }, "e2e-setup-zone");
    assert.equal(zoned.status, 200);
    const afterZone = ((await zoned.json()) as { profile: PuppyProfile }).profile;
    assert.ok(afterZone.household.timezoneConfirmedAt);
    assert.deepEqual(afterZone.setup.missing, ["puppy", "meals", "key"]);

    // Step 3 — the puppy, named.
    const pupped = await patchCare(fixture, "/api/puppy", fixture.ownerCookie, {
      rev: afterZone.rev,
      name: "Biscuit",
      birthday: "2026-08-08",
    }, "e2e-setup-puppy");
    assert.equal(pupped.status, 200);
    const afterPuppy = ((await pupped.json()) as { profile: PuppyProfile }).profile;
    assert.equal(afterPuppy.puppy.name, "Biscuit");
    assert.deepEqual(afterPuppy.setup.missing, ["meals", "key"]);

    // Step 4 — at least one meal slot.
    const fed = await patchCare(fixture, "/api/feeding/slots", fixture.ownerCookie, {
      rev: afterPuppy.meals.rev,
      slots: [SETUP_BREAKFAST, SETUP_DINNER],
    }, "e2e-setup-meals");
    assert.equal(fed.status, 200);
    const afterMeals = ((await fed.json()) as { profile: PuppyProfile }).profile;
    assert.equal(afterMeals.meals.slots.length, 2);
    assert.deepEqual(afterMeals.setup.missing, ["key"]);

    // Step 5 — the provider key, saved through the owner-only route. Presence
    // completes the step; the value never rides any response (§14.1).
    const keyed = await putProviderKey(fixture, fixture.ownerCookie, {
      provider: DEFAULT_PROVIDER,
      key: SETUP_DUMMY_KEY,
    }, "e2e-setup-key");
    assert.equal(keyed.status, 200);
    const keyView = JSON.stringify(await keyed.json());
    assert.equal(
      keyView.includes(SETUP_DUMMY_KEY),
      false,
      "the key write's response never echoes the key",
    );

    const complete = await careProfile(fixture, fixture.ownerCookie);
    assert.deepEqual(complete.setup, { complete: true, missing: [] });
    assert.equal(
      JSON.stringify(complete).includes(SETUP_DUMMY_KEY),
      false,
      "the care view carries presence, never the key's value",
    );

    // Only now, with setup complete, does the owner invite the partner.
    const invite = await mutate(fixture, "/api/invites", fixture.ownerCookie, { displayName: "Sam" });
    assert.equal(invite.status, 200, "only the owner creates invites");
    const { code, link } = (await invite.json()) as { code: string; link: string };
    fixture.inviteCode = code;
    const accepted = await fetch(link, { redirect: "manual" });
    assert.equal(accepted.status, 303, "the invite link signs the partner in");
    fixture.memberCookie = firstCookie(accepted);

    // The partner's very first profile read: the gate is household-wide, so a
    // partner invited after completion is never gated (R8/AC9).
    const firstRead = await careProfile(fixture, fixture.memberCookie);
    assert.deepEqual(firstRead.setup, { complete: true, missing: [] });
    assert.equal(firstRead.puppy.name, "Biscuit", "the partner sees the same care state");

    // The same authz matrix holds on the partner's first session.
    const refused = await mutate(fixture, "/api/invites", fixture.memberCookie, { displayName: "Imposter" });
    assert.equal(refused.status, 403, "a member cannot mint invites");
  } finally {
    await stop(fixture);
  }
});
