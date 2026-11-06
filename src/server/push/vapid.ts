// VAPID keys and the signed request header (RFC 8292; PLAN §12.3, §14.4).
//
// The key pair is generated once and lives in `push.json` — the deliberate
// exception to "secrets stay out of the backup": subscriptions survive a restore
// only if their VAPID key does. The private key never appears in a log, an API
// response or an error message; only `publicKey` is ever served.
//
// Everything here uses `node:crypto`: no Web Push dependency, and no native
// module on the phone.

import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import type { JsonFileStore } from "../json-file.ts";
import type { PushConfig } from "../config.ts";

/** The VAPID `sub` contact; push services require a URI, not a real mailbox. */
export const VAPID_SUBJECT = "mailto:pupkeep@localhost";
/** Bounded well under the 24-hour maximum; a token is minted per send. */
export const VAPID_TOKEN_TTL_S = 12 * 60 * 60;

export type VapidKeys = { publicKey: string; privateKey: string };

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * A fresh P-256 pair, encoded the way the Web Push APIs expect: the public key
 * is the uncompressed point (65 bytes, base64url) and the private key is the
 * PKCS#8 DER (base64url). Both are opaque strings in `push.json`; the parser
 * already refuses anything shorter than 32 characters.
 */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // SPKI DER ends with the 65-byte uncompressed point; that is the application
  // server key a browser's `pushManager.subscribe` expects.
  const point = publicKey.export({ format: "der", type: "spki" }).subarray(-65);
  return {
    publicKey: point.toString("base64url"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  };
}

/** The ES256 JWT for one endpoint's origin (`aud`), signed with the private key. */
export function vapidToken(
  endpoint: string,
  keys: VapidKeys,
  now: Date = new Date(),
  subject: string = VAPID_SUBJECT,
): string {
  const aud = new URL(endpoint).origin;
  const header = base64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = base64url(
    JSON.stringify({ aud, exp: Math.floor(now.getTime() / 1000) + VAPID_TOKEN_TTL_S, sub: subject }),
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey({
    key: Buffer.from(keys.privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  // JWS wants the raw r||s pair, not DER.
  const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** The `Authorization` header value: `vapid t=<jwt>, k=<application server key>`. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now: Date = new Date()): string {
  return `vapid t=${vapidToken(endpoint, keys, now)}, k=${keys.publicKey}`;
}

/**
 * The household's key pair, generating and persisting it on first use. Boot
 * calls this before serving so the public-key route never invents a second pair
 * under a concurrent read; `update` serializes the file, so two callers agree on
 * whichever pair landed first.
 */
export async function ensureVapid(store: JsonFileStore<PushConfig>): Promise<VapidKeys> {
  const current = await store.read();
  if (current.vapid) return current.vapid;
  const keys = generateVapidKeys();
  const next = await store.update((config) => (config.vapid ? config : { ...config, vapid: keys }));
  if (!next.vapid) throw new Error("push.json did not keep the VAPID keys");
  return next.vapid;
}
