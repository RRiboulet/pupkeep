// The HTTP core of the server: one small router, sign-in/invite/session
// routes, origin-checked mutations, rate limits, and the shared-thread routes
// (P1-06's decision mapped here, P1-09).
//
// This is deliberately a small functions-over-`node:http` router, not a frame-
// work: the server runs on one phone for two caregivers, and the routes are
//
//   GET  /                     the PWA shell (P1-10, served before any route)
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
//   GET  /api/puppy              the care state: puppy, roster, meals, setup
//   PATCH /api/puppy             edit the profile (rev + Idempotency-Key)
//   PATCH /api/household         set/confirm the timezone (rev + Idempotency-Key)
//   GET  /api/models             model, allowlist, last probe, key presence, budget
//   PUT  /api/models/keys        set or clear a provider key (owner; never echoed)
//   POST /api/models/probe       run the allowlist probe now (owner; rate-limited)
//   PATCH /api/models/current    pick the thread's model (owner; allowlist + budget)
//   GET  /api/budget             this month's spend against the cap (both caregivers)
//   PATCH /api/budget            set the monthly cap (owner; rev + Idempotency-Key)
//   PATCH /api/feeding/slots     set the meal schedule (rev + Idempotency-Key)
//   GET  /api/feeding/day        today's meals: slots with who fed when, extras
//   POST /api/feeding/fed        log a scheduled meal (Idempotency-Key → 409)
//   POST /api/feeding/extra      log an extra feeding (Idempotency-Key)
//   GET  /api/walks              the open walk, the server clock and the stale window
//   POST /api/walks/start        start a walk (Idempotency-Key → 409 when one is open)
//   POST /api/walks/end          end the walk the form saw (Idempotency-Key)
//   POST /api/walks/discard      discard a stale walk (Idempotency-Key)
//   GET  /api/growth             the measurement series, the trend and its copy
//   POST /api/growth             log a weight (Idempotency-Key)
//   GET  /api/training           the milestone board
//   POST /api/training/milestone    set a milestone's status and/or note (Idempotency-Key)
//   POST /api/training/custom    add a milestone of the household's own (Idempotency-Key)
//   GET  /api/showers            the shower history, the last shower and the next due date
//   POST /api/showers            log a shower (Idempotency-Key)
//   GET  /api/appointments       appointments in a local-date range (?from=&to=)
//   GET  /api/appointments/next  the next scheduled appointment
//   POST /api/appointments       create an appointment (Idempotency-Key)
//   POST /api/appointments/update  replace an appointment's fields (rev + Idempotency-Key)
//   POST /api/appointments/cancel  cancel an appointment (rev + Idempotency-Key)
//   GET  /api/approvals          the proposals with their derived state
//   POST /api/approvals/confirm  execute a proposal a caregiver confirmed (rev + Idempotency-Key)
//   POST /api/approvals/cancel   decline a proposal (rev + Idempotency-Key)
//   GET  /api/push/public-key     the VAPID application server key
//   POST /api/push/subscriptions  store this device's push subscription
//   POST /api/push/unsubscribe    remove this device's push subscription
//
// Rules inherited from the auth work (P1-06) and not weakened here:
//   * every /api route requires a valid session cookie — there is no public API;
//   * a mutation must come from an origin the server serves, checked with
//     `originAllowed` plus a same-origin `Host` check for the tailnet
//     addresses this process cannot enumerate (it only knows its bind host);
//   * every mutation also carries the fixed `X-Pupkeep-Request: 1` header and
//     a JSON content type (§14.2); the PWA client (P1-10) must send both;
//   * every failure answers through one mapper, so no stack trace leaves. A
//     JSON body's `error` is a snake_case code when the client must branch
//     (`stale`, `idempotency_conflict`, `already_fed`) and a sentence otherwise.
//   * sign-in/invite links are clicked from an SMS/chat client, so they are
//     GETs without an Origin; tokens and codes are single-use credentials,
//     and guessing them is met by an IP rate limit (§14.2).

import { randomUUID } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { isMilestoneStatus } from "../shared/training.ts";
import {
  APPOINTMENT_FIELD_KEYS,
  CALENDAR_WINDOW_RULE,
  parseCalendarWindow,
} from "../shared/calendar.ts";
import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";
import { HOUSEHOLD_FALLBACK_LABEL, THREAD_POLL_MAX_MS, type ThreadSnapshot } from "../shared/chat.ts";
import {
  MEAL_SCHEDULE_RULE,
  feedDayView,
  feedingDay,
  mealDayView,
  parseMealSlots,
  type FeedConflictView,
  type FeedWriteView,
} from "../shared/feeding.ts";
import { parsePuppyPatch, type PuppyProfile } from "../shared/profile.ts";
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
import type { ActorResolver } from "./domain/actor.ts";
import type { Logger } from "./log.ts";
import type { JsonFileStore } from "./json-file.ts";
import type { Models } from "@earendil-works/pi-ai";
import { isNtfyTopic, type PushConfig, type SecretsConfig } from "./config.ts";
import { ensureVapid } from "./push/vapid.ts";
import { isPushEndpoint } from "./push/web-push.ts";
import type { NotificationIntent } from "../shared/domain.ts";
import {
  NOTIFICATION_CATEGORIES,
  notificationIntent,
  notificationKey,
  parseNotificationIntent,
} from "../shared/notifications.ts";
import { appendNotificationIntents } from "./notifications/intents.ts";
import { NotificationsDoc, parseNotifications } from "./domain/docs.ts";
import { CLIENT_KEY_LIMIT, isCommandKey, type WriteOutcome } from "./domain/commands.ts";
import { UnavailableError, DomainConflictError } from "./domain/errors.ts";
import {
  FeedConflictError,
  logFeed,
  readFeeding,
  updateMealSlots,
  type FeedOutcome,
} from "./domain/feeding.ts";
import { updateAgentBudget, updateHouseholdTimezone } from "./domain/household.ts";
import { readBudget } from "./domain/usage.ts";
import { modelIsPaid } from "./agent/model.ts";
import { isProviderId, PROVIDERS } from "./models/collection.ts";
import { allowlistOf, probeAndCache, PROBE_CANDIDATES } from "./models/probe-run.ts";
import type { ModelProbeCache } from "./models/cache.ts";
import type { Allowlist } from "./models/allowlist.ts";
import { probeRefOf } from "./agent/model.ts";
import { readProfile, updatePuppyProfile } from "./domain/profile.ts";
import { logMeasurement, readGrowthView, type MeasurementOutcome } from "./domain/growth.ts";
import {
  MilestoneUnknownError,
  addCustomMilestone,
  readTrainingView,
  updateMilestone,
  type CustomMilestoneOutcome,
  type MilestoneUpdateOutcome,
} from "./domain/training.ts";
import { logShower, readShowerView, type ShowerOutcome } from "./domain/showers.ts";
import { retireAppointmentReminders } from "./reminders/appointment-schedule.ts";
import {
  appointmentView,
  calendarView,
  cancelAppointment,
  createAppointment,
  readCalendar,
  updateAppointment,
  upcomingAppointments,
  type AppointmentChangeOutcome,
  type AppointmentView,
} from "./domain/calendar.ts";
import {
  approvalView,
  approvalViews,
  cancelApproval,
  confirmApproval,
  readApprovals,
  type DecideOutcome,
} from "./domain/approvals.ts";
import {
  ThreadUnavailableError,
  labelFor,
  readThreadModel,
  readThreadSnapshot,
  submitChatMessage,
  type ThreadRef,
} from "./agent/thread.ts";
import { readHousehold, syncHouseholdMembers } from "./domain/household.ts";
import { localDateAt } from "./domain/time.ts";
import {
  discardWalk,
  endWalk,
  readWalks,
  startWalk,
  type WalkDiscardOutcome,
  type WalkEndOutcome,
  type WalkStartOutcome,
} from "./domain/walks.ts";
import { WALK_STALE_AFTER_MS, openWalk } from "../shared/walks.ts";
import type { ThreadBus } from "./agent/bus.ts";
import { applySecurityHeaders, serveStaticRequest } from "./static.ts";

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

/** Care routes use the matrix's `care` action (both caregivers, household scope). */
function requireCare(session: Session | undefined): Session {
  if (session === undefined) throw new AuthError("not signed in");
  return requireAction(session, "care");
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
  /** The test button's limiter (it causes an external ntfy/Web Push call). */
  readonly notificationLimiter?: RateLimiter;
  /** The probe's limiter: one press spends a provider call per model. */
  readonly probeLimiter?: RateLimiter;
  /** Origins mutations may come from; a function because the tunnel origin moves. */
  readonly allowedOrigins: () => readonly string[];
  readonly logger: Logger;
  /** VAPID keys and per-device subscriptions, read/written through one queue. */
  readonly push: JsonFileStore<PushConfig>;
  /**
   * The provider catalog, for the catalog's prices (the budget's paid/free
   * decision, P4-08). Absent only in a scaffold test; a missing catalog makes
   * every model look paid, which is the fail-closed direction.
   */
  readonly models?: Models;
  /**
   * Providers with a stored key, read **live** (a key saved from Settings must
   * count for the next probe). Absent means "none configured".
   */
  readonly modelProviders?: () => Promise<ReadonlySet<string>>;
  /** `secrets.json`: provider keys are written here and never echoed. */
  readonly secrets?: JsonFileStore<SecretsConfig>;
  /** `models.json`: the probe cache the picker reads and a probe rewrites. */
  readonly modelCache?: JsonFileStore<ModelProbeCache>;
  /** Long-poll wait; capped to THREAD_POLL_MAX_MS. */
  readonly pollTimeoutMs?: number;
  /** The server clock, injected in tests; the wall clock otherwise (P2-03's day view). */
  readonly now?: () => number;
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
 * stay a 500 with no stack. A domain `UnavailableError` (the thread or the
 * profile document is unreadable) answers 503 like any not-ready moment; a
 * `DomainConflictError` is the domain refusing a well-formed request (409).
 */
function failure(error: unknown): { status: number; message: string } {
  if (error instanceof UnavailableError) return { status: 503, message: error.message };
  if (error instanceof Refusal) return { status: error.status, message: error.message };
  if (error instanceof DomainConflictError) return { status: error.status, message: error.message };
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
    // The static shell is served first and is the only unauthenticated surface
    // (§14.2 allows it): it answers GET/HEAD for `web/` and declines everything
    // else, so `/api/…`, `/sse`, `/healthz`, `/login` and `/invite` fall through
    // to the routes below. The security headers go on before that attempt, so
    // every response — static, JSON, SSE, 503 and the mapper's 500 — rides under
    // the same policy and nothing can be sent before they are set.
    applySecurityHeaders(res);
    if (await serveStaticRequest(req, res)) return;

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

    if (pathname === "/api/puppy" && req.method === "GET") {
      requireCare(session);
      await handleProfileRead(deps, res);
      return;
    }

    if (pathname === "/api/puppy" && req.method === "PATCH") {
      await handleProfileUpdate(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/household" && req.method === "PATCH") {
      await handleHouseholdUpdate(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/budget" && req.method === "GET") {
      // The partner can see the spend (§11.3); only the owner may change the cap.
      requireCare(session);
      await handleBudgetRead(deps, res);
      return;
    }

    if (pathname === "/api/budget" && req.method === "PATCH") {
      await handleBudgetUpdate(deps, req, res, requireAction(requireCare(session), "budget"));
      return;
    }

    if (pathname === "/api/feeding/slots" && req.method === "PATCH") {
      await handleMealSlotsUpdate(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/feeding/day" && req.method === "GET") {
      requireCare(session);
      await handleFeedingDay(deps, res);
      return;
    }

    if (pathname === "/api/feeding/fed" && req.method === "POST") {
      await handleFeedWrite(deps, req, res, requireCare(session), "slot");
      return;
    }

    if (pathname === "/api/feeding/extra" && req.method === "POST") {
      await handleFeedWrite(deps, req, res, requireCare(session), "extra");
      return;
    }

    if (pathname === "/api/walks" && req.method === "GET") {
      requireCare(session);
      await handleWalksRead(deps, res);
      return;
    }

    if (pathname === "/api/walks/start" && req.method === "POST") {
      await handleWalkStart(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/walks/end" && req.method === "POST") {
      await handleWalkClose(deps, req, res, requireCare(session), "end");
      return;
    }

    if (pathname === "/api/walks/discard" && req.method === "POST") {
      await handleWalkClose(deps, req, res, requireCare(session), "discard");
      return;
    }

    if (pathname === "/api/growth" && req.method === "GET") {
      requireCare(session);
      await handleGrowthRead(deps, res);
      return;
    }

    if (pathname === "/api/growth" && req.method === "POST") {
      await handleGrowthWrite(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/training" && req.method === "GET") {
      requireCare(session);
      await handleTrainingRead(deps, res);
      return;
    }

    if (pathname === "/api/training/milestone" && req.method === "POST") {
      await handleMilestoneUpdate(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/training/custom" && req.method === "POST") {
      await handleCustomMilestone(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/showers" && req.method === "GET") {
      requireCare(session);
      await handleShowersRead(deps, res);
      return;
    }

    if (pathname === "/api/showers" && req.method === "POST") {
      await handleShowerWrite(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/appointments" && req.method === "GET") {
      requireCare(session);
      await handleAppointmentsRead(deps, req, res);
      return;
    }

    if (pathname === "/api/appointments/next" && req.method === "GET") {
      requireCare(session);
      await handleNextAppointment(deps, res);
      return;
    }

    if (pathname === "/api/appointments" && req.method === "POST") {
      await handleAppointmentCreate(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/appointments/update" && req.method === "POST") {
      await handleAppointmentUpdate(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/appointments/cancel" && req.method === "POST") {
      await handleAppointmentCancel(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/models" && req.method === "GET") {
      // The partner may see the model and the spend (§11.3); the writes below
      // are owner-only by the §14.1 matrix.
      await handleModelsRead(deps, res, requireCare(session));
      return;
    }

    if (pathname === "/api/models/keys" && req.method === "PUT") {
      await handleProviderKey(deps, req, res, requireAction(requireCare(session), "providers"));
      return;
    }

    if (pathname === "/api/models/probe" && req.method === "POST") {
      await handleModelProbe(deps, req, res, requireAction(requireCare(session), "models"));
      return;
    }

    if (pathname === "/api/models/current" && req.method === "PATCH") {
      await handleModelPick(deps, req, res, requireAction(requireCare(session), "models"));
      return;
    }

    if (pathname === "/api/approvals" && req.method === "GET") {
      requireCare(session);
      await handleApprovalsRead(deps, res);
      return;
    }

    if (pathname === "/api/approvals/confirm" && req.method === "POST") {
      await handleApprovalDecision(deps, req, res, requireCare(session), "confirm");
      return;
    }

    if (pathname === "/api/approvals/cancel" && req.method === "POST") {
      await handleApprovalDecision(deps, req, res, requireCare(session), "cancel");
      return;
    }

    if (pathname === "/api/push/public-key" && req.method === "GET") {
      requireAgent(session);
      await handlePushPublicKey(deps, res);
      return;
    }

    if (pathname === "/api/push/subscriptions" && req.method === "POST") {
      await handlePushSubscribe(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/push/unsubscribe" && req.method === "POST") {
      await handlePushUnsubscribe(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/notifications" && req.method === "GET") {
      await handleNotificationsRead(deps, res, requireCare(session));
      return;
    }

    if (pathname === "/api/notifications/unread" && req.method === "GET") {
      await handleNotificationsUnread(deps, res, requireCare(session));
      return;
    }

    if (pathname === "/api/notifications/read" && req.method === "POST") {
      await handleNotificationsReadMark(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/notifications/test" && req.method === "POST") {
      await handleNotificationsTest(deps, req, res, requireCare(session));
      return;
    }

    if (pathname === "/api/notifications/prefs" && req.method === "GET") {
      requireCare(session);
      await handleNotificationsPrefsRead(deps, res, requireCare(session));
      return;
    }

    if (pathname === "/api/notifications/prefs" && req.method === "PATCH") {
      await handleNotificationsPrefs(deps, req, res, requireAction(requireCare(session), "notification-prefs"));
      return;
    }

    if (pathname === "/api/notifications/ntfy" && req.method === "PUT") {
      await handleNotificationsNtfy(deps, req, res, requireAction(requireCare(session), "notification-prefs"));
      return;
    }

    // Not a route this build serves; the care routes arrive with their phases.
    sendJson(res, 503, {
      error:
        "route not served yet: the remaining care routes " +
        "arrive with their phases; the profile is GET/PATCH /api/puppy, " +
        "the timezone PATCH /api/household, the budget GET/PATCH /api/budget, " +
        "the meal schedule PATCH /api/feeding/slots, " +
        "today's meals GET /api/feeding/day, POST /api/feeding/fed, POST /api/feeding/extra, " +
        "walks GET /api/walks, POST /api/walks/start, POST /api/walks/end, POST /api/walks/discard, " +
        "growth GET /api/growth, POST /api/growth, " +
        "milestones GET /api/training, POST /api/training/milestone, POST /api/training/custom, " +
        "showers GET /api/showers, POST /api/showers, " +
        "appointments GET /api/appointments, GET /api/appointments/next, " +
        "POST /api/appointments, POST /api/appointments/update, POST /api/appointments/cancel, " +
        "approvals GET /api/approvals, POST /api/approvals/confirm, POST /api/approvals/cancel, " +
        "models GET /api/models, PUT /api/models/keys, POST /api/models/probe, PATCH /api/models/current, " +
        "push GET /api/push/public-key, POST /api/push/subscriptions, POST /api/push/unsubscribe, " +
        "and notifications GET /api/notifications, GET /api/notifications/unread, " +
        "POST /api/notifications/read, POST /api/notifications/test, " +
        "GET/PATCH /api/notifications/prefs, PUT /api/notifications/ntfy",
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

  // §11.3: the budget is enforced server-side, before the turn is placed. A
  // running turn can cross the cap, so this is the next submission's check; a
  // free (\$0) model stays usable at the cap, and its own turn is not blocked.
  //
  // The model is read first and the budget only for a paid one: reading the
  // budget costs a harness usage read (and, on a month rollover, a repair
  // commit), and a free model must not pay that on every message.
  const model = await readThreadModel(deps.thread);
  if (model !== undefined && modelIsPaid(deps.models, model)) {
    const now = new Date(deps.now?.() ?? Date.now());
    const budget = await readBudget(deps.thread.harness, deps.thread.context, now);
    if (!budget.paidAllowed) {
      sendJson(res, 409, {
        error: "budget_exhausted",
        message:
          `The monthly agent budget is used up ($${budget.spentUsd.toFixed(2)} of $${budget.capUsd.toFixed(2)}). ` +
          "The owner can raise it in Settings, or pick a free model.",
        budget,
      });
      return;
    }
  }

  // Actor attribution (§9.2): the author is the session member; the label is
  // resolved through the household profiles, never the auth displayName.
  const household = await readHousehold(deps.thread.harness, deps.thread.context);
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
  // §7.1: mirror the new member into `app.household` now, so their label is
  // right on this first request instead of waiting for the next boot. A failure
  // must not cost the partner their session — boot repairs it.
  try {
    const mirrored = await syncHouseholdMembers(deps.thread.harness, deps.thread.context, accepted.config);
    if (mirrored.skipped !== undefined) {
      deps.logger.warn("the new member could not be mirrored into the household", { reason: mirrored.skipped });
    }
  } catch (error) {
    deps.logger.warn("the new member could not be mirrored into the household", { error });
  }
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
  const household = await readHousehold(deps.thread.harness, deps.thread.context);
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

// --- care mutations (P1-11, P1-14) -------------------------------------------

/**
 * The three checks every care mutation shares (§14.2): an origin this server
 * serves, the fixed request header plus a JSON content type, and a storable
 * idempotency key. Returns the key so the route can namespace it — a
 * client-chosen key can never collide with a tool's task id.
 */
function requireCareMutation(deps: HttpDeps, req: IncomingMessage, session: Session): string {
  const origin = req.headers.origin;
  if (!originAllowed(origin, deps.allowedOrigins()) && !sameOrigin(origin, req.headers.host)) {
    throw new ForbiddenError(session.role, "care");
  }
  requireMutationHeaders(req);
  const key = headerValue(req, "idempotency-key");
  if (!isCommandKey(key, CLIENT_KEY_LIMIT)) {
    throw new ConflictError("a care change needs an Idempotency-Key header");
  }
  return key;
}

/**
 * The one `idempotency_conflict` answer. The key space is shared by every care
 * write (`http:<key>`), so the sentence must not claim the key was used by the
 * same kind of change — it may have been a timezone or a meal.
 */
function sendKeyConflict(res: ServerResponse): void {
  sendJson(res, 409, {
    error: "idempotency_conflict",
    message: "that idempotency key was used for a different change",
  });
}

/**
 * One answer for every care write in the §7.4 family: a stale revision is a
 * terminal 409 with the current care state (the client re-reads, it does not
 * auto-retry), a reused key is a 409 that names the cause, and success carries
 * the whole view so the caller never merges a partial update.
 */
async function respondToCareWrite(
  deps: HttpDeps,
  res: ServerResponse,
  outcome: WriteOutcome,
  subject: string,
): Promise<void> {
  if (outcome === "key-conflict") {
    sendKeyConflict(res);
    return;
  }
  const profile = await readProfile(deps.thread.harness, deps.thread.context, new Date(deps.now?.() ?? Date.now()));
  if (outcome === "stale") {
    sendJson(res, 409, {
      error: "stale",
      message: `the ${subject} changed since it was read`,
      profile,
    });
    return;
  }
  sendJson(res, 200, { profile, replayed: outcome === "replayed" });
}

/**
 * The care write's actor (§7.1, §9.2): the session member, resolved through the
 * household *inside* the commit. A member the household does not carry yet (an
 * invite whose mirror failed) travels as the household fallback with a null id,
 * never as a real id paired with the fallback label — the pairing §15.3 forbids
 * for transcripts.
 */
function careActor(session: Session): ActorResolver {
  return async (_tx, household) => {
    const known = household.members.some((member) => member.id === session.memberId);
    return known
      ? { id: session.memberId, label: labelFor(household, session.memberId) }
      : { id: null, label: HOUSEHOLD_FALLBACK_LABEL };
  };
}

/** The revision the household and meal-schedule writes echo back; a `rev`-less write is refused. */
function revisionOf(body: Record<string, unknown>): number {
  const rev = body.rev;
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) {
    throw new ConflictError("a care change needs the revision it read");
  }
  return rev;
}

/** Only the named fields; a typo in a client is visible instead of ignored. */
function requireOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ConflictError(`a care change does not accept "${key}"`);
  }
}

// --- puppy profile (P1-11) ---------------------------------------------------

/**
 * The care state the shell, the Pup screen and the agent read: the puppy, the
 * roster, the meal schedule and what first-run setup still needs. One reader
 * (`readProfile`) builds it, so this GET and the `profile` frame cannot
 * disagree about the household.
 */
async function handleProfileRead(deps: HttpDeps, res: ServerResponse): Promise<void> {
  // The process clock, not the wall clock: the care view's `today` and the
  // growth summary's staleness derive from it, and an injected clock must move
  // them together (P3-03).
  sendJson(res, 200, await readProfile(deps.thread.harness, deps.thread.context, new Date(deps.now?.() ?? Date.now())));
}

/**
 * One profile edit. §7.4: the body carries the `rev` it read plus a partial set
 * of fields, and the `Idempotency-Key` header makes a retried save a success
 * instead of a second revision. A stale `rev` is a 409 with the current profile
 * so the browser can show what the other caregiver changed.
 */
async function handleProfileUpdate(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);

  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ConflictError("a profile change is a JSON object");
  }
  const { rev, ...fields } = body as Record<string, unknown>;
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) {
    throw new ConflictError("a profile change needs the revision it read");
  }
  const patch = parsePuppyPatch(fields);
  if (!patch) throw new ConflictError("a profile change needs at least one valid field");

  const outcome = await updatePuppyProfile(deps.thread.harness, deps.thread.context, {
    actor: careActor(session),
    // Namespaced: a client-chosen key can never collide with a tool's task id.
    actionId: `http:${key}`,
    rev,
    patch,
    // The process clock: the birthday check and the view this answer returns
    // must agree with the reads (P3-03's clock fix).
    now: new Date(deps.now?.() ?? Date.now()),
  });

  if (outcome.kind === "key-conflict") {
    sendKeyConflict(res);
    return;
  }
  if (outcome.kind === "stale") {
    // Terminal for this action: the client re-reads, it does not auto-retry.
    sendJson(res, 409, {
      error: "stale",
      message: "the profile changed since it was read",
      profile: outcome.profile,
    });
    return;
  }
  sendJson(res, 200, { profile: outcome.profile, replayed: outcome.kind === "replayed" });
}

// --- first-run setup (P1-14) -------------------------------------------------

/**
 * Set or re-confirm the household timezone. Confirming an unchanged zone is a
 * real action: it is how the caregiver signs off on the one value every future
 * `localDate` derives from, so it still bumps the revision and records who did
 * it. The zone itself is validated in the domain, inside the commit.
 */
async function handleHouseholdUpdate(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ConflictError("a household change is a JSON object");
  }
  const record = body as Record<string, unknown>;
  requireOnlyKeys(record, ["rev", "timezone"]);
  const rev = revisionOf(record);
  if (typeof record.timezone !== "string") {
    throw new ConflictError("a household change needs a timezone");
  }

  const outcome = await updateHouseholdTimezone(deps.thread.harness, deps.thread.context, {
    actor: careActor(session),
    actionId: `http:${key}`,
    rev,
    timezone: record.timezone,
    // `timezoneConfirmedAt` is a stamped instant; a test's clock must move it.
    now: new Date(deps.now?.() ?? Date.now()),
  });
  await respondToCareWrite(deps, res, outcome, "timezone");
}

/**
 * This month's spend against the cap. Every caregiver sees it (§11.3: "show the
 * current model and spend in Settings; the partner can see them"); the read is
 * cheap and is what the Settings card and the agent header render.
 *
 * This is a read that can **commit**: a household month that rolled over (or a
 * total that went backwards after a restore) re-baselines `app.usage` first.
 * That is deliberate — a swap-and-repair would under-count the new month until
 * someone wrote — so do not "fix" it into a write-free read.
 */
async function handleBudgetRead(deps: HttpDeps, res: ServerResponse): Promise<void> {
  const now = new Date(deps.now?.() ?? Date.now());
  sendJson(res, 200, { budget: await readBudget(deps.thread.harness, deps.thread.context, now) });
}

/**
 * Set the monthly cap (owner-only by the §14.1 matrix). A stale household
 * revision is a terminal 409 carrying the current care view, like every other
 * §7.4 write.
 */
async function handleBudgetUpdate(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ConflictError("a budget change is a JSON object");
  }
  const record = body as Record<string, unknown>;
  requireOnlyKeys(record, ["rev", "capUsd"]);
  const rev = revisionOf(record);
  if (typeof record.capUsd !== "number") {
    throw new ConflictError("a budget change needs capUsd, a number of dollars");
  }

  const now = new Date(deps.now?.() ?? Date.now());
  const outcome = await updateAgentBudget(deps.thread.harness, deps.thread.context, {
    actor: careActor(session),
    actionId: `http:${key}`,
    rev,
    capUsd: record.capUsd,
    now,
  });
  if (outcome === "key-conflict") {
    sendKeyConflict(res);
    return;
  }
  if (outcome === "stale") {
    // Terminal for this action: the client re-reads the care view, it does not
    // auto-retry with a fresh revision.
    sendJson(res, 409, {
      error: "stale",
      message: "the household changed since it was read",
      profile: await readProfile(deps.thread.harness, deps.thread.context, now),
    });
    return;
  }
  // Success carries the budget the write produced, so the Settings card never
  // merges a partial view (the same rule every care write follows).
  sendJson(res, 200, {
    budget: await readBudget(deps.thread.harness, deps.thread.context, now),
    replayed: outcome === "replayed",
  });
}

/**
 * Replace the meal schedule, one commit for the whole list. The parser is the
 * shared one (`src/shared/feeding.ts`), so the HTTP surface and the document
 * parser cannot disagree about what a slot is; the domain re-parses before it
 * writes, so no caller can store a schedule a reader cannot load.
 */
async function handleMealSlotsUpdate(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ConflictError("a meal-schedule change is a JSON object");
  }
  const record = body as Record<string, unknown>;
  requireOnlyKeys(record, ["rev", "slots"]);
  const rev = revisionOf(record);
  const slots = parseMealSlots(record.slots);
  if (!slots) throw new ConflictError(MEAL_SCHEDULE_RULE);

  const outcome = await updateMealSlots(deps.thread.harness, deps.thread.context, {
    actor: careActor(session),
    actionId: `http:${key}`,
    rev,
    slots,
    // Since P2-09 this write also picks the day it arms reminders for and the
    // grace cutoff, so it must use the process clock the day view reads.
    now: new Date(deps.now?.() ?? Date.now()),
  });
  await respondToCareWrite(deps, res, outcome, "meal schedule");
}

// --- today's meals (P2-03) ---------------------------------------------------

/**
 * The day view: the household's current local date, its active slots with the
 * feed that claimed each, and the extra feedings. Built by the shared
 * `feedingDay`, so this route and P2-04's tool cannot disagree about a day. The
 * household is read once, for the zone the date derives from (§8.1) and for
 * §12.1's reminder delay, which rides with the day so the card can age "overdue"
 * without another request; a client renders each `at`/`timeLocal` in that same
 * `household.timezone`, which it already has in the profile, never in the
 * device's zone.
 */
async function handleFeedingDay(deps: HttpDeps, res: ServerResponse): Promise<void> {
  const now = new Date(deps.now?.() ?? Date.now());
  const [household, feeding] = await Promise.all([
    readHousehold(deps.thread.harness, deps.thread.context),
    readFeeding(deps.thread.harness, deps.thread.context),
  ]);
  const today = localDateAt(now, household.timezone);
  sendJson(res, 200, mealDayView(feedingDay(feeding, today), household.settings.feedReminderDelayMin));
}

interface FeedBody {
  readonly slotId: string | null;
  readonly amount?: string;
  readonly note?: string;
}

/**
 * The body of a meal write. A scheduled feed names its slot; an extra feeding
 * has no slot and must not quietly become one. The values are the domain's to
 * trim and cap — a meal the document parser would refuse rolls the commit back
 * — so only the shape is checked here, and a misspelt key is visible.
 */
function parseFeedBody(raw: unknown, mode: "slot" | "extra"): FeedBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("a meal is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, mode === "slot" ? ["slotId", "amount", "note"] : ["amount", "note"]);
  for (const field of ["amount", "note"] as const) {
    if (record[field] !== undefined && record[field] !== null && typeof record[field] !== "string") {
      throw new ConflictError(`the ${field} is text`);
    }
  }
  // `null` is how a form spells "left empty", and the writer treats it as unset;
  // the route must not turn that into a conflict.
  const amount = (record.amount as string | null | undefined) ?? undefined;
  const note = (record.note as string | null | undefined) ?? undefined;
  if (mode === "extra") return { slotId: null, amount, note };
  if (typeof record.slotId !== "string" || record.slotId.trim() === "") {
    throw new ConflictError("a meal needs the slot it feeds");
  }
  // An opaque id has no surrounding space; trimming is the client's whitespace,
  // not a slot the schedule is missing.
  return { slotId: record.slotId.trim(), amount, note };
}

/**
 * Log one meal. Same key and body is success (a replay), a different action on
 * an already-fed slot is a 409 carrying who/when and the current day — the one
 * `already_fed` shape — and every other refusal goes through the one mapper.
 * The answer carries the committed day, so the caller never merges a partial
 * view, and P2-04's tool renders its prose from the same `feedingDay`.
 */
async function handleFeedWrite(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  mode: "slot" | "extra",
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const body = parseFeedBody(await readJsonBody(req), mode);
  // One clock read for the write, so the committed event and the day the answer
  // carries are derived from the same instant (§8.1).
  const now = new Date(deps.now?.() ?? Date.now());

  let outcome: FeedOutcome;
  try {
    outcome = await logFeed(deps.thread.harness, deps.thread.context, {
      actor: careActor(session),
      // Namespaced like every care key: a client key cannot collide with a tool id.
      actionId: `http:${key}`,
      slotId: body.slotId,
      amount: body.amount,
      note: body.note,
      source: "ui",
      now,
    });
  } catch (error) {
    // The domain's typed conflict, translated at this boundary into the 409
    // shape; anything else is the mapper's to answer.
    if (!(error instanceof FeedConflictError)) throw error;
    const feeding = await readFeeding(deps.thread.harness, deps.thread.context);
    const conflict: FeedConflictView = {
      error: "already_fed",
      message: error.message,
      ...feedDayView(feeding, error.existing),
    };
    sendJson(res, 409, conflict);
    return;
  }

  if (outcome.kind === "key-conflict") {
    sendKeyConflict(res);
    return;
  }

  // One reader builds the day the client renders, so a write and the next GET
  // cannot disagree about which slots are fed (P2-01's view). The meal is already
  // durable when this read runs: a failure here answers 503, and the client's
  // retry with the same key replays the commit instead of logging it twice
  // (§7.2). The day is not stored in the command record on purpose — that would
  // put a whole day in every idempotency row and make a replay answer stale.
  const feeding = await readFeeding(deps.thread.harness, deps.thread.context);
  const written: FeedWriteView = {
    ...feedDayView(feeding, outcome.event),
    replayed: outcome.kind === "replayed",
  };
  sendJson(res, 200, written);
}

// --- walks (P2-07) -----------------------------------------------------------

/**
 * The open walk, the server clock and §8.5's window. The timer is derived from
 * a server offset, never the device clock (§8.4): the client remembers
 * `serverNow` and ticks locally from it.
 */
async function handleWalksRead(deps: HttpDeps, res: ServerResponse): Promise<void> {
  const now = new Date(deps.now?.() ?? Date.now());
  const walks = await readWalks(deps.thread.harness, deps.thread.context);
  sendJson(res, 200, {
    open: openWalk(walks.walks) ?? null,
    serverNow: now.toISOString(),
    staleAfterMs: WALK_STALE_AFTER_MS,
  });
}

/** An open or stale walk blocks a start (§7.3); both answer with the record. */
function respondWalkStart(res: ServerResponse, outcome: WalkStartOutcome): void {
  if (outcome.kind === "key-conflict") {
    sendKeyConflict(res);
    return;
  }
  if (outcome.kind === "open" || outcome.kind === "stale") {
    sendJson(res, 409, {
      error: outcome.kind === "stale" ? "walk_stale" : "walk_open",
      message: outcome.message,
      walk: outcome.walk,
    });
    return;
  }
  sendJson(res, 200, { walk: outcome.walk, replayed: outcome.kind === "replayed" });
}

async function handleWalkStart(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ConflictError("a walk start is a JSON object");
  }
  requireOnlyKeys(body as Record<string, unknown>, []);
  respondWalkStart(
    res,
    await startWalk(deps.thread.harness, deps.thread.context, {
      actor: careActor(session),
      actionId: `http:${key}`,
      now: new Date(deps.now?.() ?? Date.now()),
    }),
  );
}

/**
 * The body of an end or a discard. The end form must pass the walk id it
 * rendered: with no id the service would end whatever is open now, which is
 * right for the agent's "end the walk" and wrong for a stale form (§9.1).
 */
function parseWalkCloseBody(raw: unknown, mode: "end" | "discard"): {
  walkId: string;
  observations: Record<string, unknown>;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("closing a walk is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(
    record,
    mode === "end" ? ["walkId", "pee", "poop", "dogsMet", "mood", "notes"] : ["walkId"],
  );
  if (typeof record.walkId !== "string" || record.walkId.trim() === "") {
    throw new ConflictError("closing a walk needs the walk id the form showed");
  }
  const observations: Record<string, unknown> = {};
  for (const field of ["pee", "poop", "dogsMet", "mood", "notes"] as const) {
    if (record[field] !== undefined) observations[field] = record[field];
  }
  return { walkId: record.walkId.trim(), observations };
}

function respondWalkClosed(res: ServerResponse, outcome: WalkEndOutcome | WalkDiscardOutcome): void {
  if (outcome.kind === "key-conflict") {
    sendKeyConflict(res);
    return;
  }
  if (outcome.kind === "ended-already") {
    sendJson(res, 409, { error: "walk_ended", message: outcome.message, walk: outcome.walk });
    return;
  }
  if (outcome.kind === "no-open") {
    sendJson(res, 409, { error: "walk_missing", message: outcome.message });
    return;
  }
  // `ended`/`discarded` and their replay share a 200; `replayed` is the flag.
  sendJson(res, 200, { walk: outcome.walk, replayed: outcome.kind === "replayed" });
}

async function handleWalkClose(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  mode: "end" | "discard",
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const body = parseWalkCloseBody(await readJsonBody(req), mode);
  const now = new Date(deps.now?.() ?? Date.now());
  if (mode === "discard") {
    respondWalkClosed(
      res,
      await discardWalk(deps.thread.harness, deps.thread.context, {
        actor: careActor(session),
        actionId: `http:${key}`,
        walkId: body.walkId,
        now,
      }),
    );
    return;
  }
  respondWalkClosed(
    res,
    await endWalk(deps.thread.harness, deps.thread.context, {
      actor: careActor(session),
      actionId: `http:${key}`,
      walkId: body.walkId,
      observations: body.observations,
      now,
    }),
  );
}

// --- growth (P3-03) ----------------------------------------------------------

/**
 * The growth view is the Pup screen's **live read**: the `profile` frame is a
 * signal, not data (P2-05), so a measurement bumps `careSeq` and the screen
 * re-reads here. One builder (`readGrowthView`) serves this route, the POST
 * answer and the agent tool.
 */
async function handleGrowthRead(deps: HttpDeps, res: ServerResponse): Promise<void> {
  const now = new Date(deps.now?.() ?? Date.now());
  sendJson(res, 200, await readGrowthView(deps.thread.harness, deps.thread.context, now));
}

interface MeasurementBody {
  readonly weightKg: number;
  readonly heightCm?: number;
  readonly note?: string;
}

/**
 * The body of a measurement. The values are the domain's to round and cap — a
 * measurement the parser would refuse rolls the commit back — so only the shape
 * is checked here, and a misspelt key is visible instead of ignored. `null` is
 * how a form spells "left empty" and means "not set", not a conflict.
 */
function parseMeasurementBody(raw: unknown): MeasurementBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("a measurement is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, ["weightKg", "heightCm", "note"]);
  if (typeof record.weightKg !== "number") {
    throw new ConflictError("a measurement needs a weight in kilograms");
  }
  if (record.heightCm !== undefined && record.heightCm !== null && typeof record.heightCm !== "number") {
    throw new ConflictError("the height is a number of centimetres");
  }
  if (record.note !== undefined && record.note !== null && typeof record.note !== "string") {
    throw new ConflictError("the note is text");
  }
  const heightCm = (record.heightCm as number | null | undefined) ?? undefined;
  const note = (record.note as string | null | undefined) ?? undefined;
  return {
    weightKg: record.weightKg,
    ...(heightCm !== undefined ? { heightCm } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

/**
 * Log one weight. A measurement has no revision and no conflict: weighing twice
 * is legitimate (P3-01). The same key and body is a replay, a different body is
 * the one key-conflict answer, and every other refusal goes through the mapper.
 * The answer carries the committed growth view, so the screen never merges a
 * partial series.
 */
async function handleGrowthWrite(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const body = parseMeasurementBody(await readJsonBody(req));
  const now = new Date(deps.now?.() ?? Date.now());

  const outcome: MeasurementOutcome = await logMeasurement(deps.thread.harness, deps.thread.context, {
    actor: careActor(session),
    actionId: `http:${key}`,
    weightKg: body.weightKg,
    ...(body.heightCm !== undefined ? { heightCm: body.heightCm } : {}),
    ...(body.note !== undefined ? { note: body.note } : {}),
    source: "ui",
    now,
  });
  if (outcome.kind === "key-conflict") {
    sendKeyConflict(res);
    return;
  }

  // One clock read for the write and the view, so the committed point and the
  // series the answer carries are derived from the same instant (§8.4).
  const growth = await readGrowthView(deps.thread.harness, deps.thread.context, now);
  sendJson(res, 200, { growth, replayed: outcome.kind === "replayed" });
}

// --- milestones (P3-05) ------------------------------------------------------

/**
 * The board. This is the Pup screen's **live read**: the `profile` frame is a
 * signal, not data (P2-05), so a milestone change bumps `careSeq` and the screen
 * re-reads here — the same rule as growth and the day's meals.
 */
async function handleTrainingRead(deps: HttpDeps, res: ServerResponse): Promise<void> {
  sendJson(res, 200, { milestones: await readTrainingView(deps.thread.harness, deps.thread.context) });
}

/**
 * One milestone's status and/or note. `note` is deliberately **absent-vs-null**
 * sensitive here and nowhere else: absent keeps the note, `null` or "" clears it
 * (the feed and measurement parsers collapse null to absent, which would make
 * "clear the note" silently a no-op).
 */
function parseMilestoneBody(raw: unknown): {
  milestoneId: string;
  status?: "not_started" | "practicing" | "mastered";
  note?: string | null;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("a milestone change is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, ["milestoneId", "status", "note"]);
  if (typeof record.milestoneId !== "string" || record.milestoneId.trim() === "") {
    throw new ConflictError("a milestone change needs the milestone's id");
  }
  if (record.status !== undefined && !isMilestoneStatus(record.status)) {
    throw new ConflictError("a status is not_started, practicing or mastered");
  }
  if (record.note !== undefined && record.note !== null && typeof record.note !== "string") {
    throw new ConflictError("the note is text");
  }
  return {
    milestoneId: record.milestoneId.trim(),
    ...(record.status !== undefined ? { status: record.status as "not_started" | "practicing" | "mastered" } : {}),
    // Keep the distinction: `undefined` = absent, `null` = clear.
    ...(record.note !== undefined ? { note: record.note as string | null } : {}),
  };
}

/**
 * Change one milestone. A status change and a note change share the writer; an
 * unknown milestone is a 409 that carries the current board, so the screen can
 * re-render instead of guessing what is missing.
 */
async function handleMilestoneUpdate(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const body = parseMilestoneBody(await readJsonBody(req));
  const now = new Date(deps.now?.() ?? Date.now());

  let outcome: MilestoneUpdateOutcome;
  try {
    outcome = await updateMilestone(deps.thread.harness, deps.thread.context, {
      actor: careActor(session),
      actionId: `http:${key}`,
      milestoneId: body.milestoneId,
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
      source: "ui",
      now,
    });
  } catch (error) {
    if (!(error instanceof MilestoneUnknownError)) throw error;
    sendJson(res, 409, {
      error: error.message,
      milestones: await readTrainingView(deps.thread.harness, deps.thread.context),
    });
    return;
  }
  if (outcome.kind === "key-conflict") {
    sendKeyConflict(res);
    return;
  }
  sendJson(res, 200, {
    milestones: await readTrainingView(deps.thread.harness, deps.thread.context),
    replayed: outcome.kind === "replayed",
  });
}

/** Add a milestone of the household's own. */
async function handleCustomMilestone(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const raw = await readJsonBody(req);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("a milestone is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, ["title"]);
  if (typeof record.title !== "string") throw new ConflictError("a milestone needs a title");

  const outcome: CustomMilestoneOutcome = await addCustomMilestone(deps.thread.harness, deps.thread.context, {
    actor: careActor(session),
    actionId: `http:${key}`,
    title: record.title,
    source: "ui",
    now: new Date(deps.now?.() ?? Date.now()),
  });
  if (outcome.kind === "key-conflict") {
    sendKeyConflict(res);
    return;
  }
  sendJson(res, 200, {
    milestones: await readTrainingView(deps.thread.harness, deps.thread.context),
    replayed: outcome.kind === "replayed",
  });
}

// --- showers (P3-07) --------------------------------------------------------

/**
 * The shower surface is the Pup screen's **live read**, like growth and the
 * milestone board: the `profile` frame is a signal, not data (P2-05), so logging
 * a shower bumps `careSeq` and the screen re-reads here.
 *
 * This is also the **only** place the history is served. It is unbounded
 * (P3-07's carried note, P5-07 measures the growth), so a write's answer stays
 * bounded and the card re-reads this read rather than adopting a collection.
 */
async function handleShowersRead(deps: HttpDeps, res: ServerResponse): Promise<void> {
  const now = new Date(deps.now?.() ?? Date.now());
  sendJson(res, 200, await readShowerView(deps.thread.harness, deps.thread.context, now));
}

interface ShowerBody {
  readonly shampoo?: string;
  readonly notes?: string;
}

/**
 * The body of a shower. Both fields are optional free text, and `null` is how a
 * form spells "left empty" — the same shape rule as a measurement. The values
 * are the domain's to trim and cap, so only the text type is checked here.
 */
function parseShowerBody(raw: unknown): ShowerBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("a shower is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, ["shampoo", "notes"]);
  for (const field of ["shampoo", "notes"] as const) {
    const value = record[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new ConflictError(`the ${field} is text`);
    }
  }
  const shampoo = (record.shampoo as string | null | undefined) ?? undefined;
  const notes = (record.notes as string | null | undefined) ?? undefined;
  return {
    ...(shampoo !== undefined ? { shampoo } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

/**
 * Log one shower. A shower has no revision and no conflict — a second rinse is
 * legitimate (P3-06). The same key and body is a replay, a different body is the
 * one key-conflict answer, and every other refusal goes through the mapper.
 *
 * The answer is deliberately bounded to the committed record: the history can
 * grow without limit, so the client re-reads `GET /api/showers` on the care
 * signal instead of taking a collection from a write's answer.
 */
async function handleShowerWrite(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const body = parseShowerBody(await readJsonBody(req));
  const now = new Date(deps.now?.() ?? Date.now());

  const outcome: ShowerOutcome = await logShower(deps.thread.harness, deps.thread.context, {
    actor: careActor(session),
    actionId: `http:${key}`,
    ...(body.shampoo !== undefined ? { shampoo: body.shampoo } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    source: "ui",
    now,
  });
  if (outcome.kind === "key-conflict") {
    sendKeyConflict(res);
    return;
  }
  sendJson(res, 200, { shower: outcome.shower, replayed: outcome.kind === "replayed" });
}

// --- notifications (P4-06) ---------------------------------------------------

/** The member's default prefs: everything §12.1 offers, enabled. */
function defaultPrefs(): { enabled: boolean; categories: string[] } {
  return { enabled: true, categories: [...NOTIFICATION_CATEGORIES] };
}

/**
 * What the browser gets: the reader's fields only. The outbox's delivery state
 * and the dedupe key are server bookkeeping, not the centre's copy.
 */
function notificationView(item: NotificationIntent): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    category: item.category,
    createdAt: item.createdAt,
    readAt: item.readAt,
  };
}

/** The intents for this member, newest first. The document is append order. */
function memberItems(items: readonly NotificationIntent[], memberId: string): NotificationIntent[] {
  return items.filter((item) => item.userId === memberId).reverse();
}

function unreadCount(items: readonly NotificationIntent[], memberId: string): number {
  return items.filter((item) => item.userId === memberId && item.readAt === null).length;
}

/**
 * The centre's one read: the member's items (newest first), the unread count,
 * their prefs and their ntfy topic. Only their own items leave the server —
 * another caregiver's in-app copy is not this member's to read.
 */
async function handleNotificationsRead(
  deps: HttpDeps,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const snapshot = await deps.thread.harness.snapshot(NotificationsDoc, deps.thread.context);
  const parsed = snapshot === undefined ? undefined : parseNotifications(snapshot);
  // A missing document is an empty centre, not an error: boot creates it, and a
  // household that has never had a notification should not see a 503.
  if (!parsed) {
    sendJson(res, 200, { items: [], unread: 0 });
    return;
  }
  const items = memberItems(parsed.items, session.memberId);
  sendJson(res, 200, {
    items: items.map(notificationView),
    unread: unreadCount(parsed.items, session.memberId),
  });
}

/**
 * The member's own notification settings: prefs and ntfy topic. A separate
 * resource from the centre, so a Settings read never pulls the item list (and
 * the centre never needs push.json to be readable).
 */
async function handleNotificationsPrefsRead(
  deps: HttpDeps,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const config = await deps.push.read();
  sendJson(res, 200, {
    prefs: config.prefs[session.memberId] ?? defaultPrefs(),
    ntfy: config.ntfy[session.memberId]?.topic ?? null,
  });
}

/** The nav badge's cheap read: the count only. */
async function handleNotificationsUnread(
  deps: HttpDeps,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const snapshot = await deps.thread.harness.snapshot(NotificationsDoc, deps.thread.context);
  const parsed = snapshot === undefined ? undefined : parseNotifications(snapshot);
  sendJson(res, 200, { unread: parsed ? unreadCount(parsed.items, session.memberId) : 0 });
}

/**
 * Mark one item (by id) or every item read. Idempotent: an already-read item is
 * left alone, so a double tap is a no-op rather than a second write.
 */
async function handleNotificationsReadMark(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  requireCareMutation(deps, req, session);
  const raw = await readJsonBody(req);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("a read change is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, ["id", "all"]);
  const all = record.all === true;
  const id = record.id;
  if (!all && (typeof id !== "string" || id === "")) {
    throw new ConflictError("a read change needs an item id or all: true");
  }
  // The document exists after boot; a read-mark must not create an empty one
  // (the same create-on-acquire hazard as the reminder checks). Nothing to mark
  // is an empty answer, not an error.
  if ((await deps.thread.harness.snapshot(NotificationsDoc, deps.thread.context)) === undefined) {
    sendJson(res, 200, { unread: 0 });
    return;
  }
  const now = new Date(deps.now?.() ?? Date.now());
  const unread = await deps.thread.harness.commit(async (tx) => {
    const draft = await tx.doc(NotificationsDoc);
    for (const item of draft.items) {
      if (item.userId !== session.memberId || item.readAt !== null) continue;
      if (!all && item.id !== id) continue;
      item.readAt = now.toISOString();
    }
    return unreadCount(draft.items, session.memberId);
  }, deps.thread.context);
  sendJson(res, 200, { unread });
}

/**
 * The Settings test button: commit a `test` intent for the caller and let the
 * outbox deliver it to whatever transport that member has. The body carries no
 * care content (§14.3), and the dedupe key is unique per press so a second test
 * is a second notification rather than a silent drop.
 */
async function handleNotificationsTest(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  // The client key makes a retried request one test, not two; a fresh press
  // sends a fresh key.
  const key = requireCareMutation(deps, req, session);
  // The test causes a real external delivery; a loop must not spam ntfy.sh or a
  // push service. Production always supplies the limiter.
  if (deps.notificationLimiter !== undefined && !deps.notificationLimiter.hit(`notification-test:${session.memberId}`)) {
    throw new RateLimitError("too many test notifications; wait a minute");
  }
  const now = new Date(deps.now?.() ?? Date.now());
  const item = notificationIntent({
    dedupeKey: notificationKey("test", key),
    category: "test",
    userId: session.memberId,
    body: "This is a test notification.",
    now,
  });
  // A retried press with the same key finds its committed item and returns it;
  // a fresh press has a fresh key and a new item.
  const stored = await deps.thread.harness.commit(async (tx) => {
    // Read before the write: a table/document read after this commit writes
    // would throw `ReadAfterWrite`.
    const draft = await tx.doc(NotificationsDoc);
    const existing = draft.items.find((entry) => entry.dedupeKey === item.dedupeKey);
    // Detach from the draft overlay: the commit is about to settle it.
    if (existing !== undefined) return parseNotificationIntent(existing) ?? item;
    await appendNotificationIntents(tx, [item], now);
    return item;
  }, deps.thread.context);
  sendJson(res, 200, { item: stored, replayed: stored.id !== item.id });
}

/** Replace this member's preferences; the outbox reads them on every pass. */
async function handleNotificationsPrefs(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  requireCareMutation(deps, req, session);
  const raw = await readJsonBody(req);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("a preferences change is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, ["enabled", "categories"]);
  if (typeof record.enabled !== "boolean" || !Array.isArray(record.categories)) {
    throw new ConflictError("preferences need enabled and a category list");
  }
  const categories: string[] = [];
  for (const category of record.categories) {
    if (typeof category !== "string" || !(NOTIFICATION_CATEGORIES as readonly string[]).includes(category)) {
      throw new ConflictError("an unknown notification category");
    }
    if (!categories.includes(category)) categories.push(category);
  }
  const prefs = { enabled: record.enabled, categories };
  const config = await deps.push.update((current) => ({
    ...current,
    prefs: { ...current.prefs, [session.memberId]: { enabled: prefs.enabled, categories: categories as never } },
  }));
  sendJson(res, 200, { prefs: config.prefs[session.memberId] });
}

/** Set or clear this member's ntfy topic (a bearer secret; never logged). */
async function handleNotificationsNtfy(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  requireCareMutation(deps, req, session);
  const raw = await readJsonBody(req);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("an ntfy change is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, ["topic"]);
  const topic = record.topic;
  if (topic !== null && !isNtfyTopic(topic)) {
    throw new ConflictError("an ntfy topic is 22 or more letters, digits, dashes or underscores");
  }
  const config = await deps.push.update((current) => {
    const ntfy = { ...current.ntfy };
    if (topic === null) delete ntfy[session.memberId];
    else ntfy[session.memberId] = { topic: topic as string };
    return { ...current, ntfy };
  });
  sendJson(res, 200, { topic: config.ntfy[session.memberId]?.topic ?? null });
}

// --- push subscriptions (P4-05) ---------------------------------------------

/** Enough for every device a two-caregiver household re-installs; oldest go. */
export const PUSH_SUBSCRIPTIONS_MAX = 20;
const PUSH_ENDPOINT_MAX = 2048;

/**
 * This server's VAPID application server key. Only the public half is served;
 * the private key never leaves `push.json`. It is generated on first use, so the
 * route and boot agree on one pair.
 */
async function handlePushPublicKey(deps: HttpDeps, res: ServerResponse): Promise<void> {
  const keys = await ensureVapid(deps.push);
  sendJson(res, 200, { publicKey: keys.publicKey });
}

interface PushSubscriptionBody {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/**
 * The browser's `PushSubscription.toJSON()` shape. The lengths mirror the
 * `push.json` parser so a subscription is refused here rather than stored and
 * failing at send time; the endpoint must be HTTPS (the push service origin).
 */
function parsePushSubscriptionBody(raw: unknown): PushSubscriptionBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("a push subscription is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, ["endpoint", "keys"]);
  const keys = record.keys;
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
    throw new ConflictError("a push subscription needs its keys");
  }
  const keyRecord = keys as Record<string, unknown>;
  requireOnlyKeys(keyRecord, ["p256dh", "auth"]);
  const { endpoint } = record;
  const { p256dh, auth } = keyRecord;
  if (typeof endpoint !== "string" || endpoint.length > PUSH_ENDPOINT_MAX || !isPushEndpoint(endpoint)) {
    throw new ConflictError("a push subscription needs a supported push service endpoint (FCM, Mozilla, Apple or Windows)");
  }
  // Node's base64url decoder drops invalid characters, so length alone is not
  // enough: decode and check the exact key sizes the encryption requires.
  if (typeof p256dh !== "string" || Buffer.from(p256dh, "base64url").length !== 65) {
    throw new ConflictError("a push subscription needs its 65-byte p256dh key");
  }
  if (typeof auth !== "string" || Buffer.from(auth, "base64url").length !== 16) {
    throw new ConflictError("a push subscription needs its 16-byte auth secret");
  }
  return { endpoint, p256dh, auth };
}

/**
 * Store this device's subscription for the signed-in member. One subscription
 * per endpoint: re-subscribing keeps its id and creation instant, so a repeated
 * call is a no-op rather than a duplicate push per send.
 */
async function handlePushSubscribe(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  // The shared guard also requires an Idempotency-Key; the endpoint is the real
  // identity, so the key is only the mutation-header contract here.
  requireCareMutation(deps, req, session);
  const body = parsePushSubscriptionBody(await readJsonBody(req));
  const now = new Date(deps.now?.() ?? Date.now());

  const config = await deps.push.update((current) => {
    const previous = current.subscriptions.find((subscription) => subscription.endpoint === body.endpoint);
    const kept = current.subscriptions.filter((subscription) => subscription.endpoint !== body.endpoint);
    const record = {
      id: previous?.id ?? randomUUID(),
      memberId: session.memberId,
      endpoint: body.endpoint,
      p256dh: body.p256dh,
      auth: body.auth,
      createdAt: previous?.createdAt ?? now.toISOString(),
    };
    return { ...current, subscriptions: [...kept, record].slice(-PUSH_SUBSCRIPTIONS_MAX) };
  });
  const record = config.subscriptions.find((subscription) => subscription.endpoint === body.endpoint);
  sendJson(res, 200, { id: record?.id ?? "" });
}

/** Remove this member's subscription for the endpoint the browser is dropping. */
async function handlePushUnsubscribe(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  requireCareMutation(deps, req, session);
  const raw = await readJsonBody(req);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("a push unsubscribe is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, ["endpoint"]);
  const endpoint = record.endpoint;
  if (typeof endpoint !== "string" || endpoint === "" || endpoint.length > PUSH_ENDPOINT_MAX) {
    throw new ConflictError("a push unsubscribe needs the subscription endpoint");
  }
  let removed = false;
  await deps.push.update((current) => {
    const kept = current.subscriptions.filter(
      (subscription) => !(subscription.endpoint === endpoint && subscription.memberId === session.memberId),
    );
    removed = kept.length !== current.subscriptions.length;
    return { ...current, subscriptions: kept };
  });
  sendJson(res, 200, { removed });
}

// --- appointments (P4-02) ----------------------------------------------------

/** A JSON object body, or the one sentence saying why it is not. */
function appointmentBody(raw: unknown, allowed: readonly string[], subject: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError(`an ${subject} is a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, allowed);
  return record;
}

/** The record id from a body; appointments and proposals are addressed by id. */
function bodyIdOf(record: Record<string, unknown>, subject: string): string {
  const id = record.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new ConflictError(`a ${subject} needs its id`);
  }
  return id.trim();
}

function appointmentIdOf(record: Record<string, unknown>): string {
  return bodyIdOf(record, "appointment change");
}

/**
 * The ranged read. Filtering is by household-local date, so the window is
 * parsed against the household's today — never the device's zone (§8.4). An
 * invalid or over-wide range is a 409 sentence, not a 500.
 */
async function handleAppointmentsRead(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const now = new Date(deps.now?.() ?? Date.now());
  const household = await readHousehold(deps.thread.harness, deps.thread.context);
  const url = new URL(req.url ?? "/", "http://localhost");
  const window = parseCalendarWindow(
    url.searchParams.get("from") ?? undefined,
    url.searchParams.get("to") ?? undefined,
    localDateAt(now, household.timezone),
  );
  if (!window) throw new ConflictError(CALENDAR_WINDOW_RULE);
  const calendar = await readCalendar(deps.thread.harness, deps.thread.context);
  sendJson(res, 200, calendarView(household, calendar, now, window));
}

/**
 * The next scheduled appointment, for Today's countdown. It is deliberately
 * small: Today does not need a range, and a month of records on every load would
 * be the calendar screen's job.
 */
async function handleNextAppointment(deps: HttpDeps, res: ServerResponse): Promise<void> {
  const now = new Date(deps.now?.() ?? Date.now());
  const [household, calendar] = await Promise.all([
    readHousehold(deps.thread.harness, deps.thread.context),
    readCalendar(deps.thread.harness, deps.thread.context),
  ]);
  const next = upcomingAppointments(calendar, now, 1)[0];
  sendJson(res, 200, {
    timezone: household.timezone,
    today: localDateAt(now, household.timezone),
    next: next === undefined ? null : appointmentView(next),
  });
}

/**
 * Create one appointment. The fields are the body; the zone and the default
 * reminder offsets come from the household inside the commit, never from the
 * client. The answer is the committed record with its derived instants.
 */
async function handleAppointmentCreate(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const fields = appointmentBody(await readJsonBody(req), APPOINTMENT_FIELD_KEYS, "appointment");
  const outcome = await createAppointment(deps.thread.harness, deps.thread.context, {
    actor: careActor(session),
    actionId: `http:${key}`,
    fields,
    now: new Date(deps.now?.() ?? Date.now()),
  });
  if (outcome.kind === "key-conflict") {
    sendKeyConflict(res);
    return;
  }
  sendJson(res, 200, {
    appointment: appointmentView(outcome.appointment),
    replayed: outcome.kind === "replayed",
  });
}

/**
 * One answer for update and cancel (§7.4): a stale revision is a terminal 409
 * carrying the **current appointment** the domain read (the caller re-reads and
 * re-decides), a reused key is the one key-conflict answer, and success carries
 * the committed record with its derived instants. A missing appointment reaches
 * the mapper as a 404; it is neither stale nor a key conflict.
 */
async function respondToAppointmentWrite(
  deps: HttpDeps,
  res: ServerResponse,
  outcome: AppointmentChangeOutcome,
): Promise<void> {
  if (outcome.kind === "key-conflict") {
    sendKeyConflict(res);
    return;
  }
  if (outcome.kind === "stale") {
    // The domain carries the committed record it read at the revision check, so
    // the conflict names the other caregiver's values without a second read.
    sendJson(res, 409, {
      error: "stale",
      message: "the appointment changed since it was read",
      appointment: appointmentView(outcome.appointment),
    });
    return;
  }
  // The care write already committed; retiring its replaced reminders is
  // best-effort and must not turn a successful save into an error. A failed
  // abort is logged — the old task still no-ops on its revision check.
  if (outcome.retiredTaskIds.length > 0) {
    const failed = await retireAppointmentReminders(
      deps.thread.harness,
      outcome.retiredTaskIds,
      deps.thread.context,
    );
    if (failed.length > 0) {
      deps.logger.warn("could not abort replaced appointment reminders", { taskIds: failed });
    }
  }
  sendJson(res, 200, {
    appointment: appointmentView(outcome.appointment),
    replayed: outcome.kind === "replayed",
  });
}

/** Replace an appointment's editable fields; `rev` is the one that was read. */
async function handleAppointmentUpdate(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const record = appointmentBody(
    await readJsonBody(req),
    [...APPOINTMENT_FIELD_KEYS, "id", "rev"],
    "appointment change",
  );
  const id = appointmentIdOf(record);
  const rev = revisionOf(record);
  const { id: _id, rev: _rev, ...fields } = record;
  const outcome = await updateAppointment(deps.thread.harness, deps.thread.context, {
    actor: careActor(session),
    actionId: `http:${key}`,
    id,
    rev,
    fields,
    now: new Date(deps.now?.() ?? Date.now()),
  });
  await respondToAppointmentWrite(deps, res, outcome);
}

/** Cancel an appointment: a state change, so the record stays readable. */
async function handleAppointmentCancel(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const record = appointmentBody(await readJsonBody(req), ["id", "rev"], "appointment change");
  const id = appointmentIdOf(record);
  const rev = revisionOf(record);
  const outcome = await cancelAppointment(deps.thread.harness, deps.thread.context, {
    actor: careActor(session),
    actionId: `http:${key}`,
    id,
    rev,
    now: new Date(deps.now?.() ?? Date.now()),
  });
  await respondToAppointmentWrite(deps, res, outcome);
}

// --- models and providers (P4-08) --------------------------------------------

/** One catalog price, as the picker shows it. Never a key, never a usage secret. */
function priceOf(models: Models | undefined, provider: string, modelId: string): { input: number; output: number } | null {
  const cost = models?.getModel(provider, modelId)?.cost;
  return cost ? { input: cost.input, output: cost.output } : null;
}

/** The §11.2 candidates with their prices, for the picker's copy. */
function candidateViews(models: Models | undefined): Array<Record<string, unknown>> {
  return PROBE_CANDIDATES.map((target) => ({
    id: `${target.provider}/${target.model}`,
    provider: target.provider,
    model: target.model,
    price: priceOf(models, target.provider, target.model),
    // The one money rule (`shared/usage.ts`), never a fourth copy of it.
    paid: modelIsPaid(models, { provider: target.provider, modelId: target.model }),
  }));
}

/** The allowlist as the Settings sheet reads it: ids and reasons, no secrets. */
function allowlistView(allowlist: Allowlist): Record<string, unknown> {
  return {
    allowed: allowlist.allowed.map((entry) => ({ id: entry.id, verifiedAt: entry.verifiedAt ?? null })),
    unverified: allowlist.unverified.map((item) => ({ id: item.entry.id, reason: item.reason })),
    dropped: allowlist.dropped.map((entry) => ({ id: entry.id, status: entry.status })),
  };
}

/** Which providers have a key. The key itself never leaves `secrets.json`. */
async function providerView(secrets: JsonFileStore<SecretsConfig> | undefined): Promise<Record<string, boolean>> {
  const keyed = secrets === undefined ? new Set<string>() : new Set(Object.keys((await secrets.read()).providerKeys));
  return Object.fromEntries(PROVIDERS.map((provider) => [provider, keyed.has(provider)]));
}

/**
 * Everything the Settings card needs in one read: the configured model, the
 * allowlist with its reasons, the last probe, the provider key **presence** and
 * this month's budget (§11.3: both caregivers may see the current model and the
 * spend; only the owner may change them).
 */
async function handleModelsRead(deps: HttpDeps, res: ServerResponse, session: Session): Promise<void> {
  const now = new Date(deps.now?.() ?? Date.now());
  const cache = deps.modelCache === undefined ? undefined : await deps.modelCache.read();
  const current = await readThreadModel(deps.thread);
  const household = await readHousehold(deps.thread.harness, deps.thread.context);
  const budget = await readBudget(deps.thread.harness, deps.thread.context, now);
  sendJson(res, 200, {
    // The household revision the cap write echoes (§7.4); one read, so a stale
    // draft is refused rather than silently applied.
    householdRev: household.rev,
    // The card hides an owner-only control with this; the server still refuses
    // the write for a member, so this is a courtesy, not the fence.
    role: session.role,
    current:
      current === undefined
        ? null
        : {
            ...current,
            id: `${current.provider}/${current.modelId}`,
            paid: modelIsPaid(deps.models, current),
            price: priceOf(deps.models, current.provider, current.modelId),
          },
    providers: await providerView(deps.secrets),
    allowlist: allowlistView(cache === undefined ? { allowed: [], unverified: [], dropped: [] } : allowlistOf(cache)),
    // An untouched cache (the store's initial value) is "never probed", not a
    // probe at the epoch.
    probe: cache === undefined || cache.results.length === 0 ? null : { checkedAt: cache.checkedAt, results: cache.results },
    candidates: candidateViews(deps.models),
    budget,
  });
}

/**
 * Set or clear one provider's API key (owner-only, §14.1 `providers`). The key is
 * written to `secrets.json` (0600, serialized) and **never** echoed: the answer
 * carries only which providers are configured, so a log line or a screenshot of
 * the screen cannot leak it.
 */
async function handleProviderKey(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  requireCareMutation(deps, req, session);
  if (deps.secrets === undefined) throw new UnavailableError("the secrets file is not available; retry after boot");
  const raw = await readJsonBody(req);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("a provider key change is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, ["provider", "key"]);
  if (!isProviderId(record.provider)) {
    throw new ConflictError(`a provider is one of ${PROVIDERS.join(", ")}`);
  }
  const provider = record.provider;
  const key = record.key;
  if (key !== null && (typeof key !== "string" || key.trim() === "" || key.trim().length > 512 || /[\u0000-\u001f\u007f]/.test(key))) {
    throw new ConflictError("a provider key is one line of text, or null to clear it");
  }
  await deps.secrets.update((config) => {
    const providerKeys = { ...config.providerKeys };
    if (key === null) delete providerKeys[provider];
    else providerKeys[provider] = (key as string).trim();
    return { ...config, providerKeys };
  });
  // The credential is read per request, so a saved key takes effect immediately
  // for the next probe and the next message.
  sendJson(res, 200, { providers: await providerView(deps.secrets) });
}

/**
 * Run the allowlist probe now (owner-only). It costs one provider call per
 * candidate on a configured provider, so it is rate-limited like the notification
 * test; its spend is outside `harness.usage()` and is reported per result rather
 * than added to the budget (§11.2's stated exception).
 */
async function handleModelProbe(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  requireCareMutation(deps, req, session);
  if (deps.modelCache === undefined || deps.models === undefined) {
    throw new UnavailableError("the model catalog is not available; retry after boot");
  }
  if (deps.probeLimiter !== undefined && !deps.probeLimiter.hit(`model-probe:${session.memberId}`)) {
    throw new RateLimitError("too many probes; wait a minute");
  }
  const configured = deps.modelProviders === undefined ? new Set<string>() : await deps.modelProviders();
  const run = await probeAndCache(deps.modelCache, {
    models: deps.models,
    configured,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  sendJson(res, 200, {
    checkedAt: run.checkedAt,
    providers: run.providers,
    skipped: run.skipped.map((target) => `${target.provider}/${target.model}`),
    results: run.results,
    allowlist: allowlistView(run.allowlist),
  });
}

/**
 * Pick the shared thread's model (owner-only, §14.1 `models`). Two fences: the
 * model must be on the allowlist (a live tool-calling probe said yes), and a
 * **paid** model is refused while the budget is at its cap (§11.3) — free models
 * stay selectable there.
 */
async function handleModelPick(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
): Promise<void> {
  requireCareMutation(deps, req, session);
  if (deps.models === undefined || deps.modelCache === undefined) {
    throw new UnavailableError("the model catalog is not available; retry after boot");
  }
  const raw = await readJsonBody(req);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConflictError("a model choice is a JSON object");
  }
  const record = raw as Record<string, unknown>;
  requireOnlyKeys(record, ["model"]);
  const ref = typeof record.model === "string" ? probeRefOf(record.model) : undefined;
  if (!ref) throw new ConflictError("a model choice is one \"provider/model\" id");
  if (deps.models.getModel(ref.provider, ref.modelId) === undefined) {
    throw new ConflictError("that model is not in the provider catalog");
  }
  const cache = await deps.modelCache.read();
  const allowed = new Set(allowlistOf(cache).allowed.map((entry) => entry.id));
  if (!allowed.has(`${ref.provider}/${ref.modelId}`)) {
    throw new DomainConflictError(
      `${JSON.stringify(record.model)} has not passed a live tool-calling probe; run the check in Settings first`,
    );
  }
  const now = new Date(deps.now?.() ?? Date.now());
  const budget = await readBudget(deps.thread.harness, deps.thread.context, now);
  if (!budget.paidAllowed && modelIsPaid(deps.models, ref)) {
    throw new DomainConflictError(
      `The monthly agent budget is used up ($${budget.spentUsd.toFixed(2)} of $${budget.capUsd.toFixed(2)}); ` +
        "the owner can raise it, or choose a free model.",
    );
  }
  const household = await readHousehold(deps.thread.harness, deps.thread.context);
  const conversation = await deps.thread.harness.conversation(
    household.conversationId as ConversationId,
    deps.thread.context,
  );
  if (!conversation) throw new ThreadUnavailableError("the shared conversation is missing");
  await conversation.configure({ model: { provider: ref.provider, modelId: ref.modelId } }, deps.thread.context);
  sendJson(res, 200, {
    current: {
      ...ref,
      id: `${ref.provider}/${ref.modelId}`,
      paid: modelIsPaid(deps.models, ref),
      price: priceOf(deps.models, ref.provider, ref.modelId),
    },
    budget,
  });
}

// --- approvals (P4-07) -------------------------------------------------------

/**
 * The proposals and their derived state, newest first. Expiry is evaluated with
 * this process's clock, exactly as the confirming commit will, so a card that
 * says "expired" cannot be confirmed by a race.
 */
async function handleApprovalsRead(deps: HttpDeps, res: ServerResponse): Promise<void> {
  const now = new Date(deps.now?.() ?? Date.now());
  const approvals = await readApprovals(deps.thread.harness, deps.thread.context);
  sendJson(res, 200, { approvals: approvalViews(approvals, now) });
}

function approvalIdOf(record: Record<string, unknown>): string {
  return bodyIdOf(record, "decision");
}

/**
 * One answer for confirm and cancel (§7.4, §9.3). A stale revision is a terminal
 * 409 carrying the committed proposal; an expired, declined or already-confirmed
 * proposal is a 409 naming why nothing happened; a reused key is the one
 * key-conflict answer; success carries the decided proposal, so the caller never
 * merges a partial card.
 *
 * The decision committed already; retiring the reminder tasks the executed
 * action replaced is best-effort and must not turn a successful decision into an
 * error (the old tasks also no-op on their revision check).
 */
async function respondToDecision(deps: HttpDeps, res: ServerResponse, outcome: DecideOutcome): Promise<void> {
  const now = new Date(deps.now?.() ?? Date.now());
  if (outcome.kind === "key-conflict") {
    sendKeyConflict(res);
    return;
  }
  if (outcome.kind === "stale" || outcome.kind === "expired" || outcome.kind === "declined" || outcome.kind === "already-confirmed") {
    const messages = {
      stale: "the proposal changed since it was read",
      expired: "that proposal expired; nothing was executed",
      declined: "that proposal was declined; nothing was executed",
      "already-confirmed": "that proposal was already confirmed; the change is done",
    } as const;
    sendJson(res, 409, {
      error: outcome.kind === "already-confirmed" ? "already_confirmed" : outcome.kind,
      message: messages[outcome.kind],
      approval: approvalView(outcome.approval, now),
    });
    return;
  }
  if (outcome.kind === "target-changed") {
    // The commit rolled back, so the proposal is still pending: the caregiver can
    // decline it, and the agent can propose the change again.
    sendJson(res, 409, { error: "target_changed", message: outcome.message });
    return;
  }
  if (outcome.retiredTaskIds.length > 0) {
    const failed = await retireAppointmentReminders(deps.thread.harness, outcome.retiredTaskIds, deps.thread.context);
    if (failed.length > 0) {
      deps.logger.warn("could not abort replaced appointment reminders", { taskIds: failed });
    }
  }
  // A confirmed appointment action names its record; answering with the derived
  // view lets the caller open what the decision wrote without a second read. The
  // record may have moved since (a later edit), which is the view it should see.
  let appointment: AppointmentView | undefined;
  const appointmentId = outcome.approval.result?.appointmentId;
  if (appointmentId !== undefined) {
    const calendar = await readCalendar(deps.thread.harness, deps.thread.context);
    const found = calendar.appointments.find((entry) => entry.id === appointmentId);
    if (found !== undefined) appointment = appointmentView(found);
  }
  sendJson(res, 200, {
    approval: approvalView(outcome.approval, now),
    replayed: outcome.kind === "replayed",
    ...(appointment !== undefined ? { appointment } : {}),
  });
}

/**
 * Confirm or decline one proposal. The confirmation is a **caregiver's session**,
 * not a tool call (§9.3): the model can only propose, and this route is where a
 * human tap executes the stored action.
 */
async function handleApprovalDecision(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  decision: "confirm" | "cancel",
): Promise<void> {
  const key = requireCareMutation(deps, req, session);
  const record = appointmentBody(await readJsonBody(req), ["id", "rev"], "approval decision");
  const id = approvalIdOf(record);
  const rev = revisionOf(record);
  const now = new Date(deps.now?.() ?? Date.now());
  const input = {
    actor: careActor(session),
    actionId: `http:${key}`,
    id,
    rev,
    now,
  };
  const outcome =
    decision === "confirm"
      ? await confirmApproval(deps.thread.harness, deps.thread.context, input)
      : await cancelApproval(deps.thread.harness, deps.thread.context, input);
  await respondToDecision(deps, res, outcome);
}

async function snapshotOf(deps: HttpDeps): Promise<ThreadSnapshot> {
  if (deps.readSnapshot !== undefined) return deps.readSnapshot(deps.thread, deps.bus.seq);
  return readThreadSnapshot(deps.thread, deps.bus.seq);
}

/**
 * The newest entry id the attach snapshot shows. The snapshot's `seq` is sampled
 * before its durable read, so a commit whose broadcast drains after that sample
 * can be inside the snapshot *and* queued as a delta — the narrow duplicate the
 * P1-11 review found. Entry ids are the durable commit order itself, so this is
 * the strict half of the attach guard: any delta entry at or below this id is
 * already in the snapshot (PLAN §9.4).
 */
function snapshotEntryFloor(snapshot: ThreadSnapshot): number {
  let newest = 0;
  for (const entry of snapshot.entries) {
    if (entry.entryId > newest) newest = entry.entryId;
  }
  return newest;
}

/** The transcript entry a delta would append, when it carries one. */
function eventEntryId(event: AgentEvent): number | undefined {
  switch (event.type) {
    case "entry_appended":
    case "message_end":
      return event.entry.id;
    case "tool_execution_end":
      return event.entry?.id;
    default:
      return undefined;
  }
}

/** One SSE frame; `Notice` types are part of the wire contract with the PWA. */
function writeEvent(
  res: ServerResponse,
  type: "snapshot" | "batch" | "profile" | "reconnect" | "heartbeat",
  payload?: unknown,
): void {
  if (res.writableEnded) return;
  // A payload-bearing frame carries it; the rest only carry the frame type.
  const body =
    type === "snapshot" || type === "batch" || type === "profile"
      ? JSON.stringify(payload)
      : JSON.stringify({ type });
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
  // Set once the snapshot is read: a delta entry at or below this id is not
  // new — it was committed before the snapshot's page. Filtering is per-event,
  // not per-batch: id-less events (`message_start`, `usage`, …) always pass, and
  // an entry above the floor passes even when the transcript does not display
  // its kind. Anything at or below the floor is dropped, displayed or not.
  let coveredThrough = 0;
  // A batch remembers the counter value it was broadcast at. Reporting
  // `bus.seq` at delivery time instead would blur the counter across the
  // attach and hide a gap from a client that watches for one (§9.4).
  type QueueItem =
    | { type: "batch"; seq: number; events?: readonly AgentEvent[] }
    | { type: "profile"; profile: PuppyProfile }
    | { type: "reconnect" };
  const queue: QueueItem[] = [];

  const deliver = (item: QueueItem): void => {
    if (item.type === "batch") {
      if (item.events !== undefined && item.events.length > 0) {
        const fresh = item.events.filter((event) => {
          const id = eventEntryId(event);
          return id === undefined || id > coveredThrough;
        });
        // A covered commit keeps its counter but loses the entries the
        // snapshot already shows; with nothing left the frame is empty. The
        // seq stays continuous, so a client watching for a gap (§9.4) does not
        // mistake a deduplicated commit for lost state.
        writeEvent(res, "batch", { seq: item.seq, events: fresh });
        return;
      }
      writeEvent(res, "batch", { seq: item.seq, ...(item.events ? { events: item.events } : {}) });
      return;
    }
    if (item.type === "profile") {
      // The whole view, so a client never merges a partial update (P1-11).
      writeEvent(res, "profile", item.profile);
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
    // Committed care state (the puppy profile today). It is not a thread delta:
    // it never touches `seq`, so a long-poll client is not woken by it, and it
    // queues behind the initial snapshot like every other frame.
    state: (profile: PuppyProfile) => {
      if (!live) return;
      const item: QueueItem = { type: "profile", profile };
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
  coveredThrough = snapshotEntryFloor(initial);

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
    // would duplicate entries. A later batch is checked against the snapshot's
    // entry floor in `deliver()`: its broadcast may have drained after the
    // seq was sampled while its entry was already durable in the snapshot.
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
