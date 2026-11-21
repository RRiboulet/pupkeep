// R5's revocation over HTTP: the route is only a wrapper around the tested
// auth rule, so this suite pins the seam the UI calls — who may revoke whom,
// which cookie survives, and which one the browser is told to drop.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { startTestApp, type TestApp } from "./support/app.ts";

function revoke(fixture: TestApp, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${fixture.url}/api/auth/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      Cookie: `${SESSION_COOKIE}=${token}`,
      Origin: fixture.url,
    },
    body: JSON.stringify(body),
  });
}

function sessionStatus(fixture: TestApp, token: string): Promise<number> {
  return fetch(`${fixture.url}/api/session`, {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  }).then((response) => response.status);
}

test("the revocation route enforces the rule and keeps only the calling self-revoke", async () => {
  const fixture = await startTestApp({ prefix: "pupkeep-revoke-route-", partner: true });
  const owner = fixture.cookies.owner;
  const partner = fixture.cookies.partner;
  assert.ok(partner);
  try {
    // A member cannot revoke the owner, and the refusal writes nothing.
    const refused = await revoke(fixture, partner, { memberId: "owner" });
    assert.equal(refused.status, 403);
    assert.equal(await sessionStatus(fixture, owner), 200);
    assert.equal(await sessionStatus(fixture, partner), 200, "the refused member keeps their own session");

    // The owner revoking the other member ends every device of that member.
    const other = await revoke(fixture, owner, { memberId: "partner" });
    assert.equal(other.status, 200);
    assert.deepEqual(await other.json(), { memberId: "partner", revoked: "all" });
    assert.equal(await sessionStatus(fixture, partner), 401, "the revoked cookie is dead on the next request");

    // A self-revoke without `allDevices` is "sign out my other devices": the
    // calling cookie must still work and must not be cleared.
    const kept = await revoke(fixture, owner, { memberId: "owner" });
    assert.equal(kept.status, 200);
    assert.deepEqual(await kept.json(), { memberId: "owner", revoked: "others" });
    assert.equal(kept.headers.get("set-cookie"), null, "the calling device is not signed out");
    assert.equal(await sessionStatus(fixture, owner), 200);

    // A missing or blank target is a validation refusal, not a revocation.
    const blank = await revoke(fixture, owner, { memberId: "   " });
    assert.equal(blank.status, 409);

    // `allDevices` drops the caller too and tells the browser to forget the cookie.
    const all = await revoke(fixture, owner, { memberId: "owner", allDevices: true });
    assert.equal(all.status, 200);
    assert.deepEqual(await all.json(), { memberId: "owner", revoked: "all" });
    assert.match(all.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(await sessionStatus(fixture, owner), 401);
  } finally {
    await fixture.stop();
  }
});
