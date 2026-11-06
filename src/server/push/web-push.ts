// Web Push payload encryption and send (RFC 8188 aes128gcm, RFC 8291;
// PLAN §12.3, §14.3).
//
// The push service only carries an opaque body; everything is implemented here
// with `node:crypto` so the phone needs no Web Push dependency and no native
// module:
//
//   * ECDH P-256 with a fresh ephemeral key per push;
//   * HKDF-SHA256 (the `WebPush: info` and aes128gcm/nonce derivations);
//   * AES-128-GCM, with the final-record padding delimiter 0x02;
//   * the RFC 8188 header (salt, record size, key id = the ephemeral public key).
//
// The payload is JSON `{ title, tag, url }` — the category-only title, the
// server dedupe key as the display `tag`, and the app route. **Never care
// detail**: `title` is the catalog string and the in-app body stays on the
// device (§14.3).
//
// Sending is best-effort by design: a 404/410 means the subscription is gone
// (the caller removes it), any other failure is retried by the outbox with
// backoff.

import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import type { PushSubscriptionRecord } from "../config.ts";
import { vapidAuthorization, type VapidKeys } from "./vapid.ts";

/** The one payload shape a push may carry. */
export type PushPayload = { title: string; tag: string; url: string };
export type PushTransport = (url: string, init: RequestInit) => Promise<Response>;

/** RFC 8291's record size; the payloads here are tiny, so one record is enough. */
export const PUSH_RECORD_SIZE = 4096;
/** A day is plenty for a reminder; the push service drops it after that. */
export const PUSH_TTL_S = 24 * 60 * 60;
/**
 * One send may not hang the outbox: a dead endpoint is retried later, but it
 * cannot hold the drain (and every other notification) for undici's default.
 */
export const PUSH_SEND_TIMEOUT_MS = 10_000;

/**
 * The push services a browser can hand us. The endpoint is a capability the
 * server POSTs to with a signed request, so a member-supplied URL is bounded to
 * the services the product supports rather than any HTTPS host (SSRF). A new
 * browser service is a deliberate addition here.
 */
const PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);

/** Whether `endpoint` is a supported push service's HTTPS URL. */
export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    PUSH_HOSTS.has(host) ||
    host.endsWith(".push.services.mozilla.com") ||
    host.endsWith(".notify.windows.com") ||
    host.endsWith(".push.apple.com")
  );
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** HKDF-Extract with SHA-256 (RFC 5869). */
function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return hmac(salt, ikm);
}

/** HKDF-Expand for outputs of at most one hash block (all of ours are). */
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  if (length > 32) throw new Error("hkdf: one block only");
  return hmac(prk, Buffer.concat([info, Buffer.from([0x01])])).subarray(0, length);
}

/**
 * Encrypt one payload for one subscription (aes128gcm). The returned body is
 * exactly what goes on the wire: `salt | rs | idlen | keyid | ciphertext`.
 */
export function encryptPushPayload(
  subscription: Pick<PushSubscriptionRecord, "p256dh" | "auth">,
  plaintext: Buffer,
): Buffer {
  const uaPublic = Buffer.from(subscription.p256dh, "base64url");
  const authSecret = Buffer.from(subscription.auth, "base64url");
  if (uaPublic.length !== 65 || authSecret.length !== 16) {
    throw new Error("a push subscription has an unusable key");
  }

  const ephemeral = createECDH("prime256v1");
  const asPublic = ephemeral.generateKeys();
  const sharedSecret = ephemeral.computeSecret(uaPublic);

  // RFC 8291 §3.4: the ECDH secret is bound to the auth secret and both public
  // keys before it becomes the input keying material.
  const prkKey = hkdfExtract(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  const salt = randomBytes(16);
  const prk = hkdfExtract(salt, ikm);
  const contentKey = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);

  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  // 0x02 marks the last (and here only) record.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(PUSH_RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** The JSON a service worker receives; title only, never the in-app body. */
export function pushPayloadJson(payload: PushPayload): string {
  return JSON.stringify({ title: payload.title, tag: payload.tag, url: payload.url });
}

export type PushSendResult =
  | { kind: "sent"; status: number }
  /** 404/410: the endpoint is gone and the subscription must be removed. */
  | { kind: "gone"; status: number }
  | { kind: "failed"; status: number | null; error?: string };

/**
 * POST one encrypted payload. The transport is injectable so tests never leave
 * the process; the default is the global `fetch`.
 */
export async function sendWebPush(
  subscription: Pick<PushSubscriptionRecord, "endpoint" | "p256dh" | "auth">,
  payload: PushPayload,
  keys: VapidKeys,
  options: { now?: Date; transport?: PushTransport } = {},
): Promise<PushSendResult> {
  const transport = options.transport ?? ((url, init) => fetch(url, init));
  let body: Buffer;
  try {
    body = encryptPushPayload(subscription, Buffer.from(pushPayloadJson(payload), "utf8"));
  } catch (error) {
    // A malformed subscription is not a transient failure; the outbox records it
    // without retrying forever.
    return { kind: "failed", status: null, error: (error as Error).message };
  }

  try {
    const response = await transport(subscription.endpoint, {
      method: "POST",
      headers: {
        TTL: String(PUSH_TTL_S),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: vapidAuthorization(subscription.endpoint, keys, options.now ?? new Date()),
      },
      body: new Uint8Array(body),
      // A push endpoint that redirects is not one we should follow with a
      // signed request, and one that hangs must not hold the outbox.
      redirect: "error",
      signal: AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 410) {
      return { kind: "gone", status: response.status };
    }
    if (response.status >= 200 && response.status < 300) {
      return { kind: "sent", status: response.status };
    }
    return { kind: "failed", status: response.status };
  } catch (error) {
    return { kind: "failed", status: null, error: (error as Error).message };
  }
}
