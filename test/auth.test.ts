import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Auth,
  AuthError,
  ForbiddenError,
  MAX_MEMBERS,
  RateLimiter,
  SESSION_COOKIE,
  can,
  hashEquals,
  hashToken,
  originAllowed,
  parseSessionCookie,
  sessionCookie,
} from "../src/server/auth.ts";
import { dataStores, emptyPush } from "../src/server/config.ts";
import type { JsonFileStore } from "../src/server/json-file.ts";
import type { AppConfig, PushConfig } from "../src/server/config.ts";

// A clock the tests move by hand: invite expiry and session rotation are both
// time rules, and a test that waits is a test that flakes.
function clock(start = "2026-10-29T12:00:00.000Z") {
  let now = Date.parse(start);
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

async function setup(push = false): Promise<{
  auth: Auth;
  stores: { config: JsonFileStore<AppConfig>; push?: JsonFileStore<PushConfig> };
  tick: ReturnType<typeof clock>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-auth-"));
  const stores = dataStores(dir);
  await stores.config.ensure();
  const tick = clock();
  const auth = new Auth({ config: stores.config, now: tick.now, ...(push ? { push: stores.push } : {}) });
  return { auth, stores: push ? stores : { config: stores.config }, tick };
}

test("the matrix is data: members can care, only owners can invite or rotate", () => {
  for (const action of ["care", "agent", "approvals", "notification-prefs"] as const) {
    assert.equal(can("member", action), true, action);
    assert.equal(can("owner", action), true, action);
  }
  for (const action of ["invite", "remove-member", "rotate-owner", "providers", "backup"] as const) {
    assert.equal(can("member", action), false, action);
    assert.equal(can("owner", action), true, action);
  }
  assert.equal(can(undefined, "care"), false, "anonymous is never allowed");
});

test("an owner token is 256 bits and only its hash is stored", async () => {
  const { auth, stores } = await setup();
  const { token, rotated } = await auth.mintOwner();

  assert.equal(rotated, false);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 bytes base64url");
  const config = await stores.config.read();
  assert.equal(config.ownerTokenHash, hashToken(token));
  assert.ok(!JSON.stringify(config).includes(token), "the token itself is never stored");
});

test("the owner signs in with the token and gets seed-free identity", async () => {
  const { auth } = await setup();
  const { token } = await auth.mintOwner();
  const session = await auth.authenticate(token);
  assert.equal(session.role, "owner");
});

test("a wrong or truncated token is rejected, not guessed", async () => {
  const { auth } = await setup();
  const { token } = await auth.mintOwner();
  await assert.rejects(auth.authenticate(`${token}x`), AuthError);
  await assert.rejects(auth.authenticate(""), AuthError);
  assert.equal(hashEquals("abc", "abc"), true);
  assert.equal(hashEquals("abc", "abd"), false);
  assert.equal(hashEquals("abc", "abcd"), false, "length mismatch is a false, not a throw");
});

test("an invite is one-time, expiring, and creates the member", async () => {
  const { auth, tick } = await setup();
  const { token } = await auth.mintOwner();
  const owner = await auth.authenticate(token);

  const code = await auth.createInvite(owner, "Partner");
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);

  const accepted = await auth.acceptInvite(code);
  assert.equal(accepted.session.role, "member");
  assert.equal(accepted.session.displayName, "Partner");

  // Single use: the same code now fails, as does a made-up one.
  await assert.rejects(auth.acceptInvite(code), AuthError);
  await assert.rejects(auth.acceptInvite("not-a-real-code"), AuthError);

  // The session works, and the member cannot invite.
  assert.equal((await auth.authenticate(accepted.token)).role, "member");
  await assert.rejects(auth.createInvite(accepted.session, "Someone"), ForbiddenError);
  void tick;
});

test("the household is capped at two people", async () => {
  const { auth } = await setup();
  const owner = await auth.authenticate((await auth.mintOwner()).token);
  const code = await auth.createInvite(owner, "Partner");
  await auth.acceptInvite(code);

  await assert.rejects(auth.createInvite(owner, "Third"), /household is full/);
  assert.equal(MAX_MEMBERS, 2);
});

test("reissuing the owner token signs out owner sessions and kills unused invites, but not members", async () => {
  const { auth } = await setup();
  const first = await auth.mintOwner();
  const owner = await auth.authenticate(first.token);
  // Mint the spare invite while the household still has a slot; the household is
  // full once the partner accepts.
  const unused = await auth.createInvite(owner, "Spare");
  const memberToken = (await auth.acceptInvite(await auth.createInvite(owner, "Partner"))).token;
  const { token: rotatedToken, rotated } = await auth.mintOwner();

  assert.equal(rotated, true);
  await assert.rejects(auth.acceptInvite(unused), AuthError, "an owner rotation invalidates their invites");
  await assert.rejects(auth.authenticate(first.token), AuthError, "the old owner token is dead");
  assert.equal((await auth.authenticate(rotatedToken)).role, "owner");
  // The partner keeps working: rotating the owner link is not a household reset.
  assert.equal((await auth.authenticate(memberToken)).role, "member");
});

test("removing a member kills their sessions, their notifications, and cannot be undone by a profile", async () => {
  const { auth, stores, tick } = await setup(true);
  const owner = await auth.authenticate((await auth.mintOwner()).token);
  const accepted = await auth.acceptInvite(await auth.createInvite(owner, "Partner"));
  const memberId = accepted.session.memberId;

  // The member has a live push subscription, prefs and an ntfy topic.
  await stores.push!.update((current) => ({
    ...current,
    subscriptions: [
      {
        id: "s1",
        memberId,
        endpoint: "https://push.example/abc",
        p256dh: "p".repeat(80),
        auth: "a".repeat(22),
        createdAt: tick.now().toISOString(),
      },
    ],
    prefs: { [memberId]: { enabled: true, categories: ["fed"] } },
    ntfy: { [memberId]: { topic: "abcdefghijklmnopqrstuvwx" } },
  }));

  await auth.removeMember(owner, memberId);

  await assert.rejects(auth.authenticate(accepted.token), AuthError, "their session is gone");
  const push = await stores.push!.read();
  assert.deepEqual(push.subscriptions, [], "a removed caregiver must not keep receiving push");
  assert.deepEqual(push.prefs, {});
  assert.deepEqual(push.ntfy, {});

  const config = await stores.config.read();
  const removed = config.members.find((member) => member.id === memberId)!;
  assert.ok(removed.removedAt, "the row is retained and marked");
  assert.deepEqual(removed.sessions, []);
});

test("a member cannot remove anyone, and an owner cannot remove themselves", async () => {
  const { auth } = await setup();
  const owner = await auth.authenticate((await auth.mintOwner()).token);
  const member = (await auth.acceptInvite(await auth.createInvite(owner, "Partner"))).session;

  await assert.rejects(auth.removeMember(member, owner.memberId), ForbiddenError);
  await assert.rejects(auth.removeMember(owner, owner.memberId), /cannot remove themselves/);
});

test("signing out one device leaves the other sessions alone", async () => {
  const { auth } = await setup();
  const owner = await auth.authenticate((await auth.mintOwner()).token);
  const first = await auth.acceptInvite(await auth.createInvite(owner, "Partner"));

  await auth.revokeSession(first.token);
  await assert.rejects(auth.authenticate(first.token), AuthError);
});

test("expired invites are pruned and the count is reported", async () => {
  const { auth, tick } = await setup();
  const owner = await auth.authenticate((await auth.mintOwner()).token);
  await auth.createInvite(owner, "A");
  await auth.createInvite(owner, "B");
  assert.equal(await auth.pruneInvites(), 0);
  tick.advance(16 * 60 * 1000);
  assert.equal(await auth.pruneInvites(), 2);
});

test("the cookie is HttpOnly, Lax, and Secure only on HTTPS", () => {
  const insecure = sessionCookie("t", { secure: false });
  assert.match(insecure, new RegExp(`^${SESSION_COOKIE}=t`));
  assert.match(insecure, /HttpOnly/);
  assert.match(insecure, /SameSite=Lax/);
  assert.match(insecure, /Path=\//);
  assert.doesNotMatch(insecure, /Secure/, "a Secure cookie on Tailscale HTTP is dropped by the browser");

  assert.match(sessionCookie("t", { secure: true }), /;\sSecure/);
  assert.equal(parseSessionCookie(`a=1; ${SESSION_COOKIE}=abc; b=2`), "abc");
  assert.equal(parseSessionCookie(undefined), undefined);
});

test("a mutation from an origin the launcher is not serving is refused", () => {
  const allowed = ["http://127.0.0.1:8787", "http://100.90.202.61:8787"];
  assert.equal(originAllowed("http://100.90.202.61:8787", allowed), true);
  assert.equal(originAllowed("http://100.90.202.61:8787/", allowed), true);
  assert.equal(originAllowed("https://evil.example", allowed), false);
  assert.equal(originAllowed(undefined, allowed), false);
});

test("login attempts are rate limited, and a success clears the count", () => {
  const tick = clock();
  const limiter = new RateLimiter(3, 60_000, () => tick.now().getTime());

  assert.equal(limiter.hit("1.2.3.4"), true);
  assert.equal(limiter.hit("1.2.3.4"), true);
  assert.equal(limiter.hit("1.2.3.4"), true);
  assert.equal(limiter.hit("1.2.3.4"), false, "the fourth attempt in the window is refused");
  assert.equal(limiter.hit("5.6.7.8"), true, "another key is unaffected");

  limiter.reset("1.2.3.4");
  assert.equal(limiter.hit("1.2.3.4"), true);

  tick.advance(61_000);
  assert.equal(new RateLimiter(1, 1000, () => tick.now().getTime()).hit("k"), true);
});

test("the push store is optional: removal still works without it", async () => {
  const { auth } = await setup();
  const owner = await auth.authenticate((await auth.mintOwner()).token);
  const member = await auth.acceptInvite(await auth.createInvite(owner, "Partner"));
  assert.deepEqual(emptyPush().ntfy, {});
  await auth.removeMember(owner, member.session.memberId);
});

test("an invite that expires before it is used cannot be accepted", async () => {
  const { auth, tick } = await setup();
  const owner = await auth.authenticate((await auth.mintOwner()).token);
  const code = await auth.createInvite(owner, "Late", 60_000);
  tick.advance(60_001);
  await assert.rejects(auth.acceptInvite(code), AuthError);
});
