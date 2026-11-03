// The browser modules under `web/`, exercised directly (no DOM, no build).
//
// These load as plain ES modules, and the store now reads its globals through
// `globalThis` with optional access, so a Node test can import them. The
// behaviours that live here, rather than in the server suite:
//   * a care-state frame is applied according to *what* changed — a profile edit
//     may touch the draft, a household change may not;
//   * a stream that reconnects re-reads the care state, because the thread's SSE
//     snapshot carries none;
//   * the setup gate: an unfinished household never lands on Today (P1-14), and
//     the idempotency key stays with the body it belongs to (P1-11's rule, now
//     shared with the wizard's form).

import assert from "node:assert/strict";
import { test } from "node:test";

const { Pup } = await import("../web/views/pup.js");
const { Today } = await import("../web/views/today.js");
const { Setup } = await import("../web/views/setup.js");
const { applyCareView, startLive } = await import("../web/live.js");
const { getState, setState } = await import("../web/store.js");
const { changedFields, draftOf, isNewer, pendingSave, wireOf } = await import("../web/profile-form.js");

function profileOf({
  rev = 1,
  members = [{ id: "owner", name: "Alex" }],
  today = "2026-10-29",
  name = "Biscuit",
  mealsRev = 1,
  slots = [{ id: "slot-a", label: "Breakfast", timeLocal: "07:00", active: true }],
  timezoneConfirmedAt = "2026-10-29T12:00:00.000Z",
} = {}) {
  return {
    rev,
    puppy: { name, birthday: "2026-08-08", breed: "Beagle", sex: "female", targetWeightKg: 12 },
    age: { days: 82, weeks: 11, label: "11 weeks old" },
    household: {
      name: "Our household",
      timezone: "Europe/Paris",
      timezoneConfirmedAt,
      rev: 0,
      members,
    },
    meals: { rev: mealsRev, slots },
    setup: { complete: true, missing: [] },
    today,
  };
}

/** A mounted-enough Pup: onStore only needs `state` and a working setState. */
function pupWith(profile) {
  const pup = new Pup({});
  pup.state = {
    profile,
    draft: { name: profile.puppy.name, birthday: profile.puppy.birthday, breed: "Poodle", sex: "", targetWeightKg: "" },
    dirty: true,
    busy: false,
    error: null,
    message: null,
    conflict: null,
    pending: null,
  };
  pup.setState = (patch) => Object.assign(pup.state, patch);
  return pup;
}

test("a household-only frame updates the roster and leaves the draft alone", () => {
  const pup = pupWith(profileOf());
  pup.onStore({
    profile: profileOf({ members: [{ id: "owner", name: "Alex" }, { id: "partner", name: "Sam" }] }),
  });

  assert.equal(pup.state.profile.household.members.length, 2, "the new caregiver appears");
  assert.equal(pup.state.draft.breed, "Poodle", "an in-progress edit is not reset");
  assert.equal(pup.state.dirty, true, "the form is still dirty");
  assert.equal(pup.state.conflict, null, "a roster change is not a conflict");
});

test("a household-local day rollover still refreshes the displayed age", () => {
  const pup = pupWith(profileOf({ today: "2026-10-29" }));
  pup.onStore({ profile: { ...profileOf({ today: "2026-10-30" }), age: { days: 83, weeks: 11, label: "11 weeks old" } } });
  assert.equal(pup.state.profile.today, "2026-10-30");
  assert.equal(pup.state.draft.breed, "Poodle", "the draft is still untouched");
});

test("a profile edit is a conflict while dirty and a replacement while clean", () => {
  const dirty = pupWith(profileOf());
  dirty.onStore({ profile: profileOf({ rev: 2, name: "Biscuit II" }) });
  assert.equal(dirty.state.profile.rev, 2);
  assert.equal(dirty.state.conflict, typeof dirty.state.conflict === "string" ? dirty.state.conflict : null);
  assert.ok(String(dirty.state.conflict).length > 0, "the caregiver is told");
  assert.equal(dirty.state.draft.name, "Biscuit", "their typing is kept");

  const clean = pupWith(profileOf());
  clean.state.dirty = false;
  clean.onStore({ profile: profileOf({ rev: 2, name: "Biscuit II" }) });
  assert.equal(clean.state.conflict, null);
  assert.equal(clean.state.draft.name, "Biscuit II", "an idle form takes the new values");
});

test("an older frame never moves the form backwards", () => {
  const pup = pupWith(profileOf({ rev: 3, name: "Latest" }));
  pup.onStore({ profile: profileOf({ rev: 2, name: "Older" }) });
  assert.equal(pup.state.profile.puppy.name, "Latest");
});

test("a reconnect re-reads the care state instead of trusting the thread snapshot", () => {
  const listeners = new Map();
  const source = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    close() {},
  };
  let refreshed = 0;
  const live = startLive({ createSource: () => source, refresh: () => void (refreshed += 1) });

  // `open` fires on the first connection and on every automatic reconnect.
  listeners.get("open")();
  assert.equal(refreshed, 1);
  listeners.get("open")();
  assert.equal(refreshed, 2, "every reconnect asks again");

  live.close();
});

test("a profile frame replaces the store's view whole", () => {
  const listeners = new Map();
  const source = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    close() {},
  };
  const live = startLive({ createSource: () => source, refresh: () => {} });
  const frame = profileOf({ rev: 7, name: "From a frame" });
  listeners.get("profile")({ data: JSON.stringify(frame) });
  assert.equal(getState().profile.rev, 7);
  assert.equal(getState().profile.puppy.name, "From a frame");
  live.close();
});

test("the setup gate sends an unfinished household to the wizard, and a finished one to Today", () => {
  const unfinished = { ...profileOf(), meals: { rev: 0, slots: [] }, setup: { complete: false, missing: ["meals"] } };
  setState({ profile: unfinished });
  const gated = Today();
  assert.equal(gated.type, Setup, "an unfinished household never lands on Today");

  const ready = {
    ...profileOf(),
    meals: { rev: 1, slots: [{ id: "slot-a", label: "Breakfast", timeLocal: "07:00", active: true }] },
    setup: { complete: true, missing: [] },
  };
  setState({ profile: ready });
  const today = Today();
  assert.notEqual(today.type, Setup, "a finished household sees Today");

  // No profile read yet: Today shows itself rather than flashing the wizard at
  // a household that set up months ago.
  setState({ profile: null });
  assert.notEqual(Today().type, Setup, "an unread profile is not an unfinished one");
});

test("the idempotency key is held with the body it belongs to", () => {
  const body = { rev: 0, timezone: "Europe/Paris" };
  const first = pendingSave(undefined, body);
  assert.equal(pendingSave(first, { ...body }).key, first.key, "a retry of the same body replays");

  const changedRev = pendingSave(first, { rev: 1, timezone: "Europe/Paris" });
  assert.notEqual(changedRev.key, first.key, "a different body is a different action");
  const changedZone = pendingSave(first, { rev: 0, timezone: "Europe/Lisbon" });
  assert.notEqual(changedZone.key, first.key);
});

test("the shared form helpers send only what changed", () => {
  const profile = profileOf({ name: "Biscuit" });
  const draft = draftOf(profile);
  assert.deepEqual(wireOf(draft), profile.puppy, "an untouched draft changes nothing");
  assert.deepEqual(changedFields(profile.puppy, draft), {});

  const edited = { ...draft, name: "  Biscuit II  ", breed: "" };
  assert.deepEqual(changedFields(profile.puppy, edited), { name: "Biscuit II", breed: null });
});

test("without EventSource the care state is still read once", async () => {
  let refreshed = 0;
  const live = startLive({ createSource: undefined, refresh: async () => void (refreshed += 1) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshed, 1, "the setup gate is not left waiting for a stream it cannot open");
  live.close();
});

test("a response read before a newer frame is not allowed to move the screen backwards", () => {
  const older = { rev: 1, household: { rev: 0 }, meals: { rev: 0 } };
  const newer = { rev: 1, household: { rev: 1 }, meals: { rev: 1 } };
  assert.equal(isNewer(newer, older), true);
  assert.equal(isNewer(older, newer), false, "the frame that landed later wins");
  assert.equal(isNewer(older, null), true, "the first view is always adopted");
});

test("a racing reconnect read never moves the care state backwards", () => {
  // Two reads of the same endpoint land in arrival order, not freshness order:
  // the older one must be dropped, or the partner's finished setup would flip
  // back to the wizard.
  setState({ profile: null });
  const newer = { ...profileOf({ rev: 3, mealsRev: 2 }), setup: { complete: true, missing: [] } };
  const older = { ...profileOf({ rev: 1, mealsRev: 0 }), setup: { complete: false, missing: ["meals"] } };

  assert.equal(applyCareView(newer), true);
  assert.equal(applyCareView(older), false, "the newer view stays");
  assert.equal(getState().profile.rev, 3);
  assert.equal(getState().profile.setup.complete, true);
  assert.equal(applyCareView(newer), true, "an equal-or-newer view is still applied");
});

test("a frame for the caregiver's own in-flight save does not accuse someone else", () => {
  const before = profileOf({ rev: 1, name: "" });
  function wizard(pending) {
    const setup = new Setup({});
    setup.state = {
      profile: before,
      zone: before.household.timezone,
      zoneDirty: false,
      puppy: { name: "Biscuit", birthday: "", breed: "", sex: "", targetWeightKg: "" },
      puppyDirty: true,
      slots: [],
      slotsDirty: false,
      busy: "puppy",
      error: null,
      message: null,
      conflict: null,
      pending,
    };
    setup.setState = (patch) => Object.assign(setup.state, patch);
    return setup;
  }

  // The commit's own frame usually beats the save response: same body, not a
  // conflict. A real concurrent edit still answers 409 `stale`.
  const mine = wizard({ puppy: { key: "k", signature: "s" } });
  mine.onStore({ profile: profileOf({ rev: 2, name: "Biscuit" }) });
  assert.equal(mine.state.conflict, null);
  assert.equal(mine.state.puppy.name, "Biscuit", "the draft is kept while the save is in flight");

  const theirs = wizard({});
  theirs.onStore({ profile: profileOf({ rev: 2, name: "Other pup" }) });
  assert.match(String(theirs.state.conflict), /Someone else changed this/);
  assert.equal(theirs.state.puppy.name, "Biscuit", "their typing is not replaced");
});
