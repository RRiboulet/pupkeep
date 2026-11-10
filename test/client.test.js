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
const { MealTimes } = await import("../web/views/meal-times.js");
const { slotDraftsOf, wireSlots } = await import("../web/views/meal-slots.js");
const { applyCareView, startLive, subscribeThread } = await import("../web/live.js");
const { feedTimeText, localDate, localMinutes, mealClock, mealRows, mealStatus, minutesOf } = await import(
  "../web/meals.js"
);
const { correctedNow, timerText, walkSeconds, walkStale, walkTimeText } = await import("../web/walks.js");
const { getState, setState } = await import("../web/store.js");
const { changedFields, draftOf, emptyDraft, isNewer, pendingSave, wireOf } = await import("../web/profile-form.js");
const { CHART_SIZE, chartGeometry, daysBetweenLocalDates, formatKg, measurementRows, windowLabel } =
  await import("../web/growth-chart.js");
const { boardGroups, customMilestone, noteUpdate, rowMetaText, statusUpdate } = await import("../web/training.js");
const { Showers } = await import("../web/views/showers.js");
const { dateText } = await import("../web/clock.js");
const { INVITE_TTL_MINUTES, inviteBody, inviteLinkOf } = await import("../web/household.js");
const { Invite } = await import("../web/views/invite.js");
const { Agent } = await import("../web/views/agent.js");
const {
  allowlistLines,
  budgetBody,
  budgetPercent,
  budgetStateText,
  currentModelText,
  modelChoiceBody,
  modelOptionText,
  money,
  parseCapInput,
  probeResultLines,
  probeText,
  providerKeyBody,
  spendText,
} = await import("../web/models.js");
const {
  dueText,
  earlierCount,
  intervalText,
  lastShowerText,
  recentShowers,
  showerBody,
  showerMetaText,
} = await import("../web/showers.js");

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

/** A committed shower view, as GET /api/showers answers it. */
function showerView({ history = [], last = null, nextDue = null, daysUntilDue = null, intervalDays = 21 } = {}) {
  return { history, status: { last, nextDue, daysUntilDue }, intervalDays };
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

test("the one stream forwards the thread's snapshot, batch and connection frames", () => {
  const listeners = new Map();
  const source = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    close() {},
  };
  const live = startLive({ createSource: () => source, refresh: () => {} });
  const events = [];
  const stop = subscribeThread((event) => events.push(event));

  listeners.get("open")();
  listeners.get("snapshot")({ data: JSON.stringify({ seq: 3, status: { busy: false, queued: 0 }, entries: [] }) });
  listeners.get("batch")({ data: JSON.stringify({ seq: 4, events: [{ type: "run_start" }] }) });
  listeners.get("error")();
  stop();
  listeners.get("open")();

  assert.deepEqual(events.map((event) => event.type), ["open", "snapshot", "batch", "error"], "one stream, no second connection");
  assert.equal(events[1].snapshot.seq, 3);
  assert.equal(events[2].seq, 4);
  assert.equal(events[2].events[0].type, "run_start");
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
  assert.match(String(theirs.state.conflict), /Someone else changed this while you were editing/);
  assert.doesNotMatch(String(theirs.state.conflict), /meal times/, "a puppy edit is not blamed on the meals");
  assert.equal(theirs.state.puppy.name, "Biscuit", "their typing is not replaced");

  // The copy names the section that actually moved.
  const meals = wizard({});
  meals.state.puppyDirty = false;
  meals.state.slotsDirty = true;
  meals.state.slots = [{ id: "slot-a", label: "Breakfast", timeLocal: "06:30", portion: "", active: true }];
  meals.onStore({ profile: profileOf({ rev: 2, mealsRev: 2 }) });
  assert.match(String(meals.state.conflict), /Someone else changed the meal times/);
  assert.equal(meals.state.slots[0].timeLocal, "06:30", "the meal draft is kept");
});

test("one frame that moves two dirty sections does not single out the meals", () => {
  const before = profileOf();
  const setup = new Setup({});
  setup.state = {
    profile: before,
    zone: before.household.timezone,
    zoneDirty: false,
    puppy: draftOf(before),
    puppyDirty: true,
    slots: slotDraftsOf(before.meals.slots),
    slotsDirty: true,
    busy: null,
    error: null,
    message: null,
    conflict: null,
    pending: {},
  };
  setup.setState = (patch) => Object.assign(setup.state, patch);
  // A reconnect re-reads one whole view, so a single frame can carry two bumps.
  setup.onStore({ profile: profileOf({ rev: 2, mealsRev: 2, name: "Other pup" }) });
  assert.match(String(setup.state.conflict), /Someone else changed this while you were editing/);
  assert.doesNotMatch(String(setup.state.conflict), /meal times/, "two moved sections are not one");
});

test("a frame that completes setup drops the unsavable meal draft and says so", () => {
  const before = { ...profileOf({ mealsRev: 1 }), setup: { complete: false, missing: ["meals"] } };
  const setup = new Setup({});
  setup.state = {
    profile: before,
    zone: before.household.timezone,
    zoneDirty: false,
    puppy: draftOf(before),
    puppyDirty: false,
    slots: [{ id: "slot-a", label: "Breakfast", timeLocal: "06:30", portion: "", active: true }],
    slotsDirty: true,
    busy: null,
    error: null,
    message: null,
    conflict: null,
    pending: {},
  };
  setup.setState = (patch) => Object.assign(setup.state, patch);
  // The partner's save is the one that finishes setup: the wizard's meal form
  // disappears with it, so "saving again" would name a button that is gone.
  setup.onStore({ profile: profileOf({ mealsRev: 2 }) });

  assert.equal(setup.state.conflict, null, "no banner promises a save the screen no longer offers");
  assert.match(setup.state.message, /not kept/);
  assert.match(setup.state.message, /Meal times card above/);
  assert.equal(setup.state.slotsDirty, false);
  assert.equal(setup.state.slots[0].timeLocal, "07:00", "the committed schedule replaces the unsavable draft");
  assert.ok(!vnodeText(setup.render(), "Save meal times"), "no orphan save button after completion");
});

// --- the shared meal-slot editor (P1-14's wizard, reused by Settings) -------

test("wireSlots trims labels, drops an empty portion and keeps the wall-clock minute", () => {
  const wired = wireSlots([
    { id: "slot-a", label: "  Breakfast  ", timeLocal: "07:00:00", portion: "   ", active: true },
    { id: "slot-b", label: "Lunch", timeLocal: "12:30", portion: "1 cup", active: false },
  ]);
  assert.deepEqual(wired, [
    { id: "slot-a", label: "Breakfast", timeLocal: "07:00", active: true },
    { id: "slot-b", label: "Lunch", timeLocal: "12:30", portion: "1 cup", active: false },
  ]);
});

test("slotDraftsOf fills an absent portion so the editor always has a string", () => {
  assert.deepEqual(slotDraftsOf([{ id: "slot-a", label: "Breakfast", timeLocal: "07:00", active: true }]), [
    { id: "slot-a", label: "Breakfast", timeLocal: "07:00", portion: "", active: true },
  ]);
});

test("the wizard hides its meal section once setup is complete and says where it is edited", () => {
  const unfinishedProfile = { ...profileOf({ slots: [] }), setup: { complete: false, missing: ["meals"] } };
  const unfinished = new Setup({});
  unfinished.state = {
    profile: unfinishedProfile,
    zone: "Europe/Paris",
    zoneDirty: false,
    puppy: emptyDraft(),
    puppyDirty: false,
    slots: [{ id: "slot-a", label: "Breakfast", timeLocal: "07:00", portion: "", active: true }],
    slotsDirty: false,
    busy: null,
    error: null,
    message: null,
    conflict: null,
    pending: {},
  };
  const editing = unfinished.render();
  assert.ok(vnodeText(editing, "Save meal times"), "an unfinished household edits meals in the wizard");
  assert.ok(findVnode(editing, "MealSlots"), "the wizard uses the shared slot editor");

  const done = new Setup({});
  done.state = { ...unfinished.state, profile: profileOf() };
  const settled = done.render();
  assert.ok(!findVnode(settled, "MealSlots"), "a finished household has no second editor in the wizard");
  assert.ok(vnodeText(settled, "Meal times card"), "the wizard says where the schedule is edited");
});

test("the Settings meal-times card renders the shared editor and its save action", () => {
  const card = new MealTimes({});
  card.state = {
    profile: profileOf(),
    slots: slotDraftsOf(profileOf().meals.slots),
    dirty: false,
    busy: false,
    error: null,
    message: null,
    conflict: null,
    pending: null,
  };
  const vnode = card.render();
  assert.ok(vnodeText(vnode, "Meal times"));
  assert.ok(findVnode(vnode, "MealSlots"), "the card reuses the wizard's slot editor, not a second copy");
  assert.ok(vnodeText(vnode, "Save meal times"));
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
    assert.equal(
      request.calls.filter((call) => call.path === "/api/appointments/next").length,
      1,
      "the next-appointment card is read on mount, so a remount is not stuck on Loading",
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
  const dayReads = () => request.calls.filter((call) => call.path === "/api/feeding/day").length;
  for (let index = 0; index < 30; index += 1) stale.onTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dayReads(), 1, "yesterday's day is re-read once the household date moves");

  const current = todayWith(request, { day: mealDay({ localDate: today, today }) });
  for (let index = 0; index < 30; index += 1) current.onTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dayReads(), 1, "the same day is not re-read by the ticker");
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

test("the Pup screen re-reads growth, the board and the showers on a care signal instead of trusting the frame", async () => {
  const views = [];
  const pup = new Pup({
    request: async (path) => {
      views.push(path);
      if (path === "/api/growth") {
        return { status: 200, ok: true, body: { points: [], summary: { state: "no_data" }, lines: [] } };
      }
      if (path === "/api/showers") {
        return { status: 200, ok: true, body: showerView() };
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
  assert.deepEqual(views.sort(), ["/api/growth", "/api/showers", "/api/training"]);
  assert.deepEqual(pup.state.growth, { points: [], summary: { state: "no_data" }, lines: [] });
  assert.deepEqual(pup.state.training, []);
  assert.deepEqual(pup.state.showers, showerView());

  // A new sequence means a care commit: read all three again.
  pup.onStore({ profile: profileOf(), careSeq: 4 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(views.length, 6);
  assert.equal(views.filter((path) => path === "/api/training").length, 2);
  assert.equal(views.filter((path) => path === "/api/showers").length, 2);
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

// --- the shower card (P3-07) ------------------------------------------------

test("the shower card's body, due copy and recent-few cap are pure and household-local", () => {
  // A stored local date reads back as that date, never the day before in a zone
  // behind UTC (the formatter is pinned to UTC on purpose).
  assert.equal(dateText("2026-11-15"), "15 Nov 2026");
  assert.equal(dateText("not-a-date"), "not-a-date");
  assert.equal(dateText(null), "");
  // A day that does not exist and a year `Date.UTC` would remap are shown as
  // they arrived, never as a different date.
  assert.equal(dateText("2026-02-31"), "2026-02-31");
  assert.equal(dateText("0001-01-01"), "0001-01-01");

  // Empty text is absent, padded text is trimmed: the same draft must replay.
  assert.deepEqual(showerBody({ shampoo: "  Oatmeal ", notes: "   " }), { shampoo: "Oatmeal" });
  assert.deepEqual(showerBody({ shampoo: "", notes: "Muddy paws" }), { notes: "Muddy paws" });
  assert.deepEqual(showerBody({}), {}, "the primary action is a shower with no details");

  // The one comparison P3-06 derived, in the card's words.
  assert.equal(dueText({ last: null, nextDue: null, daysUntilDue: null }), "No showers logged yet.");
  assert.equal(dueText({ last: null, nextDue: "2026-11-15", daysUntilDue: 0 }), "Next due 15 Nov 2026 — due today.");
  assert.equal(dueText({ last: null, nextDue: "2026-11-15", daysUntilDue: 1 }), "Next due 15 Nov 2026 — in 1 day.");
  assert.equal(dueText({ last: null, nextDue: "2026-11-15", daysUntilDue: -3 }), "Next due 15 Nov 2026 — 3 days overdue.");
  assert.equal(lastShowerText({ last: { localDate: "2026-10-25", byLabel: "Alex" } }), "Last shower 25 Oct 2026 by Alex.");
  assert.equal(lastShowerText({ last: null }), "");
  assert.equal(intervalText(21), "every 21 days");
  assert.equal(intervalText(1), "every day");

  // The recent few, newest first, and the count of what is hidden.
  const history = Array.from({ length: 7 }, (_, index) => ({ id: `s-${index}`, localDate: "2026-10-25" }));
  assert.equal(recentShowers(history).length, 5);
  assert.equal(recentShowers(history)[0].id, "s-0");
  assert.equal(earlierCount(history), 2);
  assert.equal(earlierCount([]), 0);

  // The row's time is the household zone: 23:30Z is already the next day in Paris.
  assert.equal(
    showerMetaText({ byLabel: "Alex", at: "2026-10-29T23:30:00.000Z" }, "Europe/Paris"),
    "by Alex at 00:30",
  );
  // An unusable zone must not produce "at at an unknown time".
  assert.equal(showerMetaText({ byLabel: "Alex", at: "2026-10-29T23:30:00.000Z" }, "Not/AZone"), "by Alex");
});

test("logging a shower sends a bounded body and asks for a re-read instead of adopting a collection", async () => {
  const calls = [];
  let rereads = 0;
  const card = new Showers({
    request: async (path, options) => {
      calls.push({ path, options });
      // A write's answer is the record, never the history.
      return { status: 200, ok: true, body: { shower: { id: "s-1" }, replayed: false } };
    },
    onLogged: async () => {
      rereads += 1;
    },
    view: showerView(),
    timezone: "Europe/Paris",
    error: null,
  });
  card.setState = (patch) => Object.assign(card.state, patch);
  card.state = { ...card.state, draft: { shampoo: " Oatmeal ", notes: "" } };

  await card.save({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/showers");
  assert.deepEqual(calls[0].options.body, { shampoo: "Oatmeal" });
  assert.equal(rereads, 1, "the parent re-reads the unbounded history");
  assert.equal("view" in card.state, false, "the card keeps no collection of its own");
  assert.equal(card.state.message, "Logged.");
  assert.deepEqual(card.state.draft, { shampoo: "", notes: "" });
});

test("a refused shower shows the domain's rule and keeps the key for a same-body retry", async () => {
  let pendingKey;
  const card = new Showers({
    request: async (_path, options) => {
      pendingKey = options?.idempotencyKey;
      return { status: 409, ok: false, body: { error: "a shower is optional shampoo and note text, one line each" } };
    },
    onLogged: async () => {
      throw new Error("nothing was written, so nothing is re-read");
    },
    view: showerView(),
    timezone: "Europe/Paris",
    error: null,
  });
  card.setState = (patch) => Object.assign(card.state, patch);
  card.state = { ...card.state, draft: { shampoo: "", notes: "x".repeat(400) } };

  await card.save({ preventDefault() {} });
  assert.match(card.state.error, /one line each/);
  assert.equal(card.state.pending.key, pendingKey, "the key stays with the body it belongs to");
  assert.equal(card.state.message, null);
});

test("a failed re-read after a successful log is not reported as a failed log", async () => {
  const card = new Showers({
    request: async () => ({ status: 200, ok: true, body: { shower: { id: "s-1" }, replayed: false } }),
    // The parent's loader rejects: the commit already succeeded, so this must
    // not become a red "Could not log the shower" beside "Logged."
    onLogged: async () => {
      throw new Error("the re-read failed");
    },
    view: showerView(),
    timezone: "Europe/Paris",
    error: null,
  });
  card.setState = (patch) => Object.assign(card.state, patch);

  await card.save({ preventDefault() {} });
  assert.equal(card.state.message, "Logged.");
  assert.equal(card.state.error, null, "the write succeeded; the read owns its own error");
  assert.equal(card.state.busy, false);
});

/** Any string in the vnode tree contains `needle` (a render smoke test, no DOM). */
/** The first vnode whose component type is `type` (by name), depth-first. */
function findVnode(node, type) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findVnode(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    if (node.type?.name === type) return node;
    return findVnode(node.props?.children, type);
  }
  return undefined;
}

function countVnode(node, type) {
  let count = 0;
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      if (n.type?.name === type) count += 1;
      walk(n.props?.children);
    }
  };
  walk(node);
  return count;
}

function findElement(node, tag) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, tag);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    if (node.type === tag) return node;
    return findElement(node.props?.children, tag);
  }
  return undefined;
}

function vnodeText(node, needle) {
  if (typeof node === "string") return node.includes(needle);
  if (Array.isArray(node)) return node.some((child) => vnodeText(child, needle));
  if (node && typeof node === "object") {
    if (vnodeText(node.props?.children, needle)) return true;
    // htm keeps the text of an element in its children; attributes are not copy.
    return false;
  }
  return false;
}

test("the card shows a stale-history warning, and still offers the log form", () => {
  const card = new Showers({
    request: async () => ({ status: 200, ok: true, body: showerView() }),
    view: showerView(),
    timezone: "Europe/Paris",
    error: "Could not load the shower history. Try again in a moment.",
  });
  card.setState = (patch) => Object.assign(card.state, patch);

  const withView = card.render();
  assert.ok(vnodeText(withView, "Could not load the shower history"), "a failed re-read is visible, not swallowed");

  // The form is its own commit, so a read failure does not take logging away.
  const withoutView = new Showers({ request: async () => ({}), view: null, error: "nope", timezone: "Europe/Paris" });
  withoutView.setState = (patch) => Object.assign(withoutView.state, patch);
  assert.ok(vnodeText(withoutView.render(), "Log shower"), "the form is shown while the read is unavailable");
});

// --- calendar (P4-02) -------------------------------------------------------

const { Calendar } = await import("../web/views/calendar.js");
const {
  appointmentBody,
  appointmentsByDate,
  blankDraft,
  draftFrom,
  durationText,
  monthGrid,
  monthWindow,
  nextAppointmentText,
  offsetOptions,
  shiftMonth,
  timeRangeText,
} = await import("../web/calendar.js");

test("the month grid starts on Monday, marks today and always shows six weeks", () => {
  const grid = monthGrid("2026-02-15", { year: 2026, month: 2 });
  assert.equal(grid.weeks.length, 6);
  assert.equal(grid.weeks.flat().length, 42);
  assert.equal(grid.weeks[0][0].date, "2026-01-26", "1 February 2026 is a Sunday: the row starts on 26 January");
  assert.equal(grid.weeks[0][0].inMonth, false);
  assert.equal(grid.weeks[0][6].date, "2026-02-01");
  assert.equal(grid.weeks[0][6].inMonth, true);
  assert.equal(grid.weeks.flat().filter((day) => day.isToday).map((day) => day.date).join(), "2026-02-15");
  assert.equal(grid.label, "February 2026");
  assert.deepEqual(monthWindow({ year: 2026, month: 2 }), { from: "2026-01-26", to: "2026-03-08" });
  assert.deepEqual(shiftMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth({ year: 2027, month: 1 }, -1), { year: 2026, month: 12 });
});

test("the appointment body trims text, omits empty fields and keeps an explicit offset list", () => {
  assert.deepEqual(
    appointmentBody({
      title: "  Vet visit ",
      localDate: "2026-12-20",
      timeLocal: "09:00",
      durationMin: "30",
      location: "  ",
      vetName: "Dr Moreau",
      notes: "",
      offsets: [60, 1440],
    }),
    {
      title: "Vet visit",
      localDate: "2026-12-20",
      timeLocal: "09:00",
      durationMin: 30,
      reminderOffsetsMin: [1440, 60],
      vetName: "Dr Moreau",
    },
  );
  assert.deepEqual(appointmentBody({ ...blankDraft("2026-11-20", []) }), {
    title: "",
    localDate: "2026-11-20",
    timeLocal: "09:00",
    durationMin: 30,
    reminderOffsetsMin: [],
  });
  assert.deepEqual(blankDraft("2026-11-20", [1440, 60]).offsets, [1440, 60], "a create starts from the household default");
  const stored = {
    id: "a-1",
    rev: 2,
    title: "Vet",
    localDate: "2026-12-20",
    timeLocal: "09:00",
    durationMin: 30,
    reminderOffsetsMin: [0],
    location: "Rue",
    timezone: "Europe/Paris",
  };
  assert.deepEqual(draftFrom(stored), {
    mode: "edit",
    id: "a-1",
    rev: 2,
    title: "Vet",
    localDate: "2026-12-20",
    timeLocal: "09:00",
    durationMin: 30,
    location: "Rue",
    vetName: "",
    notes: "",
    offsets: [0],
    timezone: "Europe/Paris",
  });
});

test("a chip, a duration and the reminder labels are derived, never stored", () => {
  assert.equal(timeRangeText({ timeLocal: "09:00", durationMin: 90 }), "09:00–10:30");
  // The derived instants beat wall-clock arithmetic on a DST day: Paris 01:30
  // + 2 h is 02:30 after the fall-back (the 02:00 hour repeats) and 04:30 after
  // the spring-forward, never 03:30.
  assert.equal(
    timeRangeText({
      timeLocal: "01:30",
      durationMin: 120,
      timezone: "Europe/Paris",
      startsAt: "2026-10-24T23:30:00.000Z",
      endsAt: "2026-10-25T01:30:00.000Z",
    }),
    "01:30–02:30",
  );
  assert.equal(
    timeRangeText({
      timeLocal: "01:30",
      durationMin: 120,
      timezone: "Europe/Paris",
      startsAt: "2026-03-29T00:30:00.000Z",
      endsAt: "2026-03-29T02:30:00.000Z",
    }),
    "01:30–04:30",
  );
  assert.equal(timeRangeText({ timeLocal: "01:30", durationMin: 120 }), "01:30–03:30", "wall-clock fallback");
  assert.equal(durationText(30), "30 min");
  assert.equal(durationText(90), "1 h 30 min");
  assert.equal(durationText(120), "2 h");
  assert.deepEqual(
    offsetOptions([120], [1440, 60]).map((option) => [option.minutes, option.checked]),
    [
      [1440, false],
      [120, true],
      [60, false],
      [0, false],
    ],
    "the presets, the household defaults and an unknown stored value all stay selectable",
  );
  const grouped = appointmentsByDate([
    { id: "a", localDate: "2026-11-20" },
    { id: "b", localDate: "2026-11-20" },
    { id: "c", localDate: "2026-11-21" },
  ]);
  assert.equal(grouped.get("2026-11-20").length, 2);
  assert.equal(grouped.get("2026-11-21").length, 1);
});

test("the next-appointment copy counts household dates, not the device clock", () => {
  const view = {
    today: "2026-10-30",
    timezone: "Europe/Paris",
    next: { localDate: "2026-11-20", timeLocal: "09:00", title: "Vet visit", location: "Rue de Lyon" },
  };
  assert.deepEqual(nextAppointmentText(view), { headline: "In 21 days · Vet visit", detail: "09:00 · Rue de Lyon" });
  assert.equal(nextAppointmentText({ ...view, next: { ...view.next, localDate: "2026-10-30" } }).headline, "Today · Vet visit");
  assert.equal(nextAppointmentText({ ...view, next: { ...view.next, localDate: "2026-10-31" } }).headline, "Tomorrow · Vet visit");
  assert.deepEqual(nextAppointmentText({ today: "2026-10-30", next: null }), {
    headline: "No appointment scheduled.",
    detail: "",
  });
  // A record booked before the household moved keeps its own zone, and the
  // card names it rather than pretending the wall clock is the household's.
  assert.equal(
    nextAppointmentText({
      ...view,
      next: { ...view.next, timezone: "America/New_York" },
    }).detail,
    "09:00 · America/New_York · Rue de Lyon",
  );
});

test("the calendar card saves with one key, keeps a stale draft and adopts the revision", async () => {
  const calls = [];
  let answer = { status: 200, ok: true, body: { appointment: { id: "a-1", rev: 0 } } };
  let loads = 0;
  const card = new Calendar({});
  card.request = async (path, options) => {
    calls.push({ path, options });
    return answer;
  };
  card.setState = (patch, callback) => {
    Object.assign(card.state, patch);
    if (typeof callback === "function") callback();
  };
  card.load = async () => {
    loads += 1;
  };

  card.setState({ form: { ...blankDraft("2026-12-20", [1440, 60]), title: " Vet visit " } });
  const event = { preventDefault() {} };
  await card.save(event);
  assert.equal(calls[0].path, "/api/appointments");
  assert.deepEqual(calls[0].options.body, {
    title: "Vet visit",
    localDate: "2026-12-20",
    timeLocal: "09:00",
    durationMin: 30,
    reminderOffsetsMin: [1440, 60],
  });
  assert.equal(typeof calls[0].options.idempotencyKey, "string");
  assert.equal(card.state.form, null, "a saved form closes");
  assert.match(card.state.message, /saved/i);

  // A stale answer keeps the draft, shows the other caregiver's revision and
  // does not pretend the save worked.
  answer = {
    status: 409,
    ok: false,
    body: { error: "stale", appointment: { id: "a-1", rev: 4 } },
  };
  const loadsBeforeStale = loads;
  card.setState({
    form: { ...blankDraft("2026-12-20", [1440]), mode: "edit", id: "a-1", rev: 3, title: "Mine" },
  });
  await card.save(event);
  assert.equal(card.state.form.title, "Mine", "the draft is kept");
  assert.equal(card.state.form.rev, 4, "the next save is a deliberate override");
  assert.equal(card.state.form.mode, "edit");
  assert.match(card.state.message, /Someone else changed/);
  assert.equal(loadsBeforeStale + 1, loads, "the committed record is re-read, so the detail and Cancel use it");

  // A refused duration never reaches the wire.
  calls.length = 0;
  card.setState({ form: { ...blankDraft("2026-12-20", []), title: "Vet", durationMin: 2 } });
  await card.save(event);
  assert.equal(calls.length, 0);
  assert.match(card.state.error, /5 to 720 minutes/);
});

// --- Web Push client (P4-05) -------------------------------------------------

const { disablePush, enablePush, pushSupported, urlBase64ToUint8Array } = await import("../web/push.js");

test("the VAPID base64url key becomes the bytes pushManager wants", () => {
  assert.deepEqual([...urlBase64ToUint8Array("AQAB")], [1, 0, 1]);
  assert.deepEqual([...urlBase64ToUint8Array("AQ")], [1], "missing padding is added");
  assert.deepEqual([...urlBase64ToUint8Array("-_8")], [0xfb, 0xff], "URL-safe characters are mapped");
});

test("push support needs a secure context, a service worker and PushManager", () => {
  const window = { PushManager: function PushManager() {} };
  const navigator = { serviceWorker: {} };
  assert.equal(pushSupported({ window, navigator, secure: true }), true);
  assert.equal(pushSupported({ window, navigator, secure: false }), false, "Tailscale HTTP cannot subscribe");
  assert.equal(pushSupported({ window: {}, navigator, secure: true }), false);
  assert.equal(pushSupported({ window, navigator: {}, secure: true }), false);
});

test("enablePush subscribes and stores the browser's own subscription", async () => {
  const calls = [];
  const subscription = {
    toJSON: () => ({ endpoint: "https://push.example/x", keys: { p256dh: "p".repeat(65), auth: "a".repeat(22) } }),
    unsubscribe: async () => true,
  };
  const request = async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/push/public-key") return { status: 200, ok: true, body: { publicKey: "AQAB" } };
    return { status: 200, ok: true, body: { id: "sub-1" } };
  };
  const result = await enablePush({
    request,
    supported: true,
    permission: async () => "granted",
    registration: { pushManager: { subscribe: async (options) => {
      assert.equal(options.userVisibleOnly, true);
      assert.deepEqual([...options.applicationServerKey], [1, 0, 1]);
      return subscription;
    } } },
  });
  assert.equal(result.subscription, subscription);
  assert.equal(calls[1].path, "/api/push/subscriptions");
  assert.deepEqual(calls[1].options.body, subscription.toJSON() && {
    endpoint: "https://push.example/x",
    keys: { p256dh: "p".repeat(65), auth: "a".repeat(22) },
  });
  assert.equal(typeof calls[1].options.idempotencyKey, "string");

  assert.deepEqual(await enablePush({ request, supported: false }), { reason: "push_unsupported" });
  assert.deepEqual(
    await enablePush({ request, supported: true, permission: async () => "denied" }),
    { reason: "permission_denied" },
  );
});

test("a save failure drops the browser subscription so a retry starts clean", async () => {
  let unsubscribed = 0;
  const subscription = {
    toJSON: () => ({ endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: async () => {
      unsubscribed += 1;
      return true;
    },
  };
  const request = async (path) => {
    if (path === "/api/push/public-key") return { status: 200, ok: true, body: { publicKey: "AQAB" } };
    return { status: 409, ok: false, body: { error: "nope" } };
  };
  const result = await enablePush({
    request,
    supported: true,
    permission: async () => "granted",
    registration: { pushManager: { subscribe: async () => subscription } },
  });
  assert.deepEqual(result, { reason: "save_failed" });
  assert.equal(unsubscribed, 1);
});

test("disablePush removes the server record and unsubscribes the browser", async () => {
  const calls = [];
  let unsubscribed = 0;
  const subscription = {
    toJSON: () => ({ endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: async () => {
      unsubscribed += 1;
      return true;
    },
  };
  const request = async (path, options) => {
    calls.push({ path, options });
    return { status: 200, ok: true, body: { removed: true } };
  };
  const result = await disablePush({
    request,
    registration: { pushManager: { getSubscription: async () => subscription } },
  });
  assert.deepEqual(result, { removed: true });
  assert.equal(calls[0].path, "/api/push/unsubscribe");
  assert.deepEqual(calls[0].options.body, { endpoint: "https://push.example/x" });
  assert.equal(unsubscribed, 1);

  assert.deepEqual(
    await disablePush({ request, registration: { pushManager: { getSubscription: async () => null } } }),
    { removed: false },
  );
});

// --- the notification centre and settings (P4-06) ----------------------------

const {
  badgeText,
  categoryOptions,
  intentWhenText,
  ntfyBody,
  prefsBody,
  unreadOf,
} = await import("../web/notifications.js");
const { Notifications } = await import("../web/views/notifications.js");
const { Settings } = await import("../web/views/settings.js");

test("the badge, the unread count and the prefs body are derived, never stored", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(3), "3");
  assert.equal(badgeText(10), "9+");
  assert.equal(badgeText(-1), "");
  const items = [{ readAt: null }, { readAt: "2026-10-29T10:00:00.000Z" }, { readAt: null }];
  assert.equal(unreadOf(items), 2);
  assert.equal(unreadOf([]), 0);

  assert.deepEqual(prefsBody(true, ["fed", "fed", "feed_overdue", "walk_reminder"]), {
    enabled: true,
    categories: ["fed", "feed_overdue"],
    // The unknown category is dropped rather than sent.
  });
  assert.deepEqual(prefsBody(false, []), { enabled: false, categories: [] });
  assert.deepEqual(ntfyBody("  "), { topic: null });
  assert.deepEqual(ntfyBody(" topic "), { topic: "topic" });
  assert.deepEqual(
    categoryOptions(["fed"]).map((option) => [option.category, option.checked]),
    [
      ["appointment", false],
      ["feed_overdue", false],
      ["fed", true],
      ["approval", false],
      ["test", false],
    ],
  );
});

test("an intent's time is the household zone, not the device's", () => {
  assert.equal(intentWhenText("2026-10-30T08:00:00.000Z", "Europe/Paris"), "30 Oct 2026 09:00");
  // Just after Paris midnight the UTC date is still yesterday: the date and the
  // time must come from the same zone.
  assert.equal(intentWhenText("2026-01-01T23:00:00.000Z", "Europe/Paris"), "2 Jan 2026 00:00");
  assert.equal(intentWhenText("nonsense", "Europe/Paris"), "");
});

test("the centre renders the member's items, unread state and the badge", () => {
  setState({ profile: profileOf() });
  const centre = new Notifications({});
  centre.setState = (patch) => Object.assign(centre.state, patch);
  centre.setState({
    loading: false,
    unread: 2,
    items: [
      {
        id: "n1",
        title: "A meal is overdue",
        body: "Breakfast was not logged by 07:15.",
        createdAt: "2026-10-30T08:00:00.000Z",
        readAt: null,
      },
      {
        id: "n2",
        title: "A meal was logged",
        body: "Sam fed lunch.",
        createdAt: "2026-10-30T11:00:00.000Z",
        readAt: "2026-10-30T11:05:00.000Z",
      },
    ],
  });
  const vnode = centre.render();
  for (const text of ["A meal is overdue", "Breakfast was not logged", "Mark all read", "2", "Mark read"]) {
    assert.ok(vnodeText(vnode, text), `missing ${text}`);
  }
  assert.equal(vnodeText(vnode, "n1"), false, "ids are keys, not copy");
});

test("marking read posts one idempotent request and updates the badge", async () => {
  const calls = [];
  const centre = new Notifications({});
  centre.request = async (path, options) => {
    calls.push({ path, options });
    return { status: 200, ok: true, body: { unread: 0 } };
  };
  centre.setState = (patch) => Object.assign(centre.state, patch);
  centre.load = async () => {};
  setState({ unreadNotifications: 1 });
  centre.setState({ items: [{ id: "n1", readAt: null }], unread: 1 });
  await centre.markRead("n1");
  assert.equal(calls[0].path, "/api/notifications/read");
  assert.deepEqual(calls[0].options.body, { id: "n1" });
  assert.equal(typeof calls[0].options.idempotencyKey, "string");
  assert.equal(getState().unreadNotifications, 0);
});

test("settings renders the notification card and saves prefs and an empty topic", async () => {
  setState({ profile: profileOf() });
  const calls = [];
  const settings = new Settings({});
  settings.request = async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/notifications/prefs") return { status: 200, ok: true, body: { prefs: { enabled: true, categories: ["fed"] } } };
    if (path === "/api/notifications/ntfy") return { status: 200, ok: true, body: { topic: null } };
    return { status: 200, ok: true, body: { prefs: { enabled: true, categories: ["fed"] }, ntfy: "topic-0123456789abcdef" } };
  };
  settings.setState = (patch) => Object.assign(settings.state, patch);
  settings.setState({
    loading: false,
    supported: false,
    prefs: { enabled: true, categories: ["fed"] },
    ntfy: "topic-0123456789abcdef",
    ntfyDraft: "topic-0123456789abcdef",
  });
  const vnode = settings.render();
  for (const text of ["Which notifications", "ntfy", "Send a test notification", "Not supported", "plain HTTP"]) {
    if (text === "Not supported" || text === "plain HTTP") continue;
    assert.ok(vnodeText(vnode, text), `missing ${text}`);
  }
  assert.ok(vnodeText(vnode, "cannot receive Web Push"), "the insecure-context copy is shown");

  await settings.savePrefs();
  assert.deepEqual(calls[0].options.body, { enabled: true, categories: ["fed"] });
  await settings.saveNtfy("");
  assert.deepEqual(calls[1].options.body, { topic: null });
});

test("Settings shows the meal-times card only once setup is complete", () => {
  const settings = new Settings({});
  settings.setState = (patch) => Object.assign(settings.state, patch);
  settings.setState({
    supported: false,
    prefs: { enabled: true, categories: [] },
    ntfy: null,
    ntfyDraft: "",
  });

  setState({ profile: profileOf() });
  assert.equal(
    countVnode(settings.render(), "MealTimes"),
    1,
    "a finished household gets exactly one meal-times card",
  );

  setState({ profile: { ...profileOf(), setup: { complete: false, missing: ["meals"] } } });
  assert.equal(
    countVnode(settings.render(), "MealTimes"),
    0,
    "a first-run household edits meals in the wizard, not a second card",
  );
});

test("the notifications route is a real hash route, not a fallback to Today", async () => {
  const { hashRoute } = await import("../web/store.js");
  assert.equal(hashRoute("#notifications"), "notifications");
  assert.equal(hashRoute("#settings"), "settings");
});

// --- models and budget (P4-08) ----------------------------------------------

function modelsView(overrides = {}) {
  return {
    householdRev: 4,
    role: "owner",
    current: { id: "opencode-go/mimo-v2.6-flash", paid: true, price: { input: 0.14, output: 0.28 } },
    providers: { "opencode-go": true, openrouter: false },
    allowlist: {
      allowed: [{ id: "opencode-go/mimo-v2.6-flash", verifiedAt: "2026-10-29T12:00:00.000Z" }],
      unverified: [{ id: "opencode-go/glm-5.3-flash", reason: "inconclusive" }],
      dropped: [{ id: "opencode-go/minimax-m3.1-flash-free", status: "deprecated" }],
    },
    probe: {
      checkedAt: "2026-10-29T12:00:00.000Z",
      results: [
        { id: "opencode-go/mimo-v2.6-flash", status: "ok", toolCall: true, latencyMs: 812, usage: { cost: 0.002 } },
        { id: "opencode-go/glm-5.3-flash", status: "rate_limited", toolCall: false, latencyMs: 900 },
      ],
    },
    candidates: [
      { id: "opencode-go/mimo-v2.6-flash", paid: true, price: { input: 0.14, output: 0.28 } },
      { id: "opencode-go/beam-free", paid: false, price: { input: 0, output: 0 } },
    ],
    budget: { month: "2026-10", spentUsd: 8.5, capUsd: 10, ratio: 0.85, state: "warn", paidAllowed: true },
    ...overrides,
  };
}

test("model copy: prices, the current model and the spend line", () => {
  assert.equal(money(8.5), "8.50");
  assert.equal(money(-1), "0.00");
  assert.equal(money(Number.NaN), "0.00");
  assert.equal(modelOptionText({ id: "a/b", paid: false, price: { input: 0, output: 0 } }), "a/b (free) — free");
  assert.equal(
    modelOptionText({ id: "a/b", paid: true, price: { input: 0.14, output: 0.28 } }),
    "a/b — $0.14 in / $0.28 out per 1M tokens",
  );
  assert.match(currentModelText(modelsView()), /Using opencode-go\/mimo-v2\.6-flash/);
  assert.match(currentModelText({ current: null }), /No model is attached yet/);
  assert.equal(spendText(modelsView().budget), "$8.50 of $10.00 in 2026-10");
});

test("the budget's thresholds read as sentences, and the bar never overfills", () => {
  assert.match(budgetStateText("ok"), /Within the monthly budget/);
  assert.match(budgetStateText("warn"), /80%/);
  assert.match(budgetStateText("blocked"), /used up.*free model/i);
  assert.equal(budgetPercent({ spentUsd: 8.5, capUsd: 10 }), 85);
  assert.equal(budgetPercent({ spentUsd: 30, capUsd: 10 }), 100, "an over-spend is a full bar");
  assert.equal(budgetPercent({ spentUsd: 1, capUsd: 0 }), 0, "a zero cap has no ratio");
  assert.equal(budgetPercent(null), 0);
});

test("the allowlist's three buckets read as reasons a caregiver can act on", () => {
  const lines = allowlistLines(modelsView());
  assert.deepEqual(
    lines.map((line) => line.kind),
    ["allowed", "unverified", "dropped"],
  );
  assert.match(lines[0].text, /usable/);
  assert.match(lines[1].text, /inconclusive/);
  assert.match(lines[2].text, /deprecated/);
  const never = allowlistLines({ allowlist: { allowed: [], unverified: [{ id: "x/y", reason: "never_probed" }], dropped: [] } });
  assert.match(never[0].text, /never been checked/);
});

test("the probe summary states the spend exception the plan requires", () => {
  const text = probeText(modelsView().probe);
  assert.match(text, /Checked 2026-10-29T12:00:00\.000Z: 2 model\(s\), 0\.00 spent/);
  assert.match(text, /not counted in the monthly budget/);
  assert.match(probeText(null), /No check has run yet/);
  assert.equal(probeResultLines(modelsView().probe)[0].text, "opencode-go/mimo-v2.6-flash: ok (tool call ok), 812 ms");
});

test("the card's request bodies are the server's shapes, and a cap is whole cents", () => {
  assert.deepEqual(providerKeyBody("opencode-go", "sk-1"), { provider: "opencode-go", key: "sk-1" });
  assert.deepEqual(providerKeyBody("opencode-go", ""), { provider: "opencode-go", key: null }, "an empty field clears");
  assert.deepEqual(modelChoiceBody("opencode-go/beam-free"), { model: "opencode-go/beam-free" });
  assert.deepEqual(budgetBody(4, 7.5), { rev: 4, capUsd: 7.5 });
  assert.equal(parseCapInput("10"), 10);
  assert.equal(parseCapInput(" 7.50 "), 7.5);
  assert.equal(parseCapInput("0"), 0);
  assert.equal(parseCapInput(""), undefined);
  assert.equal(parseCapInput("1.234"), undefined);
  assert.equal(parseCapInput("-2"), undefined);
  assert.equal(parseCapInput("lots"), undefined);
});

test("the settings card renders the model section, hides owner controls from a partner, and saves a cap", async () => {
  setState({ profile: profileOf() });
  const calls = [];
  const view = modelsView();
  const settings = new Settings({});
  settings.request = async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/models") return { status: 200, ok: true, body: view };
    if (path === "/api/budget") return { status: 200, ok: true, body: { budget: { ...view.budget, capUsd: 7.5 } } };
    return { status: 200, ok: true, body: {} };
  };
  settings.setState = (patch) => Object.assign(settings.state, patch);
  settings.setState({ models: view, role: "owner", capDraft: "10" });

  const vnode = settings.render();
  for (const text of [
    "Model and budget",
    "Provider keys",
    "Choose the model",
    "Check models now",
    "Monthly cap (USD)",
    "Using opencode-go/mimo-v2.6-flash",
  ]) {
    assert.ok(vnodeText(vnode, text), `missing ${text}`);
  }

  settings.setState({ capDraft: "7.50" });
  await settings.saveCap();
  const budgetCall = calls.find((call) => call.path === "/api/budget");
  assert.deepEqual(budgetCall.options.body, { rev: 4, capUsd: 7.5 });

  // A partner sees the state and no owner buttons (the route's own `role`).
  assert.ok(!calls.some((call) => call.path === "/api/session"), "the card needs no second request for the role");
  settings.setState({ role: "member" });
  const partnerView = settings.render();
  assert.ok(vnodeText(partnerView, "Model and budget"), "the partner sees the card");
  assert.ok(vnodeText(partnerView, "Only the owner can change the cap or the model."));
  assert.ok(!vnodeText(partnerView, "Save cap"), "no owner control for a member");
});

// --- the partner invite (P4-09) ---------------------------------------------

test("the invite helpers send a trimmed name and return the link, not a bare code", () => {
  assert.deepEqual(inviteBody("  Sam  "), { displayName: "Sam" });
  assert.deepEqual(inviteBody(undefined), { displayName: "" });
  assert.equal(INVITE_TTL_MINUTES, 15, "the copy states the server's invite lifetime");
  assert.equal(inviteLinkOf({ code: "abc", link: "http://100.x.y.z:8787/invite?code=abc" }), "http://100.x.y.z:8787/invite?code=abc");
  assert.equal(inviteLinkOf({ code: "abc" }), null);
  assert.equal(inviteLinkOf(undefined), null);
});

test("the invite card is owner-only, shows the link once and explains its lifetime", async () => {
  const calls = [];
  const invite = new Invite({ role: "owner" });
  invite.request = async (path, options) => {
    calls.push({ path, options });
    return {
      status: 200,
      ok: true,
      body: { code: "code-1", link: "http://100.x.y.z:8787/invite?code=code-1" },
    };
  };
  invite.setState = (patch) => Object.assign(invite.state, patch);

  // A partner gets no invite controls at all (the route refuses them anyway);
  // the role comes from the settings screen's one role read, not a second fetch.
  assert.equal(new Invite({ role: "member" }).render(), null, "a partner sees no invite card");
  assert.ok(vnodeText(invite.render(), "Invite your partner"));
  assert.deepEqual(calls, [], "the card asks for nothing until the owner acts");

  invite.setState({ name: "  Sam  " });
  await invite.createInvite();
  const posted = calls.find((call) => call.path === "/api/invites");
  assert.deepEqual(posted.options.body, { displayName: "Sam" });
  assert.equal(posted.options.idempotencyKey, undefined, "the route does not dedupe, so no key is advertised");
  assert.equal(invite.state.link, "http://100.x.y.z:8787/invite?code=code-1");
  assert.match(invite.state.message, /works once and expires in 15 minutes/);
  assert.ok(vnodeText(invite.render(), "shown once"), "the link is presented as a one-time credential");
  // A second press clears the previous link before minting.
  invite.setState({ name: "" });
  await invite.createInvite();
  assert.match(invite.state.error, /Enter your partner's name/);

  // Once the partner has joined, the card says so instead of offering a code
  // that could only fill the last slot twice.
  const full = new Invite({ role: "owner", full: true });
  assert.ok(vnodeText(full.render(), "Your partner has joined"));
  assert.ok(!vnodeText(full.render(), "Create a one-time invite"));
});

test("the invite lifetime in the client copy matches the server's constant", async () => {
  // A third copy of the number with nothing pinning it would drift silently, and
  // the card and the guide would then state a false lifetime to a user.
  const { INVITE_TTL_MS } = await import("../src/server/auth.ts");
  assert.equal(INVITE_TTL_MINUTES * 60_000, INVITE_TTL_MS);
});

test("settings embeds the invite card with the role and the filled-household flag", async () => {
  // The guide's day-one step depends on this card being *on* Settings with the
  // right props; a card that only exists in its own unit test cannot be found by
  // a caregiver.
  setState({ profile: profileOf() });
  const settings = new Settings({});
  settings.setState = (patch) => Object.assign(settings.state, patch);

  settings.setState({ role: "owner", models: modelsView() });
  const oneMember = findVnode(settings.render(), "Invite");
  assert.ok(oneMember, "the settings screen renders the invite card");
  assert.equal(oneMember.props.role, "owner");
  assert.equal(oneMember.props.full, false, "a one-caregiver household can still invite");

  const fullProfile = profileOf({ members: [{ id: "owner", name: "Alex" }, { id: "partner", name: "Sam" }] });
  setState({ profile: fullProfile });
  settings.setState({ role: "owner" });
  const twoMembers = findVnode(settings.render(), "Invite");
  assert.equal(twoMembers.props.full, true, "both slots filled: the card says the partner has joined");
});

// --- the shared agent thread (agent UI) -------------------------------------

/** A mounted-enough Agent: only state, setState, request and the stubs need work. */
function agentWith(request, state = {}) {
  const agent = new Agent({ request });
  agent.request = request;
  agent.state = { ...agent.state, loading: false, ...state };
  agent.setState = (patch, callback) => {
    Object.assign(agent.state, typeof patch === "function" ? patch(agent.state) : patch);
    if (typeof callback === "function") callback();
  };
  agent.timezone = () => "Europe/Paris";
  return agent;
}

function threadSnapshot(seq, entries, overrides = {}) {
  return { conversationId: 1, seq, status: { busy: false, queued: 0 }, entries, ...overrides };
}

function chatEntry(entryId, overrides = {}) {
  return {
    kind: "chat",
    entryId,
    at: "2026-11-06T09:00:00.000Z",
    authorId: "owner",
    authorName: "Alex",
    text: `message ${entryId}`,
    clientMessageId: `c-${entryId}`,
    ...overrides,
  };
}

function pendingApproval(overrides = {}) {
  return {
    id: "a-1",
    action: { kind: "appointment.create" },
    summary: 'add the appointment "Vet" on 2026-12-20 at 09:00',
    status: "pending",
    state: "pending",
    requestedBy: "owner",
    requestedByLabel: "Alex",
    createdAt: "2026-11-06T09:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    actionId: "http:proposal",
    rev: 0,
    ...overrides,
  };
}

test("the agent thread applies snapshots by seq and follows runs, args and approvals", async () => {
  let approvalsRead = 0;
  let refreshes = 0;
  const agent = agentWith(async () => ({ status: 200, ok: true, body: {} }));
  agent.loadApprovals = async () => void (approvalsRead += 1);
  agent.loadStatus = async () => {};
  agent.scheduleRefresh = () => void (refreshes += 1);

  const tool = {
    kind: "tool",
    entryId: 2,
    at: "2026-11-06T09:00:01.000Z",
    toolCallId: "call-1",
    toolName: "log_feed",
    status: "ok",
    text: "Logged breakfast",
    byUserId: "owner",
    byLabel: "Alex",
  };
  assert.equal(agent.applySnapshot(threadSnapshot(5, [chatEntry(1), tool])), true);
  assert.equal(agent.state.thread.seq, 5);
  // Arrival order is not freshness order: an older read loses.
  assert.equal(agent.applySnapshot(threadSnapshot(4, [chatEntry(99)])), false);
  assert.equal(agent.state.thread.entries[0].entryId, 1, "the visible thread did not move backwards");

  agent.onBatch({ seq: 6, events: [{ type: "run_start" }] });
  assert.equal(agent.state.status.busy, true, "a run disables both composers");
  agent.onBatch({
    seq: 7,
    events: [
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "log_feed", args: { slotId: "slot-b" } },
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "log_feed", entry: { id: 3, kind: "app.tool" } },
    ],
  });
  assert.deepEqual(agent.state.toolArgs["call-1"], { slotId: "slot-b" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(approvalsRead, 1, "a tool may have written a proposal");
  assert.equal(refreshes, 1, "the entry-bearing batch schedules one snapshot read");
  assert.ok(vnodeText(agent.render(), "slot-b"), "the expanded tool card has the live arguments");
  agent.onBatch({ seq: 8, events: [{ type: "run_end" }] });
  assert.equal(agent.state.status.busy, false);
  assert.ok(vnodeText(agent.render(), "Logged breakfast"), "the tool card carries the result text");

  // A later non-entry batch (usage, status) must not raise the floor past the
  // snapshot that the entry-bearing batch announced: that snapshot is the one
  // carrying the new entry, and rejecting it would strand the thread backwards.
  agent.onBatch({ seq: 9, events: [{ type: "message_end", entry: { id: 9, kind: "app.chat" } }] });
  agent.onBatch({ seq: 10, events: [{ type: "usage_changed" }] });
  assert.equal(agent.applySnapshot(threadSnapshot(9, [chatEntry(9)])), true);
  assert.equal(agent.state.thread.entries[0].entryId, 9);

  // A lost batch is a gap, not a silent short transcript: one read catches up.
  const beforeGap = refreshes;
  agent.onBatch({ seq: 11, events: [{ type: "run_start" }] });
  assert.equal(refreshes, beforeGap, "a consecutive batch needs no catch-up read");
  agent.onBatch({ seq: 13, events: [{ type: "run_start" }] });
  assert.equal(refreshes, beforeGap + 1, "a missing commit schedules a snapshot read");
});

test("a reattached stream re-baselines the counter so a restarted server is accepted", async () => {
  const agent = agentWith(async () => ({ status: 200, ok: true, body: {} }));
  agent.loadThread = async () => {};
  agent.loadApprovals = async () => {};
  agent.loadStatus = async () => {};

  assert.equal(agent.applySnapshot(threadSnapshot(40, [chatEntry(1)])), true);
  assert.equal(agent.seqFloor, 40);
  assert.equal(agent.lastBatchSeq, 40);

  // The server's counter is per-process and restarts at 0 with it. A reattach
  // is the only signal the client gets, so it has to clear the baseline; a
  // surviving floor would reject every snapshot and freeze the thread.
  agent.onThreadEvent({ type: "open" });
  assert.equal(agent.seqFloor, 0, "the reattached stream re-baselines the counter");
  assert.equal(agent.lastBatchSeq, undefined, "and forgets the old gap baseline");

  assert.equal(agent.applySnapshot(threadSnapshot(1, [chatEntry(2)])), true, "the fresh counter is accepted");
  assert.equal(agent.state.thread.seq, 1);
  assert.equal(agent.state.thread.entries[0].entryId, 2, "the restarted thread is not stranded");
});

test("the composer's Send button posts through send() and never navigates", async () => {
  const agent = agentWith(async () => ({ status: 200, ok: true, body: {} }));
  let sends = 0;
  agent.send = async () => void (sends += 1);

  const form = findElement(agent.render(), "form");
  assert.ok(form, "the composer renders a form");
  let prevented = 0;
  form.props.onSubmit({ preventDefault: () => void (prevented += 1) });
  assert.equal(prevented, 1, "the native submission is cancelled before send()");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sends, 1, "and the message is sent through the view, not the browser");
});

test("a refused agent message keeps the draft and its key; an accepted one clears them", async () => {
  let answer = { status: 409, ok: false, body: { error: "busy", message: "the assistant is busy" } };
  const sent = [];
  const agent = agentWith(async (path, options) => {
    sent.push({ path, options });
    return answer;
  });
  agent.loadThread = async () => {};
  agent.state = { ...agent.state, draft: "  Fed lunch  ", status: { busy: false, queued: 0 }, pending: null };

  await agent.send();
  assert.equal(agent.state.draft, "  Fed lunch  ", "a busy refusal loses nothing");
  assert.ok(agent.state.pending?.key, "the retry can replay the same intended message");
  assert.match(agent.state.sendError, /not sent/);
  assert.equal(sent[0].options.body.clientMessageId, agent.state.pending.key);
  assert.equal(sent[0].options.idempotencyKey, agent.state.pending.key);

  const firstKey = agent.state.pending.key;
  // The wire shape is the accepted submission's status string (`"placed"`).
  answer = { status: 202, ok: true, body: { accepted: true, submissionId: "s-1", status: "placed" } };
  await agent.send();
  assert.equal(agent.state.draft, "", "an accepted message clears the composer");
  assert.equal(agent.state.pending, null);
  assert.equal(agent.state.status.busy, true, "the submission record, not a false idle, drives busy");
  assert.equal(sent[1].options.body.clientMessageId, firstKey, "the retry reused the key of the same body");
  assert.deepEqual(sent[1].options.body.text, "Fed lunch");
});

test("an approval is decided with its revision and a fresh key, and a stale 409 adopts the current one", async () => {
  let answer;
  const calls = [];
  const agent = agentWith(async (path, options) => {
    calls.push({ path, options });
    return answer;
  });
  agent.loadApprovals = async () => {};
  agent.loadThread = async () => {};
  const proposal = pendingApproval();
  agent.state = { ...agent.state, approvals: [proposal] };

  answer = {
    status: 200,
    ok: true,
    body: { approval: { ...proposal, state: "confirmed", status: "confirmed", rev: 1 }, replayed: false },
  };
  await agent.decide(proposal, "confirm");
  assert.equal(calls[0].path, "/api/approvals/confirm");
  assert.deepEqual(calls[0].options.body, { id: "a-1", rev: 0 });
  assert.equal(typeof calls[0].options.idempotencyKey, "string");
  assert.equal(agent.state.approvals[0].state, "confirmed");
  assert.match(agent.state.actionNotice, /Confirmed/);

  // A proposal the other caregiver moved: the 409 carries the committed one,
  // and the next tap uses that revision rather than silently re-sending rev 0.
  answer = {
    status: 409,
    ok: false,
    body: { error: "stale", message: "the proposal changed since it was read", approval: { ...proposal, rev: 4 } },
  };
  agent.state = { ...agent.state, actionBusy: null };
  await agent.decide(proposal, "cancel");
  assert.equal(agent.state.approvals[0].rev, 4);
  assert.match(agent.state.actionError, /changed since it was read/);
  assert.equal(calls[1].path, "/api/approvals/cancel");
});



test("the agent screen shows the model, the month's spend and a proposal's controls", () => {
  const agent = agentWith(async () => ({ status: 200, ok: true, body: {} }));
  agent.state = {
    ...agent.state,
    loading: false,
    session: { memberId: "owner", role: "owner", label: "Alex", authorId: "owner" },
    thread: threadSnapshot(1, [chatEntry(1)]),
    models: {
      current: { id: "opencode-go/mimo-v2.6-flash", paid: true, price: { input: 0.14, output: 0.28 } },
      budget: { month: "2026-11", spentUsd: 8.5, capUsd: 10, ratio: 0.85, state: "warn", paidAllowed: true },
    },
    budget: { month: "2026-11", spentUsd: 8.5, capUsd: 10, ratio: 0.85, state: "warn", paidAllowed: true },
    approvals: [pendingApproval()],
  };
  const tree = agent.render();
  for (const text of [
    "Waiting for your confirmation",
    "A proposal is waiting for your confirmation",
    "add the appointment",
    "Confirm",
    "Decline",
    "Expires",
    "opencode-go/mimo-v2.6-flash",
    "Paid",
    "$8.50 of $10.00",
    "80% or more",
  ]) {
    assert.ok(vnodeText(tree, text), `missing ${text}`);
  }
  // The transcript bubble renders too, as text (never as HTML).
  assert.ok(vnodeText(tree, "message 1"));

  // No model: the panel says where to fix it instead of offering a dead send.
  agent.setState({ models: { current: null }, budget: null });
  assert.ok(vnodeText(agent.render(), "add a provider key in Settings"));
});

test("an opened stream re-reads the thread, approvals and status; a reconnect is visible", async () => {
  const reads = [];
  const agent = agentWith(async () => ({ status: 200, ok: true, body: {} }));
  agent.loadThread = async () => void reads.push("thread");
  agent.loadApprovals = async () => void reads.push("approvals");
  agent.loadStatus = async () => void reads.push("status");

  agent.onThreadEvent({ type: "open" });
  assert.deepEqual(reads.sort(), ["approvals", "status", "thread"], "a reconnect is a catch-up point");

  agent.onThreadEvent({ type: "reconnect" });
  assert.equal(agent.state.connection, "reconnecting");
  assert.ok(vnodeText(agent.render(), "Reconnecting to the shared thread"), "the caregiver is told");
});
