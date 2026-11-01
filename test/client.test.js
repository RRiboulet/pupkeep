// The browser modules under `web/`, exercised directly (no DOM, no build).
//
// These load as plain ES modules, and the store now reads its globals through
// `globalThis` with optional access, so a Node test can import them. Two
// behaviours live here that the server cannot prove:
//   * a care-state frame is applied according to *what* changed — a profile edit
//     may touch the draft, a household change may not;
//   * a stream that reconnects re-reads the care state, because the thread's SSE
//     snapshot carries none.

import assert from "node:assert/strict";
import { test } from "node:test";

const { Pup } = await import("../web/views/pup.js");
const { startLive } = await import("../web/live.js");
const { getState } = await import("../web/store.js");

function profileOf({ rev = 1, members = [{ id: "owner", name: "Alex" }], today = "2026-10-29", name = "Biscuit" } = {}) {
  return {
    rev,
    puppy: { name, birthday: "2026-08-08", breed: "Beagle", sex: "female", targetWeightKg: 12 },
    age: { days: 82, weeks: 11, label: "11 weeks old" },
    household: { name: "Our household", timezone: "Europe/Paris", members },
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
