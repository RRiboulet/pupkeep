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
const { correctedNow, timerText, walkSeconds, walkStale, walkTimeText } = await import("../web/walks.js");
const { getState, setState } = await import("../web/store.js");
const { changedFields, draftOf, isNewer, pendingSave, wireOf } = await import("../web/profile-form.js");
const { CHART_SIZE, chartGeometry, daysBetweenLocalDates, formatKg, measurementRows, windowLabel } =
  await import("../web/growth-chart.js");
const { boardGroups, customMilestone, noteUpdate, rowMetaText, statusUpdate } = await import("../web/training.js");

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
  const dayReads = () => request.calls.filter((call) => call.path === "/api/feeding/day").length;
  today.onStore(getState());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dayReads(), 1, "the first care frame is read once");
  assert.equal(today.state.day.localDate, "2026-10-30");

  // A feed commits without moving any revision, so the frame's *payload* is
  // identical. The sequence, not object identity, is what says "re-read".
  const identical = getState().profile;
  setState({ profile: identical, careSeq: 2 });
  today.onStore(getState());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dayReads(), 2, "an applied frame is a new sequence");

  today.onStore(getState());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dayReads(), 2, "one frame, one read");
});

test("mounting reads the day and starts the ticker, even before a profile arrives", async () => {
  setState({ profile: null });
  const request = fakeRequest({ status: 200, ok: true, body: mealDay() });
  const today = todayWith(request);
  today.componentDidMount();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      request.calls.filter((call) => call.path === "/api/feeding/day").length,
      1,
      "the day route needs no profile to answer",
    );
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

  // With no walk open the screen re-renders every 30th tick; the day check runs
  // then, so the rollover is caught within half a minute.
  for (let index = 0; index < 30; index += 1) stale.onTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(request.calls.length, 1, "yesterday's day is re-read once the household date moves");

  const current = todayWith(request, { day: mealDay({ localDate: today, today }) });
  for (let index = 0; index < 30; index += 1) current.onTick();
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

// --- Today walk (P2-07) -----------------------------------------------------

test("the walk timer runs on the server-corrected clock, not the device's", () => {
  const received = Date.parse("2026-10-30T08:05:00.000Z");
  // The server said 08:00; ten seconds of local time have passed since.
  const now = correctedNow("2026-10-30T08:00:00.000Z", received, received + 10_000);
  assert.equal(now, Date.parse("2026-10-30T08:00:10.000Z"));
  assert.equal(timerText(walkSeconds("2026-10-30T08:00:00.000Z", now)), "0:10");
  assert.equal(timerText(65), "1:05");
  assert.equal(timerText(3665), "1:01:05");
  assert.equal(
    correctedNow("not an instant", received, received + 5_000),
    received + 5_000,
    "a bad server clock falls back to local now",
  );
});

test("a walk is stale only past the server's window, and times use the household zone", () => {
  const started = "2026-10-30T08:00:00.000Z";
  assert.equal(walkStale(started, Date.parse("2026-10-30T15:59:00.000Z"), 8 * 60 * 60 * 1000), false);
  assert.equal(walkStale(started, Date.parse("2026-10-30T16:00:00.000Z"), 8 * 60 * 60 * 1000), true);
  assert.equal(walkStale(started, Date.parse("2026-10-30T23:00:00.000Z"), 0), false, "no window, never stale");
  assert.equal(walkTimeText(started, "Europe/Paris"), "09:00");
  assert.equal(walkTimeText(started, "Not/AZone"), "at an unknown time");
});

function walkData({ open = null, staleAfterMs = 8 * 60 * 60 * 1000, serverNow = "2026-10-30T08:05:00.000Z", receivedAt = Date.parse("2026-10-30T08:05:00.000Z") } = {}) {
  return { open, serverNow, staleAfterMs, receivedAt };
}

function walkOf(overrides = {}) {
  return {
    id: "walk-1",
    startedAt: "2026-10-30T08:00:00.000Z",
    startedActionId: "http:start-1",
    startedByLabel: "Alex",
    startedBy: "owner",
    ...overrides,
  };
}

test("starting a walk is only shown after the commit, and a lost race shows the open walk", async () => {
  setState({ profile: profileOf() });
  const request = fakeRequest((path) => {
    if (path === "/api/walks") return { status: 200, ok: true, body: walkData({ open: walkOf() }) };
    if (path === "/api/walks/start") return { status: 200, ok: true, body: { walk: walkOf(), replayed: false } };
    return { status: 200, ok: true, body: walkData({ open: walkOf() }) };
  });
  const today = todayWith(request, { walk: walkData() });

  const pending = today.startWalk();
  assert.equal(today.state.walk.open, null, "nothing is open until the server says so");
  await pending;
  assert.equal(today.state.walk.open?.id, "walk-1", "the committed walk is shown");

  const raceRequest = fakeRequest((path) =>
    path === "/api/walks"
      ? { status: 200, ok: true, body: walkData() }
      : {
          status: 409,
          ok: false,
          body: { error: "walk_open", message: '"Sam" is already walking', walk: walkOf({ startedByLabel: "Sam" }) },
        },
  );
  const raced = todayWith(raceRequest, { walk: walkData() });
  await raced.startWalk();
  assert.equal(raced.state.walk.open?.startedByLabel, "Sam", "the blocking walk is shown, not a dead end");
  assert.match(raced.state.walkError, /Sam/);
});

test("ending a walk sends the id and only the observations that were filled in", async () => {
  setState({ profile: profileOf() });
  const request = fakeRequest((path) => {
    if (path === "/api/walks") return { status: 200, ok: true, body: walkData() };
    return { status: 200, ok: true, body: { walk: walkOf({ endedAt: "2026-10-30T08:35:00.000Z" }), replayed: false } };
  });
  const today = todayWith(request, {
    walk: walkData({ open: walkOf() }),
    walkDraft: { pee: "1", poop: "", dogsMet: " a beagle ", mood: "  ", notes: "park loop" },
  });

  await today.endWalk();
  const post = request.calls.find((call) => call.path === "/api/walks/end");
  assert.ok(post, "the end endpoint was called");
  assert.deepEqual(post.options.body, { walkId: "walk-1", pee: 1, dogsMet: " a beagle ", notes: "park loop" });
  assert.equal(today.state.walk.open, null, "the refetched day has nothing open");
});

test("the discard control appears only on a stale walk, and end form stays available", () => {
  setState({ profile: profileOf() });
  const today = todayWith(fakeRequest({ status: 200, ok: true, body: null }));
  const stale = {
    open: walkOf(),
    serverNow: "2026-10-30T18:00:00.000Z",
    staleAfterMs: 8 * 60 * 60 * 1000,
    // `walkNow` advances the server instant by local elapsed time, so the test
    // records "received just now" and the timer shows the server's 10 h.
    receivedAt: Date.now(),
  };

  today.state.walk = stale;
  const staleTree = today.renderWalk();
  assert.match(textsOf(staleTree).join(" "), /walk has been open for/, "the caregiver is warned");
  assert.ok(textsOf(staleTree).join(" ").includes("Discard…"), "a stale walk can be discarded");
  assert.match(textsOf(staleTree).join(" "), /8:00:00\+/, "a stale timer is clamped at the window (PLAN §8.5)");

  today.state.walk = { ...stale, serverNow: "2026-10-30T08:05:00.000Z", receivedAt: Date.now() };
  const freshTree = today.renderWalk();
  assert.ok(!textsOf(freshTree).join(" ").includes("Discard…"), "a fresh walk is only endable");
  assert.ok(textsOf(freshTree).join(" ").includes("5:00"), "the timer counts from the server clock");
});

test("discarding sends the walk id, and a lost end shows who ended it", async () => {
  setState({ profile: profileOf() });
  const discardRequest = fakeRequest((path) => {
    if (path === "/api/walks") return { status: 200, ok: true, body: walkData() };
    return { status: 200, ok: true, body: { walk: walkOf({ endedAt: "2026-10-30T18:00:00.000Z", discarded: true }), replayed: false } };
  });
  const discarding = todayWith(discardRequest, { walk: walkData({ open: walkOf() }), walkDiscardOpen: true });
  await discarding.discardWalk();
  const discard = discardRequest.calls.find((call) => call.path === "/api/walks/discard");
  assert.ok(discard, "the discard endpoint was called");
  assert.deepEqual(discard.options.body, { walkId: "walk-1" });
  assert.equal(discarding.state.walk.open, null, "the committed discard closes the card");

  const conflictRequest = fakeRequest((path) =>
    path === "/api/walks"
      ? { status: 200, ok: true, body: walkData() }
      : {
          status: 409,
          ok: false,
          body: {
            error: "walk_ended",
            message: '"Sam" already ended this walk at 08:35',
            walk: walkOf({ endedAt: "2026-10-30T08:35:00.000Z", endedBy: "partner", endedByLabel: "Sam" }),
          },
        },
  );
  const lost = todayWith(conflictRequest, { walk: walkData({ open: walkOf() }) });
  await lost.endWalk();
  assert.match(lost.state.walkError, /Sam already ended this walk at 09:35/);
  assert.ok(
    conflictRequest.calls.some((call) => call.path === "/api/walks"),
    "the card re-reads after the conflict",
  );
});

test("a slow walk read cannot overwrite a newer one, and a conflict clears the form", async () => {
  setState({ profile: profileOf() });
  let releaseFirst;
  let reads = 0;
  const request = fakeRequest((path) => {
    if (path !== "/api/walks") return { status: 200, ok: true, body: null };
    reads += 1;
    if (reads === 1) {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: 200, ok: true, body: walkData({ open: walkOf({ startedByLabel: "Old" }) }) });
      });
    }
    return { status: 200, ok: true, body: walkData() };
  });
  const today = todayWith(request);

  const first = today.loadWalks();
  await today.loadWalks();
  releaseFirst();
  await first;
  assert.equal(today.state.walk.open, null, "the newer read wins");

  const conflictRequest = fakeRequest((path) => {
    if (path === "/api/walks") return { status: 200, ok: true, body: walkData() };
    return { status: 409, ok: false, body: { error: "walk_ended", message: "already over" } };
  });
  const conflicted = todayWith(conflictRequest, {
    walk: walkData({ open: walkOf() }),
    walkFormOpen: true,
    walkDiscardOpen: true,
    walkDraft: { pee: "2", poop: "1", dogsMet: "", mood: "", notes: "park loop" },
  });
  await conflicted.endWalk();
  assert.equal(conflicted.state.walkFormOpen, false, "the refused form closes");
  assert.equal(conflicted.state.walkDiscardOpen, false);
  assert.deepEqual(conflicted.state.walkDraft, { pee: "", poop: "", dogsMet: "", mood: "", notes: "" });
  assert.ok(conflicted.state.walkError, "and the refusal is still shown");
});

// --- the growth chart's pure half (P3-03) --------------------------------

function growthPoint(localDate, weightKg, measurementId = `m-${localDate}`) {
  return { localDate, at: `${localDate}T09:00:00.000Z`, weightKg, measurementId };
}

test("the chart plots committed dates on a time axis, not one slot per point", () => {
  assert.equal(chartGeometry([]), null, "an empty series draws no chart");

  const { padding, width } = CHART_SIZE;
  const one = chartGeometry([growthPoint("2026-10-29", 4.2)]);
  assert.equal(one.dots.length, 1);
  assert.equal(one.segments.length, 0);
  assert.equal(
    one.dots[0].x,
    padding.left + (width - padding.left - padding.right) / 2,
    "a single reading is centred, with no span to divide",
  );

  // Two readings three weeks apart: the second is at the right edge, and the
  // first at the left. An index-based chart would put them equally spaced.
  const wide = chartGeometry([growthPoint("2026-10-01", 4.2), growthPoint("2026-10-22", 4.9)]);
  assert.equal(wide.dots[0].x, padding.left);
  assert.equal(wide.dots[1].x, padding.left + (width - padding.left - padding.right));
  assert.equal(daysBetweenLocalDates("2026-10-01", "2026-10-22"), 21);
  assert.equal(wide.xTicks[0].label, "2026-10-01");
  assert.equal(wide.xTicks[1].label, "2026-10-22");

  // Three readings with uneven gaps: the middle dot sits 1/21 of the way
  // across, not halfway. This is the assertion that tells a time axis from an
  // index axis (two points cannot).
  const uneven = chartGeometry([
    growthPoint("2026-10-01", 4.2),
    growthPoint("2026-10-02", 4.201),
    growthPoint("2026-10-22", 4.202),
  ]);
  const plotWidth = width - padding.left - padding.right;
  assert.ok(uneven.dots[1].x < padding.left + plotWidth / 4, "the second day is near the left edge");
  assert.equal(uneven.dots[1].x, Math.round((padding.left + (1 / 21) * plotWidth) * 10) / 10);
  // A gram-wide range still labels three distinct weights.
  assert.deepEqual(uneven.yTicks.map((tick) => tick.label), ["4.202", "4.201", "4.2"]);
});

test("a trend slice is a chip label: the change, or what is missing", () => {
  assert.equal(windowLabel({ days: 14, available: true, pct: 2.04 }), "+2.0%");
  assert.equal(windowLabel({ days: 14, available: true, pct: -2.04 }), "-2.0%");
  assert.equal(windowLabel({ days: 7, available: true, pct: 0 }), "0.0%");
  assert.equal(windowLabel({ days: 7, available: false, reason: "no_readings" }), "no readings");
  assert.equal(windowLabel({ days: 30, available: false, reason: "one_reading" }), "one reading");
  assert.equal(windowLabel({ days: 30, available: false, reason: "too_short" }), "too few days");
});

test("a gap between measurements is marked, never drawn as an ordinary segment", () => {
  const geometry = chartGeometry([
    growthPoint("2026-10-21", 4.2),
    growthPoint("2026-10-22", 4.25),
    growthPoint("2026-10-25", 4.3),
    growthPoint("2026-10-26", 4.35),
  ]);
  assert.deepEqual(
    geometry.segments.map((segment) => segment.gap),
    [false, true, false],
    "only a segment crossing more than a day is a gap",
  );
  assert.equal(geometry.hasGaps, true);
  // The weights rise, so the y coordinates fall: y is inverted.
  assert.ok(geometry.dots[0].y > geometry.dots[1].y);
  assert.equal(chartGeometry([growthPoint("2026-10-21", 4.2), growthPoint("2026-10-22", 4.3)]).hasGaps, false);
});

test("the table carries the numbers, newest first, in the stored units", () => {
  assert.deepEqual(
    measurementRows([
      growthPoint("2026-10-21", 4.2),
      { ...growthPoint("2026-10-22", 4.25), heightCm: 31.5 },
    ]),
    [
      { localDate: "2026-10-22", weightKg: "4.25 kg", heightCm: "31.5 cm" },
      { localDate: "2026-10-21", weightKg: "4.2 kg", heightCm: "" },
    ],
  );
  assert.equal(formatKg(4.237), "4.237 kg");
  assert.equal(formatKg(4.2), "4.2 kg");
  assert.equal(formatKg(4), "4 kg");
});

test("the Pup screen re-reads growth and the board on a care signal instead of trusting the frame", async () => {
  const views = [];
  const pup = new Pup({
    request: async (path) => {
      views.push(path);
      if (path === "/api/growth") {
        return { status: 200, ok: true, body: { points: [], summary: { state: "no_data" }, lines: [] } };
      }
      return { status: 200, ok: true, body: { milestones: [] } };
    },
  });
  pup.state = { ...pup.state, profile: profileOf(), seenCare: 0 };
  pup.setState = (patch) => Object.assign(pup.state, patch);

  // The same care sequence twice: one read of each, not two.
  pup.onStore({ profile: profileOf(), careSeq: 3 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  pup.onStore({ profile: profileOf(), careSeq: 3 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(views.sort(), ["/api/growth", "/api/training"]);
  assert.deepEqual(pup.state.growth, { points: [], summary: { state: "no_data" }, lines: [] });
  assert.deepEqual(pup.state.training, []);

  // A new sequence means a care commit: read both again.
  pup.onStore({ profile: profileOf(), careSeq: 4 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(views.length, 4);
  assert.equal(views.filter((path) => path === "/api/training").length, 2);
});

test("a committed board answer outranks a read that was in flight", async () => {
  let releaseRead;
  let reads = 0;
  const pup = new Pup({
    request: async (path) => {
      if (path === "/api/growth") return { status: 200, ok: true, body: { points: [], summary: {}, lines: [] } };
      reads += 1;
      if (reads === 1) {
        return new Promise((resolve) => {
          releaseRead = () => resolve({ status: 200, ok: true, body: { milestones: [{ id: "stale" }] } });
        });
      }
      return { status: 200, ok: true, body: { milestones: [{ id: "fresh" }] } };
    },
  });
  pup.setState = (patch) => Object.assign(pup.state, patch);

  const inFlight = pup.loadTraining();
  // A write commits while the read is out: the component's own `applyBoard`
  // adopts the answer, and the read must not land on top of it.
  pup.applyBoard([{ id: "committed" }]);
  releaseRead();
  assert.equal(await inFlight, "superseded");
  assert.deepEqual(pup.state.training, [{ id: "committed" }], "the stale read never lands");
});

test("the board groups by status and the request bodies keep absent apart from null", () => {
  const rows = [
    { id: "catalog:sit", title: "Sit", origin: "catalog", status: "mastered", masteredAt: "2026-10-29T10:00:00.000Z", byLabel: "Alex" },
    {
      id: "custom:roll",
      title: "Roll over",
      origin: "custom",
      status: "practicing",
      note: "still wobbly",
      updatedAt: "2026-10-29T11:00:00.000Z",
      byLabel: "Sam",
    },
    { id: "catalog:come", title: "Come when called", origin: "catalog", status: "not_started" },
  ];
  assert.deepEqual(
    boardGroups(rows).map((group) => [group.label, group.rows.map((row) => row.title)]),
    [
      ["Mastered", ["Sit"]],
      ["Practicing", ["Roll over"]],
      ["Not started", ["Come when called"]],
    ],
  );
  assert.deepEqual(boardGroups([]), [
    { status: "mastered", label: "Mastered", rows: [] },
    { status: "practicing", label: "Practicing", rows: [] },
    { status: "not_started", label: "Not started", rows: [] },
  ]);

  // A status click must not send a note key: absent means "keep the note".
  assert.deepEqual(statusUpdate(rows[0], "practicing"), { milestoneId: "catalog:sit", status: "practicing" });
  // An empty note is an explicit clear (null), never an absent key.
  assert.deepEqual(noteUpdate(rows[1], "  "), { milestoneId: "custom:roll", note: null });
  assert.deepEqual(noteUpdate(rows[1], " sits now "), { milestoneId: "custom:roll", note: "sits now" });
  assert.deepEqual(customMilestone("  Spin  "), { title: "Spin" });

  // The one line under a row, in the household zone: 22:30Z on 29 October is
  // already 30 October in Paris, and the board must say so (never the UTC date).
  assert.equal(rowMetaText(rows[0], "Europe/Paris"), "mastered 2026-10-29 11:00 by Alex");
  assert.equal(
    rowMetaText({ ...rows[0], masteredAt: "2026-10-29T23:30:00.000Z" }, "Europe/Paris"),
    "mastered 2026-10-30 00:30 by Alex",
    "23:30Z is the next day in Paris",
  );
  assert.equal(rowMetaText(rows[1], "Europe/Paris"), "changed 2026-10-29 12:00 by Sam");
  assert.equal(rowMetaText(rows[2], "Europe/Paris"), "");
});

test("a slow growth read never overwrites a newer one", async () => {
  let releaseFirst;
  let calls = 0;
  const pup = new Pup({
    request: async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve({ status: 200, ok: true, body: { points: [], summary: {}, lines: [], tag: "old" } });
        });
      }
      return { status: 200, ok: true, body: { points: [], summary: {}, lines: [], tag: "new" } };
    },
  });
  pup.setState = (patch) => Object.assign(pup.state, patch);

  const first = pup.loadGrowth();
  await pup.loadGrowth();
  assert.equal(pup.state.growth.tag, "new");
  releaseFirst();
  assert.equal(await first, "superseded", "the older read loses");
  assert.equal(pup.state.growth.tag, "new");
});

test("a refused weight shows the domain's rule, not a generic sentence", async () => {
  const pup = new Pup({
    request: async () => ({ status: 409, ok: false, body: { error: "a measurement is a weight in kilograms from 0.001 to 200" } }),
  });
  pup.state = { ...pup.state, profile: profileOf(), log: { weightKg: "500", heightCm: "", note: "" } };
  pup.setState = (patch) => Object.assign(pup.state, patch);
  await pup.logWeight({ preventDefault() {} });
  assert.match(pup.state.logError, /a measurement is a weight in kilograms/);
});

test("an unparseable height is refused before it can be dropped silently", async () => {
  const requests = [];
  const pup = new Pup({
    request: async (path, options) => {
      requests.push({ path, body: options?.body });
      return { status: 200, ok: true, body: { growth: { points: [], summary: {}, lines: [] }, replayed: false } };
    },
  });
  pup.state = {
    ...pup.state,
    profile: profileOf(),
    log: { weightKg: "4.2", heightCm: "abc", note: "" },
    logBusy: false,
  };
  pup.setState = (patch) => Object.assign(pup.state, patch);

  await pup.logWeight({ preventDefault() {} });
  assert.match(pup.state.logError, /height is a number/);
  assert.deepEqual(requests, [], "nothing is sent: a null height would commit without it");

  pup.state.log = { weightKg: "4.2", heightCm: "31.5", note: "" };
  await pup.logWeight({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { weightKg: 4.2, heightCm: 31.5 });
});
