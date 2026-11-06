// P4-05: the notification outbox (PLAN §12.3, §16 P4-05).
//
// What is pinned here:
//   * a pending intent goes to every device of its member and is marked sent,
//     with the category title, the dedupe key as the display tag and no in-app
//     body in the payload;
//   * a member with no device is skipped (the in-app item is still there), and a
//     disabled category is dropped rather than sent;
//   * a 404/410 removes the dead subscription and records the failure;
//   * a failed send backs off, retries after the delay, and gives up at the cap;
//   * no VAPID pair leaves intents pending rather than failing them;
//   * an intent appended while the sends are in flight is not clobbered.

import assert from "node:assert/strict";
import {
  createDecipheriv,
  createECDH,
  createHmac,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { dataStores } from "../src/server/config.ts";
import { NotificationsDoc } from "../src/server/domain/docs.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import { notificationIntent } from "../src/shared/notifications.ts";
import { ensureVapid, generateVapidKeys } from "../src/server/push/vapid.ts";
import type { PushTransport } from "../src/server/push/web-push.ts";
import {
  OUTBOX_MAX_ATTEMPTS,
  deliverableDelivery,
  drainNotificationOutbox,
  pushEnabledFor,
} from "../src/server/notifications/outbox.ts";
import type { NotificationDelivery, NotificationIntent } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
const NOW = new Date("2026-10-29T10:00:00.000Z");

// --- helpers ----------------------------------------------------------------

function makeSubscription(memberId: string, endpoint = `https://push.example/${memberId}`) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string; y: string };
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const auth = randomBytes(16);
  return {
    record: {
      id: `sub-${memberId}`,
      memberId,
      endpoint,
      p256dh: point.toString("base64url"),
      auth: auth.toString("base64url"),
      createdAt: NOW.toISOString(),
    },
    privateKey: Buffer.from(jwk.d, "base64url"),
    uaPublic: point,
    auth,
  };
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  return hmac(prk, Buffer.concat([info, Buffer.from([0x01])])).subarray(0, length);
}

function decrypt(body: Buffer, subscription: ReturnType<typeof makeSubscription>): string {
  const salt = body.subarray(0, 16);
  const keyLength = body[20]!;
  const asPublic = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(subscription.privateKey);
  const prkKey = hmac(subscription.auth, ecdh.computeSecret(asPublic));
  const ikm = hkdfExpand(
    prkKey,
    Buffer.concat([Buffer.from("WebPush: info\0"), subscription.uaPublic, asPublic]),
    32,
  );
  const prk = hmac(salt, ikm);
  const contentKey = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = createDecipheriv("aes-128-gcm", contentKey, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  return padded.subarray(0, padded.length - 1).toString("utf8");
}

type Fixture = {
  opened: OpenedHarness;
  push: ReturnType<typeof dataStores>["push"];
  seed(items: readonly NotificationIntent[]): Promise<void>;
};

async function withOutbox(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-outbox-"));
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite") });
  const push = dataStores(dir).push;
  await push.ensure();
  try {
    await run({
      opened,
      push,
      seed: async (items) => {
        await opened.harness.commit(async (tx) => {
          const draft = await tx.doc(NotificationsDoc);
          draft.createdAt = NOW.toISOString();
          draft.items = [...items];
        }, context);
      },
    });
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

function intent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return notificationIntent({
    dedupeKey: "feed_overdue|2026-10-29|slot|slot-a|owner",
    category: "feed_overdue",
    userId: "owner",
    body: 'Breakfast was not logged by 07:15.',
    now: NOW,
    id: "notice-1",
    ...overrides,
  });
}

async function configure(
  fixture: Fixture,
  subscriptions: ReturnType<typeof makeSubscription>["record"][],
  prefs: Record<string, { enabled: boolean; categories: string[] }> = {},
) {
  const keys = generateVapidKeys();
  await fixture.push.update((current) => ({
    ...current,
    vapid: keys,
    subscriptions,
    prefs: prefs as never,
  }));
  return keys;
}

function capture() {
  const calls: { url: string; body: Buffer; headers: Record<string, string> }[] = [];
  let onSend: (() => Promise<void>) | undefined;
  const transport: PushTransport = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, body: Buffer.from(init.body as Uint8Array), headers });
    if (onSend) await onSend();
    return new Response(null, { status: 201 });
  };
  return { calls, transport, setOnSend: (fn: () => Promise<void>) => (onSend = fn) };
}

// --- the pass ---------------------------------------------------------------

test("a pending intent is pushed to each member's device with the category title and tag", async () => {
  await withOutbox(async (fixture) => {
    const owner = makeSubscription("owner");
    const partner = makeSubscription("partner");
    await configure(fixture, [owner.record, partner.record]);
    await fixture.seed([
      intent(),
      intent({
        id: "notice-2",
        dedupeKey: "feed_overdue|2026-10-29|slot|slot-a|partner",
        userId: "partner",
      }),
    ]);
    const calls = capture();

    const result = await drainNotificationOutbox({
      store: fixture.opened.harness,
      context,
      push: fixture.push,
      now: NOW,
      transport: calls.transport,
    });
    assert.equal(result.sent, 2);
    assert.equal(calls.calls.length, 2);
    const payload = JSON.parse(decrypt(calls.calls[0]!.body, owner)) as Record<string, unknown>;
    assert.deepEqual(payload, {
      title: "A meal is overdue",
      tag: "feed_overdue|2026-10-29|slot|slot-a|owner",
      url: "/",
    });
    assert.equal("body" in payload, false, "the in-app copy never enters a push payload");

    const stored = await fixture.opened.harness.snapshot(NotificationsDoc, context);
    assert.ok(stored && "items" in stored);
    const items = (stored.items as NotificationIntent[]).map((item) => item.delivery);
    assert.deepEqual(items.map((delivery) => delivery.state), ["sent", "sent"]);
    assert.ok(items.every((delivery) => typeof delivery.sentAt === "string"));
  });
});

test("a member with no device is skipped, and a disabled category is dropped", async () => {
  await withOutbox(async (fixture) => {
    const owner = makeSubscription("owner");
    await configure(fixture, [owner.record], { owner: { enabled: true, categories: [] } });
    await fixture.seed([
      intent({ id: "drop", dedupeKey: "feed_overdue|drop", userId: "owner" }),
      intent({ id: "skip", dedupeKey: "feed_overdue|skip", userId: "partner" }),
    ]);
    const calls = capture();
    const result = await drainNotificationOutbox({
      store: fixture.opened.harness,
      context,
      push: fixture.push,
      now: NOW,
      transport: calls.transport,
    });
    assert.equal(result.dropped, 1);
    assert.equal(result.skipped, 1);
    assert.equal(calls.calls.length, 0, "no push is sent for either");
    const stored = await fixture.opened.harness.snapshot(NotificationsDoc, context);
    const items = (stored?.items as NotificationIntent[]).map((item) => item.delivery.state);
    assert.deepEqual(items, ["dropped", "pending"], "the skipped item is still owed");
  });
});

test("a 410 removes the subscription and marks the intent failed", async () => {
  await withOutbox(async (fixture) => {
    const owner = makeSubscription("owner");
    await configure(fixture, [owner.record]);
    await fixture.seed([intent()]);
    const transport: PushTransport = async () => new Response(null, { status: 410 });

    const result = await drainNotificationOutbox({
      store: fixture.opened.harness,
      context,
      push: fixture.push,
      now: NOW,
      transport,
    });
    assert.equal(result.failed, 1);
    assert.equal(result.removedSubscriptions, 1);
    assert.deepEqual((await fixture.push.read()).subscriptions, []);
    const stored = await fixture.opened.harness.snapshot(NotificationsDoc, context);
    const delivery = (stored?.items as NotificationIntent[])[0]!.delivery;
    assert.equal(delivery.state, "failed");
    assert.equal(delivery.attempts, 1);
    assert.match(String(delivery.lastError), /410/);
  });
});

test("a failed send backs off, retries, and gives up at the cap", async () => {
  await withOutbox(async (fixture) => {
    const owner = makeSubscription("owner");
    await configure(fixture, [owner.record]);
    await fixture.seed([intent()]);
    let calls = 0;
    const transport: PushTransport = async () => {
      calls += 1;
      return new Response(null, { status: 500 });
    };
    const drain = (now: Date) =>
      drainNotificationOutbox({
        store: fixture.opened.harness,
        context,
        push: fixture.push,
        now,
        transport,
      });

    assert.equal((await drain(NOW)).failed, 1);
    assert.equal(calls, 1);
    assert.equal((await drain(new Date(NOW.getTime() + 1_000))).failed, 0, "inside the backoff");
    assert.equal(calls, 1);
    const later = new Date(NOW.getTime() + 61_000);
    assert.equal((await drain(later)).failed, 1);
    assert.equal(calls, 2);

    // At the attempt cap the outbox stops trying; the in-app item remains.
    const stored = await fixture.opened.harness.snapshot(NotificationsDoc, context);
    const item = (stored?.items as NotificationIntent[])[0]!;
    await fixture.opened.harness.commit(async (tx) => {
      const draft = await tx.doc(NotificationsDoc);
      draft.items = [
        {
          ...item,
          delivery: { ...item.delivery, attempts: OUTBOX_MAX_ATTEMPTS } as NotificationDelivery,
        },
      ];
    }, context);
    assert.equal((await drain(new Date(later.getTime() + 10_000_000))).failed, 0);
    assert.equal(calls, 2, "no send after the cap");
    const capped = ((await fixture.opened.harness.snapshot(NotificationsDoc, context))?.items as NotificationIntent[])[0]!;
    assert.equal(deliverableDelivery(capped.delivery, new Date(later.getTime() + 10_000_000)), false);
  });
});

test("a subscription with an unusable key is removed instead of retried forever", async () => {
  await withOutbox(async (fixture) => {
    // 65 bytes that are not a valid P-256 point: encryption fails locally.
    const broken = {
      ...makeSubscription("owner").record,
      p256dh: Buffer.alloc(65, 7).toString("base64url"),
    };
    await configure(fixture, [broken]);
    await fixture.seed([intent()]);
    const calls = capture();
    const result = await drainNotificationOutbox({
      store: fixture.opened.harness,
      context,
      push: fixture.push,
      now: NOW,
      transport: calls.transport,
    });
    assert.equal(result.removedSubscriptions, 1);
    assert.equal(calls.calls.length, 0, "the send never leaves the process");
    assert.deepEqual((await fixture.push.read()).subscriptions, []);
  });
});

test("no VAPID pair leaves intents pending rather than failing them", async () => {
  await withOutbox(async (fixture) => {
    await fixture.seed([intent()]);
    const calls = capture();
    const result = await drainNotificationOutbox({
      store: fixture.opened.harness,
      context,
      push: fixture.push,
      now: NOW,
      transport: calls.transport,
    });
    assert.equal(result.skipped, 1);
    assert.equal(calls.calls.length, 0);
    const stored = await fixture.opened.harness.snapshot(NotificationsDoc, context);
    assert.equal((stored?.items as NotificationIntent[])[0]!.delivery.state, "pending");
  });
});

test("an intent appended while the sends are in flight is not clobbered", async () => {
  await withOutbox(async (fixture) => {
    const owner = makeSubscription("owner");
    await configure(fixture, [owner.record]);
    await fixture.seed([intent()]);
    const calls = capture();
    let appended = false;
    calls.setOnSend(async () => {
      if (appended) return;
      appended = true;
      await fixture.opened.harness.commit(async (tx) => {
        const draft = await tx.doc(NotificationsDoc);
        draft.items = [
          ...draft.items,
          intent({ id: "notice-2", dedupeKey: "feed_overdue|appended", userId: "owner" }),
        ];
      }, context);
    });

    await drainNotificationOutbox({
      store: fixture.opened.harness,
      context,
      push: fixture.push,
      now: NOW,
      transport: calls.transport,
    });
    const stored = await fixture.opened.harness.snapshot(NotificationsDoc, context);
    const items = stored?.items as NotificationIntent[];
    assert.equal(items.length, 2, "the appended intent survives");
    assert.equal(items.find((item) => item.id === "notice-2")?.delivery.state, "pending");
  });
});

test("the new subscription is used on the next pass, not the one in flight", async () => {
  await withOutbox(async (fixture) => {
    await fixture.seed([intent()]);
    const calls = capture();
    assert.equal(
      (
        await drainNotificationOutbox({
          store: fixture.opened.harness,
          context,
          push: fixture.push,
          now: NOW,
          transport: calls.transport,
        })
      ).skipped,
      1,
    );
    const owner = makeSubscription("owner");
    await configure(fixture, [owner.record]);
    assert.equal(
      (
        await drainNotificationOutbox({
          store: fixture.opened.harness,
          context,
          push: fixture.push,
          now: NOW,
          transport: calls.transport,
        })
      ).sent,
      1,
      "the pending intent was not dropped when it had no device",
    );
  });
});

test("push prefs default to enabled and are checked per category", () => {
  assert.equal(pushEnabledFor({ prefs: {} }, "owner", "feed_overdue"), true);
  assert.equal(pushEnabledFor({ prefs: {} }, "owner", "appointment"), true);
  assert.equal(
    pushEnabledFor({ prefs: { owner: { enabled: false, categories: ["fed"] } } }, "owner", "fed"),
    false,
  );
  assert.equal(
    pushEnabledFor({ prefs: { owner: { enabled: true, categories: ["fed"] } } }, "owner", "feed_overdue"),
    false,
  );
});

test("an ensureVapid-generated pair is enough for a send", async () => {
  await withOutbox(async (fixture) => {
    await ensureVapid(fixture.push);
    const owner = makeSubscription("owner");
    await fixture.push.update((current) => ({ ...current, subscriptions: [owner.record] }));
    await fixture.seed([intent()]);
    const calls = capture();
    const result = await drainNotificationOutbox({
      store: fixture.opened.harness,
      context,
      push: fixture.push,
      now: NOW,
      transport: calls.transport,
    });
    assert.equal(result.sent, 1);
  });
});
