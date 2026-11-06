// Household onboarding helpers: what the invite card sends and shows
// (PLAN §13.1, §14.1, §16 P4-09). No Preact, so a Node test can pin them.

/**
 * The invite's lifetime, in minutes. Mirrors `INVITE_TTL_MS` in
 * `src/server/auth.ts`; the client cannot import that module (it is TypeScript
 * and server-only), so this copy exists to write the copy and nothing else —
 * the server is the authority on when a code stops working.
 */
export const INVITE_TTL_MINUTES = 15;

/** The invite route's body: one display name, 1–64 characters. */
export function inviteBody(name) {
  return { displayName: String(name ?? "").trim() };
}

/**
 * The minted link from the route's `{code, link}`. The card shows the link (the
 * thing the partner opens), never the code on its own.
 */
export function inviteLinkOf(body) {
  const link = body?.link;
  return typeof link === "string" && link !== "" ? link : null;
}
