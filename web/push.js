// The browser's half of Web Push (PLAN §12.3, §12.4, §16 P4-05).
//
// `enablePush` asks the server for the VAPID application server key, subscribes
// the current service-worker registration and stores the subscription;
// `disablePush` removes it both locally and on the server. The Settings screen
// (P4-06) owns the buttons and the permission copy — this module is the
// machinery, and it keeps all browser globals behind injectable seams so a Node
// test can drive it without a DOM.
//
// Only HTTPS origins support push; the daily Tailscale path is plain HTTP, so
// `pushSupported` is false there and P4-06 falls back to in-app + ntfy. That is
// a documented property of the deployment (PLAN §2.1), not a bug.

import { NetworkError, newIdempotencyKey, requestJson } from "./client.js";

/** `base64url` (the VAPID key) to the bytes `pushManager.subscribe` wants. */
export function urlBase64ToUint8Array(value) {
  const raw = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Whether this browser can receive Web Push at all. An insecure origin cannot
 * (the push service requires a secure context), so the Settings copy can say
 * so rather than failing at subscribe time.
 */
export function pushSupported(env = {}) {
  const window = env.window ?? globalThis.window;
  const navigator = env.navigator ?? globalThis.navigator;
  const secure = env.secure ?? globalThis.isSecureContext;
  return Boolean(secure && window && "serviceWorker" in navigator && "PushManager" in window);
}

/**
 * Ask the browser for permission, subscribe, and store the subscription
 * server-side. Returns `{ subscription }` on success or `{ reason }` when the
 * browser or the server refused; a refusal is ordinary copy, not an exception.
 * The request seam is injectable for tests.
 */
export async function enablePush(options = {}) {
  const request = options.request ?? requestJson;
  const navigator = options.navigator ?? globalThis.navigator;
  const supported = options.supported ?? pushSupported();
  if (!supported) return { reason: "push_unsupported" };

  const permission = await (options.permission ?? (() => Notification.requestPermission()))();
  if (permission !== "granted") return { reason: "permission_denied" };

  const keys = await request("/api/push/public-key");
  if (!keys.ok || !keys.body?.publicKey) {
    return { reason: keys.status === 401 ? "signed_out" : "key_unavailable" };
  }

  let subscription;
  try {
    const registration = options.registration ?? (await navigator.serviceWorker.ready);
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keys.body.publicKey),
    });
  } catch {
    return { reason: "subscribe_failed" };
  }

  const json = subscription.toJSON();
  const saved = await request("/api/push/subscriptions", {
    method: "POST",
    body: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    idempotencyKey: newIdempotencyKey(),
  }).catch((error) => {
    if (error instanceof NetworkError) return { ok: false, status: 0, body: undefined };
    throw error;
  });
  if (!saved.ok) {
    // The browser now holds a subscription the server does not know about; drop
    // it so a later enable starts clean.
    await subscription.unsubscribe?.().catch?.(() => undefined);
    return { reason: saved.status === 401 ? "signed_out" : "save_failed" };
  }
  return { subscription };
}

/** Remove this device's subscription on the server, then in the browser. */
export async function disablePush(options = {}) {
  const request = options.request ?? requestJson;
  const navigator = options.navigator ?? globalThis.navigator;
  const registration = options.registration ?? (await navigator.serviceWorker.ready);
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return { removed: false };
  const json = subscription.toJSON();
  const answer = await request("/api/push/unsubscribe", {
    method: "POST",
    body: { endpoint: json.endpoint },
    idempotencyKey: newIdempotencyKey(),
  }).catch((error) => {
    if (error instanceof NetworkError) return { ok: false, status: 0, body: undefined };
    throw error;
  });
  await subscription.unsubscribe?.();
  return { removed: answer.ok === true };
}
