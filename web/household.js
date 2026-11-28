// Household onboarding helpers: what the invite card sends and shows
// (PLAN §13.1, §14.1, §16 P4-09), plus the two household sentences that used
// to be glued together by htm. No Preact, so a Node test can pin them.

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

/**
 * The wizard's timezone hint, as one string. It used to be a text run ending
 * in `Boot captured` followed by `${zone}; please check it.` on the next
 * line; htm drops that newline's whitespace and the card read
 * "Boot capturedEurope/Paris". Composing it here makes the space part of the
 * text and lets `test/household-copy.test.js` pin it.
 */
export function bootZoneHint(timezone) {
  return (
    "Every date in Pupkeep — meals, walks, growth — is worked out in this zone. " +
    `Boot captured ${timezone}; please check it.`
  );
}

/**
 * The Settings lead's ` · zone · caregivers` tail, as one string, for the same
 * reason: the old template put each separator on its own line and rendered
 * `· Europe/Paris ·Owner`.
 *
 * The leading space is part of the string, not of the template. The template
 * renders `<p class="lead">${household.name}<span class="lead__meta">${…}
 * </span></p>`, and htm drops the whitespace between the name expression and the
 * span, so the name used to touch the first `·` ("Our household· Europe/Paris").
 * `web/views/pup.js` puts the same space inside its meta span; a space that is
 * inside the composed text survives htm and is what the test pins.
 */
export function householdLeadMetaText(timezone, caregiverNames) {
  const caregivers = caregiverNames.join(" and ");
  return caregivers ? ` · ${timezone} · ${caregivers}` : ` · ${timezone}`;
}
