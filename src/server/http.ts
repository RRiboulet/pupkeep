// The HTTP core of the server: one small router, session auth, origin-checked
// mutations, rate limits, and the shared-thread routes (P1-09).
//
// This is deliberately a small functions-over-`node:http` router, not a frame-
// work: the server runs on one phone for two caregivers, and the routes are
//
//   GET  /healthz                liveness (no version, no counts, no paths)
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
//   * every failure answers through one mapper, so no stack trace leaves.

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { THREAD_POLL_MAX_MS, type ThreadSnapshot } from "../shared/chat.ts";
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
export const BODY_LIMIT_BYTES = 8_192;
export const TEXT_LIMIT = 2000;
export const CLIENT_ID_LIMIT = 100;
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
  /** Origins mutations may come from; a function because the tunnel origin moves. */
  readonly allowedOrigins: () => readonly string[];
  readonly logger: Logger;
  /** Long-poll wait; capped to THREAD_POLL_MAX_MS. */
  readonly pollTimeoutMs?: number;
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(JSON.stringify(body));
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
    const session = await sessionOf(deps, req);

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

async function snapshotOf(deps: HttpDeps): Promise<ThreadSnapshot> {
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
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.statusCode = 200;
  res.write("retry: 3000\n\n");

  // Snapshot first, then deltas — the §9.4 rule every attach obeys, including
  // a browser that only misplaced a connection at the tunnel restart.
  const initial = await snapshotOf(deps);
  let live = true;
  const subscriber = {
    notice: (type: "snapshot" | "batch" | "reconnect", events?: readonly AgentEvent[]) => {
      if (!live) return;
      if (type === "batch") {
        writeEvent(res, "batch", { seq: deps.bus.seq, ...(events ? { events } : {}) });
        return;
      }
      if (type === "reconnect") {
        // Not a fake event from another conversation: a marker to reattach.
        writeEvent(res, "reconnect");
        res.end();
        live = false;
      }
    },
    onClose: () => {
      live = false;
    },
  };
  const unsubscribe = deps.bus.subscribe(session!.memberId, subscriber);
  writeEvent(res, "snapshot", initial);

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
