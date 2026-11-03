// The Today walk card's pure half (PLAN §8.4, §8.5, §13.1).
//
// The live timer is derived from a **server** clock reading, not the device's
// (`§8.4`: "the walk timer uses the server-clock offset from the bootstrap/hello,
// not the device clock"). `GET /api/walks` answers `serverNow`, the card records
// when it received it, and every tick advances that instant by local elapsed
// time — a phone whose clock is minutes off still shows the same walk time to
// both caregivers.
//
import { localTimeText } from "./clock.js";

// These are plain functions over plain objects, so a Node test can pin the
// offset, the stale boundary and the timer formatting without a DOM. The zone
// formatting is `clock.js`'s, shared with the meals card and cached per zone.

/** Minutes since the walk started, from the server-corrected clock. */
export function walkMinutes(startedAt, nowMs) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.floor((nowMs - started) / 60_000));
}

/** Seconds since the walk started, from the server-corrected clock. */
export function walkSeconds(startedAt, nowMs) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.floor((nowMs - started) / 1000));
}

/** `m:ss` under an hour, `h:mm:ss` above. No device zone, no locale. */
export function timerText(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * The server-corrected "now" in milliseconds: the instant the server answered,
 * plus the local time elapsed since the card received it.
 */
export function correctedNow(serverNow, receivedAtMs, nowMs = Date.now()) {
  const server = Date.parse(serverNow);
  if (!Number.isFinite(server)) return nowMs;
  if (!Number.isFinite(receivedAtMs)) return server;
  return server + Math.max(0, nowMs - receivedAtMs);
}

/**
 * §8.5: stale once the open walk has run past the server's window. The payload
 * carries `staleAfterMs`, so the client does not hard-code 8 hours.
 */
export function walkStale(startedAt, nowMs, staleAfterMs) {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) return false;
  return nowMs - Date.parse(startedAt) >= staleAfterMs;
}

/** `HH:MM` for a stored instant in the household zone (what the card shows). */
export function walkTimeText(instant, timezone) {
  return localTimeText(instant, timezone);
}
