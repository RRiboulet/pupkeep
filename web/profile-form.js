// The puppy form's pure helpers, shared by the Pup screen (P1-11) and the
// first-run wizard (P1-14).
//
// Two screens now collect the same five profile fields, and one of them was the
// subject of P1-11's review fix — the idempotency key must be held with the body
// it belongs to, and "only what changed" decides what a save sends. Copying that
// logic into a second view would let the two drift, so the value-shaping half
// lives here and both views call it.
//
// These are pure functions over plain objects: no Preact, no fetch, no DOM, so a
// Node test can pin them without a browser.

import { newIdempotencyKey } from "./client.js";

/**
 * The idempotency key for the next attempt at `body`. It is held with the body
 * it belongs to: a retry of the *same* body reuses the key, which is what turns
 * "the response was lost" into a replay instead of a 409 against the
 * caregiver's own edit. A changed body is a different action and gets a fresh
 * key (P1-11's review finding, now shared by the wizard).
 */
export function pendingSave(pending, body) {
  const signature = JSON.stringify(body);
  if (pending && pending.signature === signature) return pending;
  return { key: newIdempotencyKey(), signature };
}

/** The three document revisions one care view carries, in a stable order. */
function revisionsOf(view) {
  return [view?.rev ?? 0, view?.household?.rev ?? 0, view?.meals?.rev ?? 0];
}

/**
 * Whether `next` is at least as new as `current`. The care view carries three
 * revisions (puppy, household, meals), and a reply read before a commit that
 * another path already delivered — a reconnect's `GET` racing the stream, a
 * save response racing a frame — must not move the screen (or the shell's setup
 * gate) backwards.
 */
export function isNewer(next, current) {
  if (!current) return true;
  const incoming = revisionsOf(next);
  const held = revisionsOf(current);
  return incoming.every((rev, index) => rev >= (held[index] ?? 0));
}

/**
 * The household facts a form displays. A change here is not a profile edit: it
 * replaces what the screen shows (a partner joined, the timezone was confirmed)
 * and must not touch an in-progress draft.
 */
export function sameHousehold(a, b) {
  return (
    a.today === b.today &&
    a.household.timezone === b.household.timezone &&
    a.household.timezoneConfirmedAt === b.household.timezoneConfirmedAt &&
    a.household.name === b.household.name &&
    a.household.members.length === b.household.members.length &&
    a.household.members.every((member, index) => {
      const other = b.household.members[index];
      return other !== undefined && other.id === member.id && other.name === member.name;
    })
  );
}

export function emptyDraft() {
  return { name: "", birthday: "", breed: "", sex: "", targetWeightKg: "" };
}

export function draftOf(profile) {
  const puppy = profile.puppy;
  return {
    name: puppy.name,
    birthday: puppy.birthday ?? "",
    breed: puppy.breed ?? "",
    sex: puppy.sex ?? "",
    targetWeightKg: puppy.targetWeightKg === null ? "" : String(puppy.targetWeightKg),
  };
}

/** The draft as wire values: empty inputs are `null` (a clear). */
export function wireOf(draft) {
  return {
    name: draft.name.trim(),
    birthday: draft.birthday === "" ? null : draft.birthday,
    breed: draft.breed.trim() === "" ? null : draft.breed.trim(),
    sex: draft.sex === "" ? null : draft.sex,
    targetWeightKg: draft.targetWeightKg === "" ? null : Number(draft.targetWeightKg),
  };
}

/**
 * Only the fields that really changed. Saving the whole form unchanged would
 * otherwise bump the revision and put "updated the profile" in the household's
 * activity feed for a button press that changed nothing.
 */
export function changedFields(puppy, draft) {
  const changed = {};
  for (const [key, value] of Object.entries(wireOf(draft))) {
    if (puppy[key] !== value) changed[key] = value;
  }
  return changed;
}
