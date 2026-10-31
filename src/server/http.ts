// The HTTP core of the server: one small router, sign-in/invite/session
// routes, origin-checked mutations, rate limits, and the shared-thread routes
// (P1-06's decision mapped here, P1-09).
//
// This is deliberately a small functions-over-`node:http` router, not a frame-
// work: the server runs on one phone for two caregivers, and the routes are
//
//   GET  /healthz                liveness (no version, no counts, no paths)
//   GET  /login?token=          owner sign-in link: session cookie, 303 to /
//   GET  /invite?code=          partner invite link: session cookie, 303 to /
//   POST /logout                revoke the current session, clear the cookie
//   GET  /api/session           who am I (label from the household, not auth)
//   POST /api/invites           owner-only invite creation, returns {code,link}
//   POST /api/agent/messages     submit into the shared thread (busy = 409)
//   GET  /api/agent/thread       full snapshot (transcript/tool cards/busy)
//   GET  /api/agent/events       SSE: snapshot first, then deltas
//   GET  /api/agent/events/poll  long-poll fallback: full snapshots only
//
// Rules inherited from the auth work (P1-06) and not weakened here:
//   * every /api route requires a valid session cookie — there is no public API;
//   * a mutation must come from an origin the server serves, checked with
//     `originAllowed` plus a same-origin `Host` check for the tailnet
//     addresses this process cannot enumerate (it only knows its bind host);
//   * every mutation also carries the fixed `X-Pupkeep-Request: 1` header and
//     a JSON content type (§14.2); the PWA client (P1-10) must send both;
//   * every failure answers through one mapper, so no stack trace leaves.
//   * sign-in/invite links are clicked from an SMS/chat client, so they are
//     GETs without an Origin; tokens and codes are single-use credentials,
//     and guessing them is met by an IP rate limit (§14.2).

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { HOUSEHOLD_FALLBACK_LABEL, THREAD_POLL_MAX_MS, type ThreadSnapshot } from "../shared/chat.ts";
import {
  Auth,
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimiter,
  Refusal,
  originAllowed,
  parseSessionCookie,
  sessionCookie,
  type CookieOptions,
  requireAction,
  type Session,
} from "./auth.ts";
import type { Logger } from "./log.ts";
import {
  ThreadUnavailableError,
  labelFor,
  readHousehold,
  readThreadSnapshot,
  submitChatMessage,
  type ThreadRef,
} from "./agent/thread.ts";
import type { ThreadBus } from "./agent/bus.ts";

/** Generous click-submit cadence; a double-send dedupes before this counts. */
export const SUBMIT_LIMIT = 20;
export const SUBMIT_WINDOW_MS = 60_000;
/** Sign-in/invite attempts: a token or code is a high-value guess. */
export const SIGNIN_LIMIT = 10;
export const SIGNIN_WINDOW_MS = 60_000;
export const BODY_LIMIT_BYTES = 8_192;
export const TEXT_LIMIT = 2000;
export const CLIENT_ID_LIMIT = 100;
/** Fixed custom header every mutation must carry (§14.2); P1-10 sends it. */
export const REQUEST_HEADER = "x-pupkeep-request";
export const REQUEST_HEADER_VALUE = "1";
/** SSE keep-alive; short enough to survive phone TCP idle timeouts. */
export const KEEPALIVE_MS = 15_000;

const BUSY_MESSAGE =
  "The assistant is already answering; keep your draft and send again when the thread frees up.";

/** Too many attempts is not a conflict; it is this server saying “slow down”. */
export class RateLimitError extends Refusal {
  constructor(message: string) {
    super(message, 429, "RateLimitError");
  }
}

/** A mutation without a JSON body is refused before the body is parsed (§14.2). */
export class UnsupportedMediaTypeError extends Refusal {
  constructor(message: string) {
    super(message, 415, "UnsupportedMediaTypeError");
  }
}

/** The authentication half of a route: no valid session is 401, not a 403 matrix row. */
function requireAgent(session: Session | undefined): Session {
  if (session === undefined) throw new AuthError("not signed in");
  return requireAction(session, "agent");
}

export interface HttpDeps {
  readonly auth: Auth;
  /** Harness + context the thread routes read and submit through (server-owned). */
  readonly thread: ThreadRef;
  /** The per-process SSE/long-poll fanout over the shared conversation. */
  readonly bus: ThreadBus;
  /** Session-submit rate limiter, keyed per member. */
  readonly submitLimiter: RateLimiter;
  /** Sign-in/invite rate limiter, keyed per client IP (PLAN §14.2). */
  readonly signInLimiter: RateLimiter;
  /** Origins mutations may come from; a function because the tunnel origin moves. */
  readonly allowedOrigins: () => readonly string[];
  readonly logger: Logger;
  /** Long-poll wait; capped to THREAD_POLL_MAX_MS. */
  readonly pollTimeoutMs?: number;
  /**
   * Test seam for the attach ordering: production leaves this unset. A test can
   * commit after the read returns and prove the commit is not lost.
   */
  readonly readSnapshot?: (thread: ThreadRef, seq: number) => Promise<ThreadSnapshot>;
}

/**
 * The origins this bind address serves. A short list on purpose: the origin of
 * a tailnet device is not enumerable by the server, and the same-origin `Host`
 * check below carries those; the Cloudflare quick-tunnel origin is added by the
 * launcher's wiring (P1-10). A named tunnel waits for a domain (P4).
 */
export function bindOrigins(host: string, port: number): string[] {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  if (host !== "0.0.0.0" && host !== "::" && host !== "") {
    origins.push(`http://${host.includes(":") ? `[${host}]` : host}:${port}`);
  }
  return origins;
}

/** Same-origin CSRF fallback: the origin targets this very request's `Host`. */
function sameOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin || !hostHeader) return false;
  try {
    return new URL(origin).host === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}

// --- proxy trust (PLAN §14.2) ----------------------------------------------

/** A peer address is loopback only when it *is* one of the loopback addresses. */
function peerIsLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

/**
 * The scheme of the request as the browser saw it. `x-forwarded-proto` is
 * trusted only from a loopback peer — the launcher's own cloudflared quick
 * tunnel connects locally — never from an arbitrary client header.
 */
function requestScheme(req: IncomingMessage): "http" | "https" {
  if (!peerIsLoopback(req)) return "http";
  const forwarded = req.headers["x-forwarded-proto"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return typeof first === "string" && first.split(",")[0]?.trim() === "https" ? "https" : "http";
}

/**
 * The client IP for rate limits: behind the local tunnel the real client is
 * in `CF-Connecting-IP`, trusted only from a loopback peer (§14.2); elsewhere
 * it is the peer address itself.
 */
function clientIp(req: IncomingMessage): string {
  if (peerIsLoopback(req)) {
    const forwarded = req.headers["cf-connecting-ip"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof first === "string" && first.trim() !== "") return first.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

// --- redirects and cookies --------------------------------------------------

/** A sign-in/invite/logout answer is a browser click: 303 to the app root. */
function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 303;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  // A credential in `/login?token=` or `/invite?code=` must not ride a
  // same-origin subresource's `Referer` (§14.2).
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function cookieOptionsFor(req: IncomingMessage): CookieOptions {
  return { secure: requestScheme(req) === "https" };
}

interface SubmitBody {
  readonly text: string;
  readonly clientMessageId: string;
}

/** Accept only the exact shape; unknown fields are none of the server's business. */
function parseSubmitBody(raw: unknown): SubmitBody | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.text !== "string" || record.text.trim() === "" || record.text.length > TEXT_LIMIT) {
    return undefined;
  }
  if (
    typeof record.clientMessageId !== "string" ||
    record.clientMessageId === "" ||
    record.clientMessageId.length > CLIENT_ID_LIMIT
  ) {
    return undefined;
  }
  return { text: record.text, clientMessageId: record.clientMessageId };
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * §14.2's CSRF layers beyond Origin and `SameSite=Lax`: a fixed custom header
 * (a cross-site form cannot set it) and a JSON content type on every mutation.
 * The PWA client (P1-10) must send both.
 */
function requireMutationHeaders(req: IncomingMessage): void {
  if (headerValue(req, REQUEST_HEADER) !== REQUEST_HEADER_VALUE) {
    throw new Refusal("a mutation needs the X-Pupkeep-Request: 1 header", 403, "ForbiddenError");
  }
  const contentType = headerValue(req, "content-type") ?? "";
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new UnsupportedMediaTypeError("a mutation must be application/json");
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) throw new ConflictError("too much to read");
    chunks.push(buffer);
  }
  if (size === 0) throw new ConflictError("a body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ConflictError("not valid JSON");
  }
}

/**
 * The one failure mapper: typed refusals keep their status, unknown failures
 * stay a 500 with no stack. `ThreadUnavailableError` answers 503 like any not-
 * ready moment.
 */
function failure(error: unknown): { status: number; message: string } {
  if (error instanceof ThreadUnavailableError) return { status: 503, message: error.message };
  if (error instanceof Refusal) return { status: error.status, message: error.message };
  return { status: 500, message: "internal error" };
}

async function sessionOf(deps: HttpDeps, req: IncomingMessage): Promise<Session | undefined> {
  const token = parseSessionCookie(req.headers.cookie);
  if (!token) return undefined;
  try {
    return await deps.auth.authenticate(token);
  } catch {
    return undefined;
  }
}

/**
 * Build the request handler. Route code may throw typed refusals; only an
 * unexpected failure becomes a logged 500, never a crash, and a session-failed
 * harness exits the process through the app, not through a request.
 */
export function createAppHandler(deps: HttpDeps): RequestListener {
  return (req, res) => {
    void dispatch(deps, req, res);
  };
}

async function dispatch(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("X-Content-Type-Options", "nosniff");
  let pathname = "";
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    // A malformed target falls through to the "not served yet" answer.
  }

  try {
    // Liveness answers before any session lookup: a probe with a cookie must
    // not read/parse config.json or walk sessions just to hear "ok" (§14.2).
    if (pathname === "/healthz" || pathname === "/health") {
      if (req.method === "GET" || req.method === "HEAD") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.statusCode = 200;
        res.end(req.method === "HEAD" ? undefined : '{"ok":true}\n');
        return;
      }
      throw new NotFoundError("no such method");
    }

    const session = await sessionOf(deps, req);

    if (pathname === "/login" && req.method === "GET") {
      await handleLogin(deps, req, res);
      return;
    }

    if (pathname === "/invite" && req.method === "GET") {
      await handleInvite(deps, req, res);
      return;
    }

    if (pathname === "/logout" && req.method === "POST") {
      await handleLogout(deps, req, res, requireAgent(session));
      return;
    }

    if (pathname === "/api/session" && req.method === "GET") {
      await handleSession(deps, res, requireAgent(session));
      return;
    }

    if (pathname === "/api/invites" && req.method === "POST") {
      // Owner-only by the P1-06 matrix; requireAction refuses a member with 403.
      await handleInvites(deps, req, res, requireAction(requireAgent(session), "invite"));
      return;
    }

    if (pathname === "/api/agent/messages" && req.method === "POST") {
      await handleMessage(deps, req, res, requireAgent(session));
      return;
    }

    if (pathname === "/api/agent/thread" && req.method === "GET") {
      requireAgent(session);
      const snapshot = await readThreadSnapshot(deps.thread, deps.bus.seq);
      sendJson(res, 200, snapshot);
      return;
    }


    if (pathname === "/api/agent/events" && req.method === "GET") {
      await handleEvents(deps, req, res, requireAgent(session));
      return;
    }

    if (pathname === "/api/agent/events/poll" && req.method === "GET") {
      await handlePoll(deps, req, res, requireAgent(session));
      return;
    }

    // Not this task's routes; the remaining app routes arrive with P1-10.
    sendJson(res, 503, {
      error:
        "route not served yet: the PWA shell and care routes arrive with P1-10 " +
        "(the shared thread itself landed with P1-09)",
    });
  } catch (error) {
    const mapped = failure(error);
    if (mapped.status >= 500) {
      deps.logger.error("a request failed", { status: mapped.status });
    } else {
      deps.logger.warn("a request was refused", { status: mapped.status });
    }
    sendJson(res, mapped.status, { error: mapped.message });
  }
}

// --- routes -----------------------------------------------------------------

async function handleMessage(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const origin = req.headers.origin;
  if (!originAllowed(origin, deps.allowedOrigins()) && !sameOrigin(origin, req.headers.host)) {
    throw new ForbiddenError(session?.role, "agent");
  }
  requireMutationHeaders(req);

  if (!deps.submitLimiter.hit(`submit:${session.memberId}`)) {
    throw new RateLimitError("too many messages right now; take your time");
  }

  const body = parseSubmitBody(await readJsonBody(req));
  if (!body) throw new ConflictError("a message needs text and a clientMessageId");

  // Actor attribution (§9.2): the author is the session member; the label is
  // resolved through the household profiles, never the auth displayName.
  const household = await readHousehold(deps.thread);
  const outcome = await submitChatMessage(deps.thread, {
    authorId: session.memberId,
    authorName: labelFor(household, session.memberId),
    text: body.text,
    clientMessageId: body.clientMessageId,
  });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (outcome.kind === "busy") {
    res.statusCode = 409;
    res.end(JSON.stringify({ accepted: false, error: "busy", message: BUSY_MESSAGE }));
    return;
  }
  res.statusCode = 202;
  res.end(
    JSON.stringify({
      accepted: true,
      submissionId: outcome.submission.id,
      status: outcome.status,
    }),
  );
}

// --- sign-in / invites / session --------------------------------------------

/**
 * The owner link's target: exchange the link token for a session cookie.
 * Token and cookie values never reach the log — the mapper logs only statuses.
 */
async function handleLogin(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!deps.signInLimiter.hit(`signin:${clientIp(req)}`)) {
    throw new RateLimitError("too many sign-in attempts; wait a minute");
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("token") ?? "";
  if (token === "") throw new AuthError("not signed in");
  const login = await deps.auth.login(token);
  res.setHeader("Set-Cookie", sessionCookie(login.token, cookieOptionsFor(req)));
  redirect(res, "/");
}

/** The partner invite's target: exchange the one-time code for a session. */
async function handleInvite(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!deps.signInLimiter.hit(`signin:${clientIp(req)}`)) {
    throw new RateLimitError("too many sign-in attempts; wait a minute");
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const code = url.searchParams.get("code") ?? "";
  if (code === "") throw new AuthError("invite is not valid");
  const accepted = await deps.auth.acceptInvite(code);
  res.setHeader("Set-Cookie", sessionCookie(accepted.token, cookieOptionsFor(req)));
  redirect(res, "/");
}

/** Sign-out this device: revoke the session row, then clear the cookie. */
async function handleLogout(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const origin = req.headers.origin;
  if (!originAllowed(origin, deps.allowedOrigins()) && !sameOrigin(origin, req.headers.host)) {
    throw new ForbiddenError(session.role, "agent");
  }
  requireMutationHeaders(req);
  const token = parseSessionCookie(req.headers.cookie);
  if (token) await deps.auth.revokeSession(token);
  res.setHeader("Set-Cookie", sessionCookie("", { ...cookieOptionsFor(req), maxAgeSeconds: 0 }));
  redirect(res, "/");
}

/** Who is asking — role from auth, but the label from the household profiles. */
async function handleSession(deps: HttpDeps, res: ServerResponse, session: Session): Promise<void> {
  const household = await readHousehold(deps.thread);
  const profile = household.members.find((member) => member.id === session.memberId);
  const label = profile?.name ?? HOUSEHOLD_FALLBACK_LABEL;
  sendJson(res, 200, {
    memberId: session.memberId,
    role: session.role,
    label,
    // The household-fallback fence: a null author id goes with the fallback.
    authorId: profile ? session.memberId : null,
  });
}

/** Owner-only: mint the partner's invite until the Settings sheet exists (P4). */
async function handleInvites(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  actor: Session,
): Promise<void> {
  const origin = req.headers.origin;
  if (!originAllowed(origin, deps.allowedOrigins()) && !sameOrigin(origin, req.headers.host)) {
    throw new ForbiddenError(actor.role, "invite");
  }
  requireMutationHeaders(req);
  if (!deps.signInLimiter.hit(`signin:${clientIp(req)}`)) {
    throw new RateLimitError("too many attempts; wait a minute");
  }
  const body = (await readJsonBody(req)) as { displayName?: unknown };
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (displayName === "" || displayName.length > 64) {
    throw new ConflictError("an invite needs a display name");
  }
  const code = await deps.auth.createInvite(actor, displayName);
  // The link points wherever this owner is browsing right now — the browser's
  // own origin — so the partner's phone lands on the same access mode.
  const scheme = requestScheme(req);
  const host = req.headers.host ?? "localhost";
  const link = `${scheme}://${host}/invite?code=${encodeURIComponent(code)}`;
  sendJson(res, 200, { code, link });
}

async function snapshotOf(deps: HttpDeps): Promise<ThreadSnapshot> {
  if (deps.readSnapshot !== undefined) return deps.readSnapshot(deps.thread, deps.bus.seq);
  return readThreadSnapshot(deps.thread, deps.bus.seq);
}

/** One SSE frame; `Notice` types are part of the wire contract with the PWA. */
function writeEvent(
  res: ServerResponse,
  type: "snapshot" | "batch" | "reconnect" | "heartbeat",
  payload?: unknown,
): void {
  if (res.writableEnded) return;
  // snapshot/batch frames carry the payload itself; the rest only carry the type.
  const body = type === "snapshot" || type === "batch" ? JSON.stringify(payload) : JSON.stringify({ type });
  res.write(`event: ${type}\ndata: ${body}\n\n`);
}

async function handleEvents(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  let live = true;
  let opened = false;
  // A batch remembers the counter value it was broadcast at. Reporting
  // `bus.seq` at delivery time instead would blur the counter across the
  // attach and hide a gap from a client that watches for one (§9.4).
  type QueueItem =
    | { type: "batch"; seq: number; events?: readonly AgentEvent[] }
    | { type: "reconnect" };
  const queue: QueueItem[] = [];

  const deliver = (item: QueueItem): void => {
    if (item.type === "batch") {
      writeEvent(res, "batch", { seq: item.seq, ...(item.events ? { events: item.events } : {}) });
      return;
    }
    // Not a fake event from another conversation: a marker to reattach.
    writeEvent(res, "reconnect");
    res.end();
    live = false;
  };

  const subscriber = {
    notice: (type: "snapshot" | "batch" | "reconnect", events?: readonly AgentEvent[]) => {
      if (!live) return;
      // §9.4 on every attach: the snapshot is written first, so deltas that
      // arrive between subscribe() and the snapshot write queue up here.
      if (type !== "batch") {
        if (!opened) queue.push({ type: "reconnect" });
        else deliver({ type: "reconnect" });
        return;
      }
      const item: QueueItem = { type: "batch", seq: deps.bus.seq, ...(events ? { events } : {}) };
      if (!opened) {
        queue.push(item);
        return;
      }
      deliver(item);
    },
    onClose: () => {
      live = false;
    },
  };

  if (deps.bus.closed) throw new ThreadUnavailableError("the thread stream ended; reconnect");

  // Subscribe before the snapshot read: a commit that lands while the read is
  // in flight must reach either the snapshot or the queue, never neither. The
  // snapshot still precedes the headers (and every delta), so a failed read is
  // a clean JSON 503 instead of a half-open event stream.
  const unsubscribe = deps.bus.subscribe(session.memberId, subscriber);

  let initial: ThreadSnapshot;
  try {
    initial = await snapshotOf(deps);
  } catch (error) {
    live = false;
    unsubscribe();
    throw error;
  }

  if (!live || res.writableEnded) {
    unsubscribe();
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.statusCode = 200;
  res.write("retry: 3000\n\n");

  writeEvent(res, "snapshot", initial);
  opened = true;
  for (const item of queue.splice(0)) {
    if (!live) break;
    // A batch at or below the snapshot's counter was broadcast before the
    // snapshot was read, so the snapshot already carries it: replaying it
    // would duplicate entries. Anything later is a genuine delta.
    if (item.type === "batch" && item.seq <= initial.seq) continue;
    deliver(item);
  }
  if (!live) {
    unsubscribe();
    return;
  }

  const heartbeat = setInterval(() => {
    if (live && !res.writableEnded) writeEvent(res, "heartbeat");
  }, KEEPALIVE_MS);
  heartbeat.unref?.();

  req.on("close", () => {
    if (heartbeat) clearInterval(heartbeat);
    live = false;
    unsubscribe();
  });
  res.on("close", () => {
    if (heartbeat) clearInterval(heartbeat);
    live = false;
    unsubscribe();
  });
}

async function handlePoll(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const since = Number(url.searchParams.get("since") ?? "0");
  const asked = Number(url.searchParams.get("ms"));
  const capped = Math.min(Number.isFinite(asked) ? asked : deps.pollTimeoutMs ?? THREAD_POLL_MAX_MS, THREAD_POLL_MAX_MS);
  const waitMs = Number.isFinite(capped) && capped >= 0 ? capped : THREAD_POLL_MAX_MS;

  // The wait holds an event slot like an SSE connection does: the same per-user
  // cap governs the fallback, and an evicted poll settles instead of hanging.
  const wake = await deps.bus.poll(session.memberId, Number.isFinite(since) ? since : 0, waitMs);
  if (wake === "closed") {
    sendJson(res, 503, { error: "the thread stream ended; reconnect" });
    return;
  }
  // Always a full snapshot — the fallback never sends deltas (§9.4).
  sendJson(res, 200, await snapshotOf(deps));
}
