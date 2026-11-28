// R12-R13: a caregiver renames themselves (PATCH /api/me).
//
// What is covered, at the wire level like every other *-routes suite:
//   * the write: authenticated, rev-guarded on the household document,
//     idempotency-keyed, and scoped to the signed-in member's own row — the
//     route carries no member id, so nobody renames their partner here;
//   * the refusals: no session (401), a stale revision (409 with the current
//     care view), a duplicate of the other caregiver's name (409, the invite
//     guard's wording), an empty name, and a body with a field the route does
//     not accept;
//   * the replay: the same key and body is success, not a second revision;
//   * the restart: the chosen name survives — boot reconciliation reports the
//     config drift instead of overwriting the household document's name.
//
// The write lands on `app.household`'s member profile only: config.json stays
// the seed it was, which is what the restart test pins.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { createLogger } from "../src/server/log.ts";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { dataStores } from "../src/server/config.ts";
import { Auth, hashToken, newToken } from "../src/server/auth.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MEMBER_CREATED_AT = "2025-01-01T00:00:00.000Z";
const SESSION_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

interface Fixture {
  url: string;
  app: AppHandle;
  dir: string;
  cookies: { owner: string; partner: string };
  stop(): Promise<void>;
}

async function startMeApp(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-me-routes-"));
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const stores = dataStores(dir);
  await stores.config.ensure();
  const partnerToken = newToken();
  await stores.config.update((current) => ({
    ...current,
    members: [
      { id: "owner", role: "owner", displayName: "Alex", createdAt: MEMBER_CREATED_AT, sessions: [] },
      {
        id: "partner",
        role: "member",
        displayName: "Sam",
        createdAt: MEMBER_CREATED_AT,
        sessions: [{ tokenHash: hashToken(partnerToken), createdAt: MEMBER_CREATED_AT, expiresAt: SESSION_EXPIRES_AT }],
      },
    ],
  }));

  const result = await startApp(
    { dataDir: dir, host: "127.0.0.1", port: 0, models, now: () => Date.parse("2026-11-27T10:00:00.000Z") },
    { logger: createLogger({ scope: "test", sink: () => undefined }) },
  );
  assert.ok(result.ok, "the app must start");

  const auth = new Auth({ config: stores.config });
  const ownerCookie = await auth.mintOwner("http://127.0.0.1").then((m) => auth.login(m.token)).then((l) => l.token);

  const fixture: Fixture = {
    url: result.app.url,
    app: result.app,
    dir,
    cookies: { owner: ownerCookie, partner: partnerToken },
    // `fixture.app`, not the boot's capture: a restart test reassigns it, and
    // the teardown must close what is open now.
    stop: async () => {
      await fixture.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return fixture;
}

function cookie(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

async function patchMe(
  fixture: Fixture,
  token: string,
  body: Record<string, unknown>,
  key = "rename-1",
): Promise<Response> {
  return fetch(`${fixture.url}/api/me`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      "Idempotency-Key": key,
      Cookie: cookie(token),
      Origin: fixture.url,
    },
    body: JSON.stringify(body),
  });
}

async function profileOf(fixture: Fixture, token = fixture.cookies.owner): Promise<{
  rev: number;
  household: { rev: number; members: { id: string; name: string }[] };
}> {
  const response = await fetch(`${fixture.url}/api/puppy`, { headers: { Cookie: cookie(token) } });
  assert.equal(response.status, 200, "the care-state read answers");
  return (await response.json()) as Awaited<ReturnType<typeof profileOf>>;
}

function memberOf(profile: { household: { members: { id: string; name: string }[] } }, id: string): string {
  const member = profile.household.members.find((entry) => entry.id === id);
  assert.ok(member, `the roster carries ${id}`);
  return member.name;
}

// --- the write --------------------------------------------------------------

test("a caregiver renames themselves, and only their own row moves", async () => {
  const fixture = await startMeApp();
  try {
    const profile = await profileOf(fixture);
    const response = await patchMe(fixture, fixture.cookies.owner, {
      rev: profile.household.rev,
      name: "  Alessandra  ",
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { replayed: boolean; profile: Awaited<ReturnType<typeof profileOf>> };
    assert.equal(body.replayed, false);
    assert.equal(memberOf(body.profile, "owner"), "Alessandra", "the name is stored trimmed");
    assert.equal(memberOf(body.profile, "partner"), "Sam", "the partner's row is untouched");
    assert.equal(body.profile.household.rev, profile.household.rev + 1, "the household revision moved");
  } finally {
    await fixture.stop();
  }
});

test("both caregivers may rename themselves, and never each other", async () => {
  const fixture = await startMeApp();
  try {
    // The partner renames their own row.
    const partnerProfile = await profileOf(fixture, fixture.cookies.partner);
    const own = await patchMe(fixture, fixture.cookies.partner, {
      rev: partnerProfile.household.rev,
      name: "Samira",
    }, "rename-partner");
    assert.equal(own.status, 200);
    const body = (await own.json()) as { profile: Awaited<ReturnType<typeof profileOf>> };
    assert.equal(memberOf(body.profile, "partner"), "Samira");
    assert.equal(memberOf(body.profile, "owner"), "Alex", "the owner's row is untouched");

    // The body carries no member id: a client that sends one is refused rather
    // than silently ignored, so the route cannot be talked into renaming the
    // other caregiver.
    const profile = await profileOf(fixture);
    const smuggled = await patchMe(fixture, fixture.cookies.owner, {
      rev: profile.household.rev,
      name: "Alessandra",
      memberId: "partner",
    }, "rename-smuggled");
    assert.equal(smuggled.status, 409, "an unknown field is a visible refusal");
  } finally {
    await fixture.stop();
  }
});

test("a stale revision is refused with the current care view", async () => {
  const fixture = await startMeApp();
  try {
    const profile = await profileOf(fixture);
    // One real rename first, so the document's revision has moved past the
    // one the next request carries.
    const renamed = await patchMe(fixture, fixture.cookies.owner, {
      rev: profile.household.rev,
      name: "Alessandra",
    }, "rename-current");
    assert.equal(renamed.status, 200);

    const stale = await patchMe(fixture, fixture.cookies.owner, {
      rev: profile.household.rev,
      name: "Alessandra II",
    }, "rename-stale");
    assert.equal(stale.status, 409);
    const body = (await stale.json()) as {
      error: string;
      profile: { household: { rev: number; members: { id: string; name: string }[] } };
    };
    assert.equal(body.error, "stale");
    assert.equal(body.profile.household.rev, profile.household.rev + 1, "the answer carries the current revision");
    assert.equal(memberOf(body.profile, "owner"), "Alessandra", "the stored rename stands");
  } finally {
    await fixture.stop();
  }
});

test("renaming to the other caregiver's name is refused, in any case", async () => {
  const fixture = await startMeApp();
  try {
    const profile = await profileOf(fixture);
    const duplicate = await patchMe(fixture, fixture.cookies.owner, {
      rev: profile.household.rev,
      name: "Sam",
    }, "rename-duplicate");
    assert.equal(duplicate.status, 409);
    const body = (await duplicate.json()) as { error: string };
    assert.match(body.error, /already called Sam/);

    // The invite guard compares case-insensitively; the rename matches it.
    const differentCase = await patchMe(fixture, fixture.cookies.owner, {
      rev: profile.household.rev,
      name: "sam",
    }, "rename-duplicate-case");
    assert.equal(differentCase.status, 409);
    assert.match(((await differentCase.json()) as { error: string }).error, /already called sam/);

    // An empty name is refused before it can reach the document.
    const empty = await patchMe(fixture, fixture.cookies.owner, {
      rev: profile.household.rev,
      name: "   ",
    }, "rename-empty");
    assert.equal(empty.status, 409);
  } finally {
    await fixture.stop();
  }
});

test("the same key and body replays as success, not a second revision", async () => {
  const fixture = await startMeApp();
  try {
    const profile = await profileOf(fixture);
    const body = { rev: profile.household.rev, name: "Alessandra" };
    const first = await patchMe(fixture, fixture.cookies.owner, body, "rename-replay");
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { replayed: boolean }).replayed, false);

    const second = await patchMe(fixture, fixture.cookies.owner, body, "rename-replay");
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { replayed: boolean }).replayed, true);
    assert.equal(memberOf(await profileOf(fixture), "owner"), "Alessandra");
    assert.equal(
      (await profileOf(fixture)).household.rev,
      profile.household.rev + 1,
      "the replay wrote no second revision",
    );

    // The same key with a different request is a conflict, not a silent success.
    const hijacked = await patchMe(fixture, fixture.cookies.owner, { rev: profile.household.rev, name: "Sam" }, "rename-replay");
    assert.equal(hijacked.status, 409);
    assert.equal(((await hijacked.json()) as { error: string }).error, "idempotency_conflict");
  } finally {
    await fixture.stop();
  }
});

test("an anonymous call is 401, and the route is never open", async () => {
  const fixture = await startMeApp();
  try {
    const response = await fetch(`${fixture.url}/api/me`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        "Idempotency-Key": "rename-anon",
        Origin: fixture.url,
      },
      body: JSON.stringify({ rev: 0, name: "Ghost" }),
    });
    assert.equal(response.status, 401);
  } finally {
    await fixture.stop();
  }
});

// --- the restart ------------------------------------------------------------

test("a chosen name survives a restart; reconciliation reports drift instead of overwriting", async () => {
  const fixture = await startMeApp();
  try {
    const profile = await profileOf(fixture);
    const renamed = await patchMe(fixture, fixture.cookies.owner, {
      rev: profile.household.rev,
      name: "Alessandra",
    }, "rename-restart");
    assert.equal(renamed.status, 200, "the rename lands");

    // Close cleanly, then reopen the same data directory — the restart gate.
    await fixture.app.close();
    const models = createModels();
    models.setProvider(fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] }).provider);
    const reopened = await startApp(
      { dataDir: fixture.dir, host: "127.0.0.1", port: 0, models, now: () => Date.parse("2026-11-27T11:00:00.000Z") },
      { logger: createLogger({ scope: "test", sink: () => undefined }) },
    );
    assert.ok(reopened.ok, "the server reopens the same data directory");
    fixture.app = reopened.app;
    fixture.url = reopened.app.url;

    const after = await profileOf(fixture);
    assert.equal(memberOf(after, "owner"), "Alessandra", "the chosen name survives");
    assert.equal(memberOf(after, "partner"), "Sam", "the untouched row still matches the seed");
  } finally {
    await fixture.stop();
  }
});
