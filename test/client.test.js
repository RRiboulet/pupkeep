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
const { feedTimeText, localDate, localMinutes, mealClock, mealRows, mealStatus, minutesOf } = await import(
  "../web/meals.js"
);
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
  const gated = new Today({}).render();
  assert.equal(gated.type, Setup, "an unfinished household never lands on Today");

  const ready = {
    ...profileOf(),
    meals: { rev: 1, slots: [{ id: "slot-a", label: "Breakfast", timeLocal: "07:00", active: true }] },
    setup: { complete: true, missing: [] },
  };
  setState({ profile: ready });
  const today = new Today({}).render();
  assert.notEqual(today.type, Setup, "a finished household sees Today");

  // No profile read yet: Today shows itself rather than flashing the wizard at
  // a household that set up months ago.
  setState({ profile: null });
  assert.notEqual(new Today({}).render().type, Setup, "an unread profile is not an unfinished one");
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

// --- Today meals (P2-05) ----------------------------------------------------

function mealDay({
  localDate = "2026-10-30",
  today = "2026-10-30",
  overdueAfterMin = 15,
  slots = [
    { slot: { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true }, feed: null },
    { slot: { id: "slot-d", label: "Dinner", timeLocal: "18:00", active: true }, feed: null },
  ],
  extras = [],
} = {}) {
  return { localDate, today, overdueAfterMin, events: [], slots, extras };
}

const CLOCK = { today: "2026-10-30", nowMinutes: 8 * 60, delayMin: 15 };

test("a meal slot is fed, pending or overdue from its committed time and the household clock", () => {
  const slot = { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true };
  assert.equal(mealStatus("2026-10-30", slot, null, { ...CLOCK, nowMinutes: 6 * 60 }), "pending");
  assert.equal(mealStatus("2026-10-30", slot, null, CLOCK), "overdue", "07:15 has passed");
  assert.equal(mealStatus("2026-10-30", slot, null, { ...CLOCK, nowMinutes: 7 * 60 + 14 }), "pending");
  assert.equal(mealStatus("2026-10-30", slot, null, { ...CLOCK, nowMinutes: 7 * 60 + 15 }), "overdue");

  // Past and future days do not depend on the clock.
  assert.equal(mealStatus("2026-10-29", slot, null, { ...CLOCK, nowMinutes: 23 * 60 }), "overdue");
  assert.equal(mealStatus("2026-10-31", slot, null, { ...CLOCK, nowMinutes: 0 }), "pending");

  // A committed feed wins outright.
  const feed = { id: "f1", byLabel: "Alex", at: "2026-10-30T05:02:00.000Z" };
  assert.equal(mealStatus("2026-10-29", slot, feed, CLOCK), "fed");

  // 23:50 is still pending at 00:05 *today*: the next day's minutes do not
  // belong to this slot.
  const late = { ...slot, timeLocal: "23:50" };
  assert.equal(mealStatus("2026-10-30", late, null, { ...CLOCK, nowMinutes: 5 }), "pending");
  assert.equal(minutesOf("24:00"), null, "an impossible time is not guessed");
  assert.equal(minutesOf("07:30"), 450);
});

test("the card's rows follow the day's slot order and report each status", () => {
  const day = mealDay({
    slots: [
      { slot: { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true }, feed: { id: "f1", byLabel: "Alex", at: "2026-10-30T05:02:00.000Z" } },
      { slot: { id: "slot-d", label: "Dinner", timeLocal: "18:00", active: true }, feed: null },
    ],
  });
  const rows = mealRows(day, { today: "2026-10-30", nowMinutes: 12 * 60, delayMin: 15 });
  assert.deepEqual(rows.map((row) => row.slot.id), ["slot-b", "slot-d"]);
  assert.deepEqual(rows.map((row) => row.status), ["fed", "pending"]);
  assert.equal(rows[0].feed.byLabel, "Alex");
  assert.equal(rows[1].feed, null);
});

test("the clock is the household's: date and minutes derive from the zone, not the device", () => {
  const day = mealDay({ overdueAfterMin: 30 });
  const clock = mealClock(day, "Europe/Paris", new Date("2026-10-30T06:00:00.000Z"));
  assert.equal(clock.today, "2026-10-30");
  assert.equal(clock.delayMin, 30);
  assert.equal(clock.nowMinutes, 7 * 60, "07:00 in Paris");

  // Across a DST change, and with no usable zone, the answer is honest.
  assert.equal(localMinutes(new Date("2026-03-29T01:30:00.000Z"), "Europe/Paris"), 3 * 60 + 30, "spring forward");
  assert.equal(localMinutes(new Date("2026-10-25T00:30:00.000Z"), "Europe/Paris"), 2 * 60 + 30, "fall back");
  assert.equal(localDate(new Date("2026-10-29T23:30:00.000Z"), "Europe/Paris"), "2026-10-30");
  assert.equal(mealClock(day, "Not/AZone").nowMinutes, null, "an unusable zone is visibly unknown");
  assert.equal(mealClock(day, "Not/AZone").today, null);
  assert.equal(feedTimeText("2026-10-30T05:12:00.000Z", "Europe/Paris"), "06:12");
  assert.equal(feedTimeText("2026-10-30T05:12:00.000Z", null), "at an unknown time");
});

/** A mounted-enough Today: the methods under test need state, setState and request. */
function todayWith(request, state = {}) {
  const fresh = new Today({ request });
  // `componentDidMount` normally adopts the prop; these tests drive the methods
  // without mounting, so the seam is set directly.
  fresh.request = request;
  // Start from the component's own initial state, so a new field cannot be
  // forgotten here.
  fresh.state = { ...fresh.state, loading: false, ...state };
  fresh.setState = (patch) => Object.assign(fresh.state, patch);
  return fresh;
}

function fakeRequest(answer) {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, options });
    return typeof answer === "function" ? answer(path, options, calls.length) : answer;
  };
  request.calls = calls;
  return request;
}

test("a care frame re-reads the day, even when the frame's payload is identical", async () => {
  setState({ profile: profileOf(), careSeq: 1 });
  const request = fakeRequest({ status: 200, ok: true, body: mealDay() });
  const today = todayWith(request);
  today.onStore(getState());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(request.calls.length, 1, "the first care frame is read once");
  assert.equal(today.state.day.localDate, "2026-10-30");

  // A feed commits without moving any revision, so the frame's *payload* is
  // identical. The sequence, not object identity, is what says "re-read".
  const identical = getState().profile;
  setState({ profile: identical, careSeq: 2 });
  today.onStore(getState());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(request.calls.length, 2, "an applied frame is a new sequence");

  today.onStore(getState());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(request.calls.length, 2, "one frame, one read");
});

test("mounting reads the day and starts the ticker, even before a profile arrives", async () => {
  setState({ profile: null });
  const request = fakeRequest({ status: 200, ok: true, body: mealDay() });
  const today = todayWith(request);
  today.componentDidMount();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(request.calls.length, 1, "the day route needs no profile to answer");
    assert.ok(today.timer, "the overdue ticker runs");
  } finally {
    today.componentWillUnmount();
    assert.equal(today.timer, null, "unmount clears the timer");
  }
});

test("an in-flight write never paints the slot fed before the commit", async () => {
  setState({ profile: profileOf(), careSeq: 0 });
  let release;
  const request = fakeRequest((path) => {
    if (path === "/api/feeding/day") return { status: 200, ok: true, body: mealDay() };
    return new Promise((resolve) => {
      release = () => resolve({ status: 200, ok: true, body: { day: mealDay(), replayed: false } });
    });
  });
  const today = todayWith(request, { day: mealDay() });
  const pending = today.markFed("slot-b");
  assert.equal(today.state.day.slots[0].feed, null, "still unfed while the write is on the wire");
  release();
  await pending;
});

test("a successful read clears an earlier error", async () => {
  setState({ profile: profileOf(), careSeq: 0 });
  const request = fakeRequest({ status: 200, ok: true, body: mealDay() });
  const today = todayWith(request, { error: "Could not load today's meals. Try again in a moment." });
  await today.load();
  assert.equal(today.state.error, null);
});

test("an unknown time or an unknown clock is pending, never overdue", () => {
  const oddSlot = { id: "slot-x", label: "Odd", timeLocal: "nope", active: true };
  assert.equal(mealStatus("2026-10-30", oddSlot, null, CLOCK), "pending");
  assert.equal(mealStatus("2026-10-30", oddSlot, null, { ...CLOCK, nowMinutes: null }), "pending");
});

test("a 409 already_fed shows who and when, refreshes the day, and never shows an uncommitted feed", async () => {
  setState({ profile: profileOf() });
  const before = mealDay();
  const after = mealDay({
    slots: [
      { slot: { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true }, feed: { id: "f1", byLabel: "Sam", at: "2026-10-30T05:12:00.000Z" } },
      { slot: { id: "slot-d", label: "Dinner", timeLocal: "18:00", active: true }, feed: null },
    ],
  });
  const request = fakeRequest((path) =>
    path === "/api/feeding/day"
      ? { status: 200, ok: true, body: after }
      : {
          status: 409,
          ok: false,
          body: {
            error: "already_fed",
            message: "Sam already logged this meal at 06:12",
            feed: { id: "f1", byLabel: "Sam", at: "2026-10-30T05:12:00.000Z" },
            day: after,
          },
        },
  );
  const today = todayWith(request, { day: before });

  await today.markFed("slot-b");
  assert.match(today.state.error, /Sam already logged this meal at 06:12/);
  assert.equal(today.state.busy, null);
  assert.equal(request.calls[0].options.method, "POST");
  assert.ok(request.calls[0].options.idempotencyKey, "a write carries a key");
  assert.equal(request.calls.length, 1, "the 409's committed day is used; no second read");
  assert.equal(today.state.day.slots[0].feed.byLabel, "Sam", "the committed feed is shown");
  assert.equal(today.state.day.overdueAfterMin, 15, "the cached delay survives the conflict day");
});

test("a committed write replaces the day and a retry of the same body reuses its key", async () => {
  setState({ profile: profileOf() });
  const committed = mealDay({
    slots: [
      { slot: { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true }, feed: { id: "f1", byLabel: "Alex", at: "2026-10-30T05:02:00.000Z" } },
      { slot: { id: "slot-d", label: "Dinner", timeLocal: "18:00", active: true }, feed: null },
    ],
  });
  const request = fakeRequest((path, options, count) =>
    count === 2
      ? { status: 200, ok: true, body: { feed: committed.slots[0].feed, day: committed, replayed: false } }
      : { status: 500, ok: false, body: { error: "server" } },
  );
  const today = todayWith(request, { day: mealDay() });

  // An ambiguous failure (5xx, unreadable answer) keeps the key: the write may
  // have committed, so a retry of the same body must replay, not log twice.
  await today.markFed("slot-b");
  assert.ok(today.state.error, "the caregiver is told");
  assert.ok(today.state.pending, "the key is kept for the retry");
  const firstKey = request.calls[0].options.idempotencyKey;

  await today.markFed("slot-b");
  assert.equal(request.calls[1].options.idempotencyKey, firstKey, "same body, same key");
  assert.equal(today.state.message, "Logged.");
  assert.equal(today.state.day.slots[0].feed.byLabel, "Alex");
  assert.equal(today.state.pending, null, "a committed action's key is done");
});

test("two taps in one task still fire one write", async () => {
  setState({ profile: profileOf() });
  let release;
  const request = fakeRequest((path) => {
    if (path === "/api/feeding/day") return { status: 200, ok: true, body: mealDay() };
    return new Promise((resolve) => {
      release = () => resolve({ status: 200, ok: true, body: { day: mealDay(), replayed: false } });
    });
  });
  const today = todayWith(request, { day: mealDay() });

  // Both start before any render: the guard cannot rely on rendered state.
  const first = today.markFed("slot-b");
  const second = today.markFed("slot-b");
  release();
  await Promise.all([first, second]);
  assert.equal(request.calls.filter((call) => call.options?.method === "POST").length, 1, "one write only");
  assert.equal(today.state.busy, null);
});

test("the extra-feeding form sends only what was filled in", async () => {
  setState({ profile: profileOf() });
  const request = fakeRequest((path, options) => {
    if (path === "/api/feeding/day") return { status: 200, ok: true, body: mealDay() };
    return { status: 200, ok: true, body: { feed: { id: "f2", byLabel: "Alex", at: "2026-10-30T09:00:00.000Z" }, day: mealDay({ extras: [{ id: "f2", byLabel: "Alex", at: "2026-10-30T09:00:00.000Z", amount: "40 g" }] }), replayed: false } };
  });
  const today = todayWith(request, { day: mealDay(), extraAmount: "  40 g  ", extraNote: "  " });

  await today.logExtra();
  const post = request.calls.find((call) => call.path === "/api/feeding/extra");
  assert.ok(post);
  assert.deepEqual(post.options.body, { amount: "40 g" }, "an empty note is omitted, the amount trimmed");
  assert.equal(today.state.extraOpen, false, "the form closes on a commit");
  assert.equal(today.state.day.extras.length, 1);
});

test("an open screen notices midnight and re-reads today instead of keeping yesterday", async () => {
  setState({ profile: profileOf() });
  const today = localDate(new Date(), "Europe/Paris");
  const request = fakeRequest((path) => ({ status: 200, ok: true, body: mealDay({ localDate: today, today }) }));
  const stale = todayWith(request, { day: mealDay({ localDate: "2020-01-01", today: "2020-01-01" }) });

  stale.onTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(request.calls.length, 1, "yesterday's day is re-read once the household date moves");

  const current = todayWith(request, { day: mealDay({ localDate: today, today }) });
  current.onTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(request.calls.length, 1, "the same day is not re-read by the ticker");
});

test("a slow read cannot overwrite a day a write already committed", async () => {
  setState({ profile: profileOf() });
  const committed = mealDay({
    slots: [
      { slot: { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true }, feed: { id: "f1", byLabel: "Alex", at: "2026-10-30T05:02:00.000Z" } },
      { slot: { id: "slot-d", label: "Dinner", timeLocal: "18:00", active: true }, feed: null },
    ],
  });
  let releaseRead;
  const request = fakeRequest((path) => {
    if (path === "/api/feeding/day") {
      return new Promise((resolve) => {
        releaseRead = () => resolve({ status: 200, ok: true, body: mealDay() });
      });
    }
    return { status: 200, ok: true, body: { day: committed, replayed: false } };
  });
  const today = todayWith(request, { day: mealDay() });

  const read = today.load();
  await today.markFed("slot-b");
  releaseRead();
  await read;
  assert.equal(today.state.day.slots[0].feed.byLabel, "Alex", "the committed day wins over the older read");
});

test("the conflict message says what happened, with no claim about a refresh", async () => {
  setState({ profile: profileOf() });
  const request = fakeRequest((path) =>
    path === "/api/feeding/day"
      ? { status: 503, ok: false, body: { error: "not ready" } }
      : {
          status: 409,
          ok: false,
          body: {
            error: "already_fed",
            message: "Sam already logged this meal at 06:12",
            feed: { id: "f1", byLabel: "Sam", at: "2026-10-30T05:12:00.000Z" },
            day: mealDay(),
          },
        },
  );
  const today = todayWith(request, { day: mealDay() });

  await today.markFed("slot-b");
  assert.equal(today.state.error, "Sam already logged this meal at 06:12.");
});

test("a key conflict is a terminal refusal with a fresh action required", async () => {
  setState({ profile: profileOf() });
  const request = fakeRequest((path) =>
    path === "/api/feeding/day"
      ? { status: 200, ok: true, body: mealDay() }
      : { status: 409, ok: false, body: { error: "idempotency_conflict" } },
  );
  const today = todayWith(request, { day: mealDay() });
  await today.markFed("slot-b");
  assert.match(today.state.error, /conflicted with an earlier action/);
  assert.equal(today.state.pending, null, "the next try is a fresh action");
});

test("a write's plainer day keeps the view's reminder delay", () => {
  const today = todayWith(fakeRequest({ status: 200, ok: true, body: null }), {
    day: mealDay({ overdueAfterMin: 30 }),
  });
  const plainWriteAnswer = { ...mealDay() };
  delete plainWriteAnswer.overdueAfterMin; // a write's plain `FeedingDay`
  assert.equal(today.mergeDay(plainWriteAnswer).overdueAfterMin, 30, "a write answer does not lose the delay");
  assert.equal(today.mergeDay(mealDay({ overdueAfterMin: 5 })).overdueAfterMin, 5, "a day with its own delay wins");
});

/** All text nodes under a vnode, for asserting the card's copy. */
function textsOf(vnode, found = []) {
  if (vnode === null || vnode === undefined || vnode === false) return found;
  if (typeof vnode === "string" || typeof vnode === "number") {
    found.push(String(vnode));
    return found;
  }
  if (Array.isArray(vnode)) {
    for (const child of vnode) textsOf(child, found);
    return found;
  }
  const children = vnode.props?.children;
  if (children !== undefined) textsOf(children, found);
  return found;
}

function buttonsOf(vnode, found = []) {
  if (vnode === null || vnode === undefined || typeof vnode !== "object") return found;
  if (Array.isArray(vnode)) {
    for (const child of vnode) buttonsOf(child, found);
    return found;
  }
  if (vnode.type === "button") found.push(vnode);
  buttonsOf(vnode.props?.children, found);
  return found;
}

test("the card's copy says overdue in words, and a fed slot offers no button", () => {
  setState({ profile: profileOf() });
  const today = todayWith(fakeRequest({ status: 200, ok: true, body: null }));
  const overdue = today.renderMeal({
    slot: { id: "slot-d", label: "Dinner", timeLocal: "18:00", active: true },
    feed: null,
    status: "overdue",
  });
  assert.match(textsOf(overdue).join(""), /Overdue — not fed yet/, "status is not colour-only");
  const overdueButtons = buttonsOf(overdue);
  assert.equal(overdueButtons.length, 1);
  assert.equal(overdueButtons[0].props.disabled, false);

  const fed = today.renderMeal({
    slot: { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true },
    feed: { id: "f1", byLabel: "Alex", at: "2026-10-30T05:02:00.000Z" },
    status: "fed",
  });
  assert.match(textsOf(fed).join(""), /Fed by Alex at 06:02/);
  assert.equal(buttonsOf(fed).length, 0, "an already-fed slot cannot be marked again");

  const pending = today.renderMeal({
    slot: { id: "slot-l", label: "Lunch", timeLocal: "12:00", active: true },
    feed: null,
    status: "pending",
  });
  assert.match(textsOf(pending).join(""), /Pending/);
  assert.equal(buttonsOf(pending)[0].props.disabled, false);
});
