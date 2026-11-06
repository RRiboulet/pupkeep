// P4-05: VAPID, Web Push encryption and the push route surface (PLAN §12.3,
// §14.3, §14.4, §16 P4-05).
//
// What is pinned here:
//   * a generated pair is a real P-256 key pair, and `ensureVapid` persists one
//     pair in push.json rather than minting a new one per call;
//   * the VAPID JWT is ES256 over the endpoint's origin, with the documented
//     expiry and subject, and verifies against the served public key;
//   * the aes128gcm body decrypts back to the payload with the subscription's
//     private key — the header layout, HKDF derivation and padding delimiter are
//     the standard's, not an approximation;
//   * the send uses the VAPID header, the aes128gcm encoding and a bounded TTL,
//     and reports 404/410 as a gone subscription;
//   * the routes serve only the public key, store a subscription per endpoint
//     and member, and remove only the caller's own.

import assert from "node:assert/strict";
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { dataStores } from "../src/server/config.ts";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import {
  ensureVapid,
  generateVapidKeys,
  vapidAuthorization,
  vapidToken,
  VAPID_TOKEN_TTL_S,
} from "../src/server/push/vapid.ts";
import {
  PUSH_TTL_S,
  encryptPushPayload,
  pushPayloadJson,
  sendWebPush,
} from "../src/server/push/web-push.ts";
import { startTestApp } from "./support/app.ts";

const context = BACKGROUND_CONTEXT;

// --- helpers ----------------------------------------------------------------

/** A browser-like subscription: the tests keep the private half to decrypt. */
function makeSubscription(endpoint = "https://push.example/send/abc") {
  // A browser-like pair: we need the JWK's private scalar, which the VAPID
  // helper deliberately does not expose.
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
      id: "sub-1",
      memberId: "owner",
      endpoint,
      p256dh: point.toString("base64url"),
      auth: auth.toString("base64url"),
      createdAt: "2026-10-29T10:00:00.000Z",
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

/** Decrypt an aes128gcm body as the browser would; proves the format. */
function decryptBody(body: Buffer, subscription: ReturnType<typeof makeSubscription>): string {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyLength = body[20]!;
  const asPublic = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(subscription.privateKey);
  const shared = ecdh.computeSecret(asPublic);
  const prkKey = hmac(subscription.auth, shared);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), subscription.uaPublic, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  const prk = hmac(salt, ikm);
  const contentKey = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const tag = ciphertext.subarray(-16);
  const data = ciphertext.subarray(0, -16);
  const decipher = createDecipheriv("aes-128-gcm", contentKey, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(data), decipher.final()]);
  assert.equal(recordSize, 4096);
  return padded.subarray(0, padded.length - 1).toString("utf8"); // strip 0x02
}

// --- VAPID ------------------------------------------------------------------

test("a generated pair is a real P-256 pair and ensureVapid keeps one pair in push.json", async () => {
  const keys = generateVapidKeys();
  assert.equal(Buffer.from(keys.publicKey, "base64url").length, 65, "the uncompressed point");
  assert.ok(Buffer.from(keys.privateKey, "base64url").length > 32);

  const dir = await mkdtemp(join(tmpdir(), "pupkeep-vapid-"));
  try {
    const push = dataStores(dir).push;
    await push.ensure();
    const first = await ensureVapid(push);
    const second = await ensureVapid(push);
    assert.deepEqual(second, first, "the same pair, not a new one per call");
    assert.deepEqual((await push.read()).vapid, first, "it is persisted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the VAPID JWT is an ES256 token over the endpoint origin and verifies", () => {
  const keys = generateVapidKeys();
  const now = new Date("2026-10-29T10:00:00.000Z");
  const token = vapidToken("https://push.example/send/abc", keys, now);
  const [header, payload, signature] = token.split(".") as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
  assert.equal(claims.aud, "https://push.example");
  assert.equal(claims.exp, Math.floor(now.getTime() / 1000) + VAPID_TOKEN_TTL_S);
  assert.match(String(claims.sub), /^mailto:/);

  // Rebuild the SPKI DER around the raw point to verify the JWS.
  const spki = Buffer.concat([
    Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
    Buffer.from(keys.publicKey, "base64url"),
  ]);
  const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
    true,
    "the signature is valid for the served key",
  );
  // ECDSA is randomized, so the header is checked by shape, not equality.
  const authorization = vapidAuthorization("https://push.example/send/abc", keys, now);
  assert.match(authorization, /^vapid t=[^,]+, k=/);
  assert.ok(authorization.endsWith(`, k=${keys.publicKey}`));
});

// --- encryption and send ----------------------------------------------------

test("an aes128gcm body decrypts to the category-only payload", () => {
  const subscription = makeSubscription();
  const plaintext = pushPayloadJson({ title: "A meal is overdue", tag: "feed_overdue|x|owner", url: "/" });
  const body = encryptPushPayload(subscription.record, Buffer.from(plaintext, "utf8"));
  assert.equal(decryptBody(body, subscription), plaintext);
  const decoded = JSON.parse(plaintext) as Record<string, unknown>;
  assert.equal(decoded.title, "A meal is overdue");
  assert.equal("body" in decoded, false, "the in-app body never enters the push payload");
});

test("a send carries the VAPID header, aes128gcm and a bounded TTL, and reports gone", async () => {
  const subscription = makeSubscription();
  const keys = generateVapidKeys();
  const calls: { url: string; init: RequestInit }[] = [];
  const answer = (status: number) =>
    ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status }));
    }) as never;

  const sent = await sendWebPush(
    subscription.record,
    { title: "A meal is overdue", tag: "k", url: "/" },
    keys,
    { transport: answer(201) },
  );
  assert.deepEqual(sent, { kind: "sent", status: 201 });
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.TTL, String(PUSH_TTL_S));
  assert.equal(headers["Content-Encoding"], "aes128gcm");
  assert.match(headers.Authorization ?? "", /^vapid t=/);
  assert.equal(calls[0]!.url, subscription.record.endpoint);

  assert.deepEqual(
    await sendWebPush(subscription.record, { title: "x", tag: "k", url: "/" }, keys, {
      transport: answer(410),
    }),
    { kind: "gone", status: 410 },
  );
  assert.deepEqual(
    await sendWebPush(subscription.record, { title: "x", tag: "k", url: "/" }, keys, {
      transport: answer(500),
    }),
    { kind: "failed", status: 500 },
  );
  const broken = await sendWebPush(
    { ...subscription.record, p256dh: "short" },
    { title: "x", tag: "k", url: "/" },
    keys,
    { transport: answer(201) },
  );
  assert.equal(broken.kind, "failed", "a malformed subscription is not retried as a transient failure");
});

// --- the routes -------------------------------------------------------------

type RouteFixture = Awaited<ReturnType<typeof startTestApp>> & {
  owner: string;
  partner: string;
};

async function startPushApp(): Promise<RouteFixture> {
  const app = await startTestApp({ prefix: "pupkeep-push-routes-", partner: true });
  assert.ok(app.cookies.partner);
  return { ...app, owner: app.cookies.owner, partner: app.cookies.partner };
}

async function post(
  fixture: RouteFixture,
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${fixture.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      "Idempotency-Key": "push-1",
      Cookie: `${SESSION_COOKIE}=${token}`,
      Origin: fixture.url,
    },
    body: JSON.stringify(body),
  });
}

test("the public-key route serves only the public half", async () => {
  const fixture = await startPushApp();
  try {
    const response = await fetch(`${fixture.url}/api/push/public-key`, {
      headers: { Cookie: `${SESSION_COOKIE}=${fixture.owner}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(typeof body.publicKey, "string");
    assert.equal("privateKey" in body, false, "the private key never leaves push.json");

    const stored = await dataStores(fixture.dir).push.read();
    assert.equal(stored.vapid?.publicKey, body.publicKey);
    assert.equal(typeof stored.vapid?.privateKey, "string");

    assert.equal((await fetch(`${fixture.url}/api/push/public-key`)).status, 401);
  } finally {
    await fixture.stop();
  }
});

test("a subscription is stored per endpoint and member, and only its owner can remove it", async () => {
  const fixture = await startPushApp();
  try {
    const subscription = makeSubscription("https://push.example/send/device-1");
    const keys = { p256dh: subscription.record.p256dh, auth: subscription.record.auth };

    const first = await post(fixture, "/api/push/subscriptions", fixture.owner, {
      endpoint: subscription.record.endpoint,
      keys,
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { id: string };
    const stored = (await dataStores(fixture.dir).push.read()).subscriptions;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.memberId, "owner");
    assert.equal(stored[0]?.id, firstBody.id);

    // Re-subscribing the same endpoint keeps its id.
    const again = await post(fixture, "/api/push/subscriptions", fixture.owner, {
      endpoint: subscription.record.endpoint,
      keys,
    });
    assert.deepEqual(await again.json(), { id: firstBody.id });
    assert.equal((await dataStores(fixture.dir).push.read()).subscriptions.length, 1);

    // The same device signed in as the partner replaces the member, not the id.
    const partner = await post(fixture, "/api/push/subscriptions", fixture.partner, {
      endpoint: subscription.record.endpoint,
      keys,
    });
    assert.equal(partner.status, 200);
    const afterPartner = (await dataStores(fixture.dir).push.read()).subscriptions;
    assert.equal(afterPartner.length, 1);
    assert.equal(afterPartner[0]?.memberId, "partner");

    // The owner no longer owns this endpoint: nothing is removed.
    const notOwner = await post(fixture, "/api/push/unsubscribe", fixture.owner, {
      endpoint: subscription.record.endpoint,
    });
    assert.deepEqual(await notOwner.json(), { removed: false });
    assert.equal((await dataStores(fixture.dir).push.read()).subscriptions.length, 1);

    const removed = await post(fixture, "/api/push/unsubscribe", fixture.partner, {
      endpoint: subscription.record.endpoint,
    });
    assert.deepEqual(await removed.json(), { removed: true });
    assert.equal((await dataStores(fixture.dir).push.read()).subscriptions.length, 0);

    // A non-HTTPS or keyless subscription is refused.
    assert.equal(
      (
        await post(fixture, "/api/push/subscriptions", fixture.owner, {
          endpoint: "http://push.example/x",
          keys,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post(fixture, "/api/push/subscriptions", fixture.owner, {
          endpoint: "https://push.example/x",
          keys: { p256dh: "short", auth: "short" },
        })
      ).status,
      409,
    );
  } finally {
    await fixture.stop();
  }
});
