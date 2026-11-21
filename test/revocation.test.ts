import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Auth,
  AuthError,
  ForbiddenError,
  requireMemberRevocation,
  type Session,
} from "../src/server/auth.ts";
import { dataStores, type AppConfig, type PushConfig } from "../src/server/config.ts";
import type { JsonFileStore } from "../src/server/json-file.ts";

// The same hand-moved clock as test/auth.test.ts: revocation must not wait for
// a real session to age out, and a test that sleeps is a test that flakes.
function clock(start = "2026-10-29T12:00:00.000Z") {
  let now = Date.parse(start);
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

async function setup(): Promise<{
  auth: Auth;
  stores: { config: JsonFileStore<AppConfig>; push: JsonFileStore<PushConfig> };
  tick: ReturnType<typeof clock>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-revocation-"));
  const stores = dataStores(dir);
  await stores.config.ensure();
  const tick = clock();
  const auth = new Auth({ config: stores.config, push: stores.push, now: tick.now });
  return { auth, stores: { config: stores.config, push: stores.push }, tick };
}

/** Give a member a live push subscription, prefs and an ntfy topic. */
async function seedNotifications(
  stores: { push: JsonFileStore<PushConfig> },
  memberId: string,
  id: string,
  tick: ReturnType<typeof clock>,
): Promise<void> {
  await stores.push.update((current) => ({
    ...current,
    subscriptions: [
      ...current.subscriptions,
      {
        id,
        memberId,
        endpoint: `https://push.example/${id}`,
        p256dh: "p".repeat(80),
        auth: "a".repeat(22),
        createdAt: tick.now().toISOString(),
      },
    ],
    prefs: { ...current.prefs, [memberId]: { enabled: true, categories: ["fed"] } },
    ntfy: { ...current.ntfy, [memberId]: { topic: "abcdefghijklmnopqrstuvwx" } },
  }));
}

test("a member revoking themselves keeps the calling session unless they ask for all", async () => {
  const { auth } = await setup();
  const ownerToken = (await auth.mintOwner("http://127.0.0.1:8787")).token;
  const owner = await auth.authenticate(ownerToken);
  const accepted = await auth.acceptInvite(await auth.createInvite(owner, "Partner"));
  const memberId = accepted.session.memberId;
  const second = await auth.login(accepted.token);

  await auth.revokeMemberSessions(memberId, { keepToken: second.token });
  await assert.rejects(auth.authenticate(accepted.token), AuthError, "the other device is signed out");
  assert.equal(
    (await auth.authenticate(second.token)).memberId,
    memberId,
    "the calling device survives a revoke-others",
  );

  const third = await auth.login(second.token);
  await auth.revokeMemberSessions(memberId); // no keepToken: revoke every device
  await assert.rejects(auth.authenticate(second.token), AuthError);
  await assert.rejects(auth.authenticate(third.token), AuthError, "the caller goes too when asked");
});

test("the revocation rule: a member revokes self, the owner revokes either, anonymous never", () => {
  const owner: Session = { memberId: "owner", role: "owner", displayName: "Owner" };
  const member: Session = { memberId: "m-partner", role: "member", displayName: "Partner" };

  assert.equal(requireMemberRevocation(owner, "owner"), owner, "owner may revoke themselves");
  assert.equal(requireMemberRevocation(owner, "m-partner"), owner, "owner may revoke the member");
  assert.equal(requireMemberRevocation(member, "m-partner"), member, "member may revoke themselves");
  assert.throws(
    () => requireMemberRevocation(member, "owner"),
    ForbiddenError,
    "a member cannot revoke the owner",
  );
  assert.throws(
    () => requireMemberRevocation(member, "someone-else"),
    ForbiddenError,
    "a member cannot probe another id",
  );
  assert.throws(() => requireMemberRevocation(undefined, "m-partner"), ForbiddenError);
});

test("an owner revocation clears the member's sessions, push subscription, prefs and ntfy topic", async () => {
  const { auth, stores, tick } = await setup();
  const ownerToken = (await auth.mintOwner("http://127.0.0.1:8787")).token;
  const owner = await auth.authenticate(ownerToken);
  const accepted = await auth.acceptInvite(await auth.createInvite(owner, "Partner"));
  const memberId = accepted.session.memberId;

  await seedNotifications(stores, memberId, "member-device", tick);
  await seedNotifications(stores, owner.memberId, "owner-device", tick);

  requireMemberRevocation(owner, memberId);
  await auth.revokeMemberSessions(memberId);
  await assert.rejects(auth.authenticate(accepted.token), AuthError, "the member cookie is dead");

  const config = await stores.config.read();
  assert.deepEqual(config.members.find((member) => member.id === memberId)!.sessions, []);

  const push = await stores.push.read();
  assert.deepEqual(push.subscriptions.map((subscription) => subscription.id), ["owner-device"]);
  assert.equal(memberId in push.prefs, false, "prefs must not outlive the revocation");
  assert.equal(memberId in push.ntfy, false, "a revoked member must not keep receiving ntfy");
  assert.deepEqual(push.prefs[owner.memberId]?.categories, ["fed"], "the owner's settings are untouched");
  assert.ok(push.ntfy[owner.memberId], "the owner's topic is untouched");
  assert.equal((await auth.authenticate(ownerToken)).role, "owner", "the owner token is not a session");

  // Revocation is a state, not a one-shot event: a retry changes nothing.
  await auth.revokeMemberSessions(memberId);
  const again = await stores.push.read();
  assert.deepEqual(again.subscriptions.map((subscription) => subscription.id), ["owner-device"]);
  assert.equal(memberId in again.prefs, false);
  assert.equal(memberId in again.ntfy, false);
});

test("a member's attempt to revoke the owner is refused before anything is written", async () => {
  const { auth, stores, tick } = await setup();
  const ownerToken = (await auth.mintOwner("http://127.0.0.1:8787")).token;
  const owner = await auth.authenticate(ownerToken);
  const accepted = await auth.acceptInvite(await auth.createInvite(owner, "Partner"));
  await seedNotifications(stores, owner.memberId, "owner-device", tick);

  const beforeConfig = await stores.config.read();
  const beforePush = await stores.push.read();
  assert.throws(() => requireMemberRevocation(accepted.session, owner.memberId), ForbiddenError);

  assert.deepEqual(await stores.config.read(), beforeConfig);
  assert.deepEqual(await stores.push.read(), beforePush);
  assert.equal((await auth.authenticate(accepted.token)).role, "member", "their own session still works");
  assert.equal((await auth.authenticate(ownerToken)).role, "owner", "the owner's session still works");
});
