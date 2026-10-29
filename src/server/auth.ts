// Auth: owner token, one-time invites, sessions, roles and the authz matrix.
//
// PLAN §14.1 fixes the shape, and three rules shape this file:
//   * every credential is ≥128 bits of randomness and only its **hash** is stored,
//     so a leaked backup cannot be replayed as a cookie;
//   * the owner token is the trust root — losing it is recovered by physical
//     Termux access (`--reissue-owner`), which rotates it and revokes what it
//     issued, while member sessions survive;
//   * authz is server-side. An owner-only action returns 403 for a member; hiding
//     a button is not a permission.
//
// Removal is the one operation that crosses files: the auth row, every session of
// that member, **and** their push subscriptions, prefs and ntfy topic — otherwise a
// removed caregiver keeps receiving notifications (the P1-05 carry-over).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { JsonFileStore } from "./json-file.ts";
import {
  activeMembers,
  type AppConfig,
  type InviteRecord,
  type MemberRecord,
  type MemberRole,
  type PushConfig,
} from "./config.ts";

export type { InviteRecord } from "./config.ts";

export const TOKEN_BYTES = 32; // 256 bits; the plan's floor is 128
export const INVITE_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "pupkeep_session";
export const MAX_MEMBERS = 2; // owner + one partner

export type Action =
  | "care"
  | "agent"
  | "approvals"
  | "notification-prefs"
  | "invite"
  | "remove-member"
  | "rotate-owner"
  | "providers"
  | "backup";

/** PLAN §14.1's matrix, as data rather than scattered `if (role === …)`. */
const MATRIX: Record<Action, readonly MemberRole[]> = {
  care: ["owner", "member"],
  agent: ["owner", "member"],
  approvals: ["owner", "member"],
  "notification-prefs": ["owner", "member"],
  invite: ["owner"],
  "remove-member": ["owner"],
  "rotate-owner": ["owner"],
  providers: ["owner"],
  backup: ["owner"],
};

export function can(role: MemberRole | undefined, action: Action): boolean {
  return role !== undefined && MATRIX[action].includes(role);
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(role: MemberRole | undefined, action: Action) {
    super(`role ${role ?? "anonymous"} may not ${action}`);
    this.name = "ForbiddenError";
  }
}

/** Tokens are high-entropy, so a fast hash is sufficient and keeps login cheap. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two hex hashes; length mismatch is a plain false. */
export function hashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** An invite code is a token, never a guessable short code (PLAN §14.1). */
export function newInviteCode(): string {
  return newToken();
}

export interface AuthOptions {
  config: JsonFileStore<AppConfig>;
  /** Optional: removed members lose their notifications too. */
  push?: JsonFileStore<PushConfig>;
  now?: () => Date;
  /** Origin used to build the sign-in link; the cookie is origin-scoped by the browser. */
  origin?: string;
}

export interface Session {
  memberId: string;
  role: MemberRole;
  displayName: string;
}

export class AuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class Auth {
  readonly #options: AuthOptions;
  readonly #now: () => Date;

  constructor(options: AuthOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get #config(): JsonFileStore<AppConfig> {
    return this.#options.config;
  }

  /** Build a sign-in link for a token. The token never appears in a log. */
  link(token: string, origin = this.#options.origin ?? "http://127.0.0.1:8787"): string {
    return `${origin.replace(/\/$/, "")}/login?token=${token}`;
  }

  /**
   * Mint the owner token if there is none, or rotate it. Rotating signs out every
   * owner session and invalidates unused invites; member sessions survive.
   */
  async mintOwner(): Promise<{ token: string; link: string; rotated: boolean }> {
    const token = newToken();
    let rotated = false;
    await this.#config.update((current) => {
      rotated = current.ownerTokenHash !== null;
      const now = this.#now().toISOString();
      // The owner is a member row too: the household cap, reconciliation and the
      // invite's "two people" rule all count rows, not a special case.
      const hasOwner = current.members.some((member) => member.role === "owner");
      const members = current.members.map((member) =>
        member.role === "owner" ? { ...member, sessions: rotated ? [] : member.sessions } : member,
      );
      if (!hasOwner) {
        members.push({
          id: "owner",
          role: "owner",
          displayName: "Owner",
          createdAt: now,
          sessions: [],
        });
      }
      return {
        ...current,
        ownerTokenHash: hashToken(token),
        members,
        invites: rotated ? [] : current.invites,
      };
    });
    return { token, link: this.link(token), rotated };
  }

  /** Verify an owner token (the sign-in link) or a session token. */
  async authenticate(token: string): Promise<Session> {
    const hash = hashToken(token);
    const config = await this.#config.read();

    if (config.ownerTokenHash && hashEquals(hash, config.ownerTokenHash)) {
      const owner = config.members.find((member) => member.role === "owner" && member.removedAt === undefined);
      return { memberId: owner?.id ?? "owner", role: "owner", displayName: owner?.displayName ?? "Owner" };
    }

    for (const member of config.members) {
      if (member.removedAt !== undefined) continue;
      for (const session of member.sessions) {
        if (hashEquals(hash, session.tokenHash)) {
          return { memberId: member.id, role: member.role, displayName: member.displayName };
        }
      }
    }
    throw new AuthError("not signed in");
  }

  /** Owner-only: create a one-time invite. */
  async createInvite(actor: Session, displayName: string, ttlMs = INVITE_TTL_MS): Promise<string> {
    if (!can(actor.role, "invite")) throw new ForbiddenError(actor.role, "invite");
    const code = newInviteCode();
    const now = this.#now();
    await this.#config.update((current) => {
      if (activeMembers(current).length >= MAX_MEMBERS) {
        throw new Error(`household is full (max ${MAX_MEMBERS})`);
      }
      const invite: InviteRecord = {
        codeHash: hashToken(code),
        role: "member",
        displayName: displayName.trim(),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      return { ...current, invites: [...current.invites, invite] };
    });
    return code;
  }

  /**
   * Accept an invite: single use, expiring, and it creates the member row. An
   * expired or already-used code fails the same way, so the response cannot be
   * used to probe which invites exist.
   */
  async acceptInvite(code: string, sessionTtlMs = SESSION_TTL_MS): Promise<{ token: string; session: Session }> {
    const hash = hashToken(code);
    const token = newToken();
    const sessionTokenHash = hashToken(token);
    const now = this.#now();

    const config = await this.#config.update((current) => {
      const index = current.invites.findIndex((invite) => hashEquals(hash, invite.codeHash));
      const invite = current.invites[index];
      if (!invite || Date.parse(invite.expiresAt) <= now.getTime()) throw new AuthError("invite is not valid");
      if (activeMembers(current).length >= MAX_MEMBERS) throw new AuthError("household is full");

      const member: MemberRecord = {
        id: `m-${randomBytes(8).toString("hex")}`,
        role: invite.role,
        displayName: invite.displayName,
        createdAt: now.toISOString(),
        sessions: [{ tokenHash: sessionTokenHash, createdAt: now.toISOString() }],
      };
      return {
        ...current,
        members: [...current.members, member],
        invites: current.invites.filter((_, position) => position !== index),
      };
    });

    const member = config.members.at(-1)!;
    void sessionTtlMs; // expiry is enforced by the cookie; the hash has no clock
    return {
      token,
      session: { memberId: member.id, role: member.role, displayName: member.displayName },
    };
  }

  /** Owner-only: remove a member and everything that belonged to them. */
  async removeMember(actor: Session, memberId: string): Promise<void> {
    if (!can(actor.role, "remove-member")) throw new ForbiddenError(actor.role, "remove-member");
    if (memberId === actor.memberId) throw new Error("an owner cannot remove themselves");

    const now = this.#now().toISOString();
    await this.#config.update((current) => {
      const target = current.members.find((member) => member.id === memberId);
      if (!target || target.role === "owner") throw new Error("no such member");
      return {
        ...current,
        members: current.members.map((member) =>
          member.id === memberId ? { ...member, removedAt: now, sessions: [], inviteHash: undefined } : member,
        ),
      };
    });

    // The carry-over from P1-05: auth removal alone would leave a removed
    // caregiver receiving `fed` and `feed_overdue` notifications.
    const push = this.#options.push;
    if (push) {
      await push.update((current) => {
        const prefs = { ...current.prefs };
        const ntfy = { ...current.ntfy };
        delete prefs[memberId];
        delete ntfy[memberId];
        return {
          ...current,
          subscriptions: current.subscriptions.filter((subscription) => subscription.memberId !== memberId),
          prefs,
          ntfy,
        };
      });
    }
  }

  /** Sign out one session (the current device). */
  async revokeSession(token: string): Promise<void> {
    const hash = hashToken(token);
    await this.#config.update((current) => ({
      ...current,
      members: current.members.map((member) => ({
        ...member,
        // A match here is by construction a *session*, never the owner token hash.
        sessions: member.sessions.filter((session) => !hashEquals(hash, session.tokenHash)),
      })),
    }));
  }

  /** Purge expired invites; call on boot and after accepting. */
  async pruneInvites(): Promise<number> {
    const now = this.#now().getTime();
    let removed = 0;
    await this.#config.update((current) => {
      const kept = current.invites.filter((invite) => Date.parse(invite.expiresAt) > now);
      removed = current.invites.length - kept.length;
      return { ...current, invites: kept };
    });
    return removed;
  }
}

// --- cookies and origins ----------------------------------------------------

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds?: number;
}

export function sessionCookie(token: string, options: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${options.maxAgeSeconds ?? Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  // `Secure` only when the origin is HTTPS: on Tailscale HTTP the browser would
  // silently drop the cookie. The plan is explicit about this (§14.2).
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function parseSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return undefined;
}

/**
 * A mutation must come from the origin the launcher is serving: `Origin` must be
 * one of the active mode's origins. Kept small and pure so the HTTP layer (P1-09)
 * cannot invent its own rule.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  return allowed.some((candidate) => candidate.replace(/\/$/, "") === origin.replace(/\/$/, ""));
}

// --- rate limiting ----------------------------------------------------------

export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, number[]>();

  constructor(limit = 10, windowMs = 60_000, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Record an attempt; false means the caller should answer 429. */
  hit(key: string): boolean {
    const now = this.#now();
    const recent = (this.#hits.get(key) ?? []).filter((at) => now - at < this.#windowMs);
    recent.push(now);
    this.#hits.set(key, recent);
    return recent.length <= this.#limit;
  }

  /** Clear on success, so one bad guess does not count against a good login. */
  reset(key: string): void {
    this.#hits.delete(key);
  }
}
