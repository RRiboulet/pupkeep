// P4-07: `app.approvals`, proposing and deciding (PLAN §7.3, §7.4, §9.2, §9.3,
// §10.3, §12.1, §16 P4-07).
//
// Gate G4's sentence is the first test: **an approval changes nothing until it
// is confirmed.** Everything else pins the §9.3 contract around it:
//   * a proposal writes one record, one activity line, one notification per
//     caregiver and its key — and no care document;
//   * a confirmation is **one commit**: the stored action (with its own revision
//     check), the decision, the activity line, the notification and the
//     `app.approval` thread entry;
//   * a double confirm returns the stored result without executing again; a
//     declined proposal is refused; expiry is derived and refuses with a 409;
//   * a target that moved since the proposal is refused (nothing executed) and
//     the proposal stays pending;
//   * the document's own invariants: the complete stored action, the §9.2
//     pairing, decision fields iff decided, a result iff confirmed, retention.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { emptyConfig, type MemberRecord } from "../src/server/config.ts";
import { bootstrapSession } from "../src/server/domain/bootstrap.ts";
import {
  ActivityDoc,
  ApprovalsDoc,
  CalendarDoc,
  CommandsDoc,
  NotificationsDoc,
  parseApprovals,
  parseCalendar,
} from "../src/server/domain/docs.ts";
import {
  appointmentCancelAction,
  appointmentCreateAction,
  appointmentUpdateAction,
  cancelApproval,
  confirmApproval,
  feedingScheduleAction,
  proposeApproval,
  readApprovals,
} from "../src/server/domain/approvals.ts";
import {
  cancelAppointment,
  createAppointment,
  readCalendar,
  updateAppointment,
} from "../src/server/domain/calendar.ts";
import { readFeeding, updateMealSlots } from "../src/server/domain/feeding.ts";
import { readThreadSnapshot } from "../src/server/agent/thread.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import {
  APPROVAL_LIMIT,
  APPROVAL_SUMMARY_LIMIT,
  APPROVAL_TTL_MS,
  appendApprovals,
  approvalStateAt as stateAt,
  parseApproval,
  parseApprovalList,
} from "../src/shared/approvals.ts";
import type { Approval, ApprovalAction, MealSlot, NotificationIntent } from "../src/shared/domain.ts";
import { NOTIFICATION_TITLES } from "../src/shared/notifications.ts";

const context = BACKGROUND_CONTEXT;
/** 23:30Z on 29 October is already the 30th in Paris. */
const LATE = new Date("2026-10-29T23:30:00.000Z");
const TODAY = "2026-10-30";
/** Far enough ahead that both default reminder offsets are still in the future. */
const VISIT = { localDate: "2026-12-20", timeLocal: "09:00" };
const NOON = new Date("2026-10-29T12:00:00.000Z");

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "owner",
    role: "owner",
    displayName: "Alex",
    createdAt: "2026-10-29T10:00:00.000Z",
    sessions: [],
    ...overrides,
  };
}

const owner = member();
const partner = member({ id: "partner", role: "member", displayName: "Sam" });

const alex = async () => ({ id: "owner", label: "Alex" });
const sam = async () => ({ id: "partner", label: "Sam" });
const householdActor = async () => ({ id: null, label: "Household" });

const FIELDS = {
  title: "Vet visit",
  localDate: VISIT.localDate,
  timeLocal: VISIT.timeLocal,
  durationMin: 30,
  location: "Rue de Lyon",
};

const SLOTS: MealSlot[] = [
  { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true },
  { id: "slot-d", label: "Dinner", timeLocal: "18:00", active: true },
];

async function withApprovalHarness(run: (opened: OpenedHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-approvals-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
  try {
    await bootstrapSession(opened.harness, {
      config: { ...emptyConfig(), members: [owner, partner] },
      context,
      timezone: "Europe/Paris",
      now: () => LATE,
    });
    await run(opened);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

// --- the shape --------------------------------------------------------------

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    action: {
      kind: "appointment.create",
      fields: { ...FIELDS, reminderOffsetsMin: [1440, 60] },
    },
    summary: 'add the appointment "Vet visit" on 2026-12-20 at 09:00',
    status: "pending",
    requestedBy: "owner",
    requestedByLabel: "Alex",
    createdAt: NOON.toISOString(),
    expiresAt: new Date(NOON.getTime() + APPROVAL_TTL_MS).toISOString(),
    actionId: "tool:task-1",
    rev: 0,
    ...overrides,
  };
}

const confirmed = (result: Approval["result"]): Approval => ({
  ...approval({ status: "confirmed", rev: 1, ...(result !== undefined ? { result } : {}) }),
  decidedBy: "partner",
  decidedByLabel: "Sam",
  decidedAt: NOON.toISOString(),
});

test("an approval stores the complete action, the pairing and its decision fields", () => {
  assert.deepEqual(parseApproval(approval()), approval());
  assert.equal(parseApproval({ ...approval(), extra: true }), undefined, "an unknown key is refused");
  assert.equal(parseApproval({ ...approval(), status: "expired" }), undefined, "expiry is derived, not stored");
  assert.equal(parseApproval({ ...approval(), createdAt: "2026-02-30T00:00:00.000Z" }), undefined);
  assert.equal(
    parseApproval({ ...approval(), expiresAt: "2026-10-29T00:00:00.000Z" }),
    undefined,
    "a proposal cannot expire before it exists",
  );
  assert.equal(parseApproval({ ...approval(), actionId: "tool:task 1" }), undefined);
  assert.equal(parseApproval({ ...approval(), rev: -1 }), undefined);
  assert.equal(parseApproval({ ...approval(), summary: "" }), undefined);
  assert.equal(parseApproval({ ...approval(), summary: "two\nlines" }), undefined);
  assert.equal(
    parseApproval({ ...approval(), summary: "x".repeat(APPROVAL_SUMMARY_LIMIT + 1) }),
    undefined,
    "a summary is one bounded line",
  );
  // §9.2: a proposal with no requester id travels with the household label.
  assert.equal(parseApproval({ ...approval(), requestedBy: null }), undefined);
  assert.ok(parseApproval({ ...approval(), requestedBy: null, requestedByLabel: "Household" }));
  // The decision fields exist exactly when the record is decided…
  assert.equal(parseApproval({ ...approval(), decidedBy: "partner" }), undefined);
  assert.equal(parseApproval({ ...confirmed(undefined), decidedByLabel: undefined }), undefined);
  // …and a result exists exactly when something was executed.
  assert.equal(parseApproval(confirmed(undefined)), undefined, "a confirmed record carries its result");
  assert.equal(
    parseApproval({ ...approval(), result: { kind: "appointment.create", summary: "added it" } }),
    undefined,
    "a pending record has no result",
  );
  // A result names the kind its action was, and a create names its record.
  assert.equal(
    parseApproval({
      ...confirmed({ kind: "appointment.cancel", summary: "cancelled it" }),
    }),
    undefined,
    "the result kind and the action kind must agree",
  );
  assert.deepEqual(
    parseApproval(confirmed({ kind: "appointment.create", summary: "added it", appointmentId: "appointment-1" }))?.result,
    { kind: "appointment.create", summary: "added it", appointmentId: "appointment-1" },
  );
  // A stored create is complete: it always carries the offset list it fixed.
  assert.equal(
    parseApproval({
      ...approval(),
      action: { kind: "appointment.create", fields: FIELDS },
    }),
    undefined,
    "the stored create fixes its reminder offsets",
  );
  // An update keeps the absence of offsets (P4-01: absent means unchanged).
  assert.ok(
    parseApproval({
      ...approval(),
      action: { kind: "appointment.update", appointmentId: "appointment-1", rev: 3, fields: FIELDS },
    }),
  );
  assert.equal(
    parseApproval({
      ...approval(),
      action: { kind: "appointment.cancel", appointmentId: "appointment 1", rev: 0 },
    }),
    undefined,
  );
  assert.equal(
    parseApproval({ ...approval(), action: { kind: "puppy.delete" } }),
    undefined,
    "an action this build cannot execute is refused rather than stored",
  );
  assert.deepEqual(parseApprovalList([approval()]), [approval()]);
  assert.equal(parseApprovalList([approval(), approval()]), undefined, "ids are unique");
});

test("expiry is derived from the clock and the stored instant", () => {
  const pending = approval();
  assert.equal(stateAt(pending, NOON), "pending");
  assert.equal(stateAt(pending, new Date(Date.parse(pending.expiresAt) - 1)), "pending");
  assert.equal(stateAt(pending, new Date(Date.parse(pending.expiresAt))), "expired", "the instant itself is expired");
  assert.equal(stateAt(confirmed({ kind: "appointment.create", summary: "added it" }), new Date(9e15)), "confirmed");
});

test("retention never prunes a live proposal and keeps the newest terminal ones", () => {
  const live = approval({ id: "live", requestedBy: null, requestedByLabel: "Household", action: appointmentFixtureAction("live") });
  // The live record's `expiresAt` is NOON + 24h, so a clock inside the window
  // keeps it regardless of the cap.
  const terminal: Approval[] = [];
  for (let index = 0; index < APPROVAL_LIMIT + 5; index += 1) {
    terminal.push(
      confirmed({ kind: "appointment.create", summary: `added ${index}` }),
    );
  }
  const kept = appendApprovals([live, ...terminal], [], new Date(NOON.getTime() + 60_000), 10);
  assert.ok(kept.some((entry) => entry.id === "live"), "a pending proposal a caregiver can still decide is never pruned");
  const terminalKept = kept.filter((entry) => entry.status === "confirmed");
  assert.equal(terminalKept.length, 10, "terminal history is bounded");
  assert.equal(terminalKept.at(-1)?.result?.summary, `added ${APPROVAL_LIMIT + 4}`, "the newest are kept");
  // An *expired* proposal is not owed to anyone: it falls into the prunable half.
  const expired = approval({ id: "expired" });
  assert.equal(
    appendApprovals([expired], [], new Date(Date.parse(expired.expiresAt) + 1), 1).length,
    1,
    "the only record survives even as a prunable one",
  );
  assert.equal(
    appendApprovals([expired, ...terminal], [], new Date(Date.parse(expired.expiresAt) + 1), 1).some(
      (entry) => entry.id === "expired",
    ),
    false,
    "an expired proposal is dropped once the cap is reached",
  );
});

function appointmentFixtureAction(id: string): ApprovalAction {
  return { kind: "appointment.create", fields: { ...FIELDS, title: id, reminderOffsetsMin: [] } };
}

// --- the gate: a proposal changes nothing ------------------------------------

async function proposeCreate(
  opened: OpenedHarness,
  overrides: { actionId?: string; now?: Date; id?: string } = {},
) {
  return proposeApproval(opened.harness, context, {
    actor: alex,
    actionId: overrides.actionId ?? "tool:propose-1",
    request: { kind: "appointment.create", ...FIELDS },
    intent: async (_tx, household) => appointmentCreateAction(household, { ...FIELDS, reminderOffsetsMin: [1440, 60] }),
    now: overrides.now ?? LATE,
    ...(overrides.id !== undefined ? { id: overrides.id } : {}),
  });
}

test("a proposal changes nothing until it is confirmed", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const before = await harness.snapshot(ActivityDoc, context);
    const result = await proposeCreate(opened);
    assert.equal(result.kind, "proposed");

    // No care document moved.
    assert.deepEqual((await readCalendar(harness, context)).appointments, [], "the calendar is untouched");
    assert.equal((await readFeeding(harness, context)).rev, 0, "the meal schedule is untouched");

    // One record, one activity line, one notification per caregiver, one key.
    const approvals = await readApprovals(harness, context);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.status, "pending");
    assert.equal(approvals[0]!.rev, 0);
    assert.equal(approvals[0]!.requestedBy, "owner");
    assert.equal(approvals[0]!.requestedByLabel, "Alex");
    assert.equal(
      approvals[0]!.expiresAt,
      new Date(LATE.getTime() + APPROVAL_TTL_MS).toISOString(),
      "a proposal is usable for a day",
    );
    assert.equal(approvals[0]!.result, undefined);

    const activity = await harness.snapshot(ActivityDoc, context);
    assert.equal(activity!.entries.length, before!.entries.length + 1);
    assert.equal(activity!.entries.at(-1)!.kind, "approval.proposed");
    assert.match(activity!.entries.at(-1)!.summary, /Alex asked the household to confirm: add the appointment "Vet visit"/);

    const items = (await harness.snapshot(NotificationsDoc, context))!.items as NotificationIntent[];
    assert.deepEqual(
      items.map((item) => [item.category, item.userId, item.title]),
      [
        ["approval", "owner", NOTIFICATION_TITLES.approval],
        ["approval", "partner", NOTIFICATION_TITLES.approval],
      ],
      "both caregivers are told a decision is waiting, with category text only",
    );
    assert.match(items[0]!.body, /^Alex asks: add the appointment .*\. A caregiver has to confirm it before anything changes\.$/);
    assert.ok(
      (await harness.snapshot(CommandsDoc, context))!.entries.some((entry) => entry.key === "tool:propose-1"),
      "the proposal's key is committed with it",
    );
    // Nothing in the thread yet: the tool card shows the proposal, and §9.3's
    // entry is the *result*.
    assert.equal(
      (await readThreadSnapshot({ harness, context }, 0)).entries.filter((entry) => entry.kind === "approval").length,
      0,
    );
  });
});

test("confirming executes the stored action in one commit", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const proposed = await proposeCreate(opened);
    assert.equal(proposed.kind, "proposed");
    const id = proposed.kind === "proposed" ? proposed.approval.id : "";

    const outcome = await confirmApproval(harness, context, {
      actor: sam,
      actionId: "http:confirm-1",
      id,
      rev: 0,
      now: LATE,
    });
    assert.equal(outcome.kind, "confirmed");
    if (outcome.kind !== "confirmed") return;

    // The appointment exists with the household's zone, the fixed offsets and
    // its reminders armed. `createdBy` is the caregiver whose **commit** wrote
    // it — the one who confirmed — while the proposal records who asked.
    const calendar = await readCalendar(harness, context);
    assert.equal(calendar.appointments.length, 1);
    const appointment = calendar.appointments[0]!;
    assert.equal(appointment.title, "Vet visit");
    assert.equal(appointment.timezone, "Europe/Paris");
    assert.deepEqual(appointment.reminderOffsetsMin, [1440, 60]);
    assert.equal(appointment.reminders.length, 2, "the confirm's commit arms the reminders");
    assert.equal(appointment.createdBy, "partner", "the confirming commit's actor wrote the record");
    assert.equal(outcome.approval.requestedBy, "owner", "the proposal keeps who asked");
    assert.equal(appointment.actionId, "http:confirm-1");

    // The decision, with its result naming the record it wrote.
    assert.equal(outcome.approval.status, "confirmed");
    assert.equal(outcome.approval.rev, 1);
    assert.equal(outcome.approval.decidedBy, "partner");
    assert.equal(outcome.approval.decidedByLabel, "Sam");
    assert.deepEqual(outcome.approval.result, {
      kind: "appointment.create",
      summary: 'added the appointment "Vet visit"',
      appointmentId: appointment.id,
    });

    // One activity line, one notification per caregiver, §9.3's thread entry.
    const activity = await harness.snapshot(ActivityDoc, context);
    assert.equal(activity!.entries.at(-1)!.kind, "approval.confirmed");
    assert.equal(activity!.entries.at(-1)!.summary, 'Sam confirmed: added the appointment "Vet visit"');
    const items = (await harness.snapshot(NotificationsDoc, context))!.items as NotificationIntent[];
    assert.deepEqual(
      items.slice(-2).map((item) => [item.category, item.userId]),
      [
        ["approval", "owner"],
        ["approval", "partner"],
      ],
    );
    const snapshot = await readThreadSnapshot({ harness, context }, 0);
    const entry = snapshot.entries.find((candidate) => candidate.kind === "approval");
    assert.ok(entry, "the result is appended to the shared thread");
    assert.deepEqual(
      { ...entry },
      {
        kind: "approval",
        entryId: entry.entryId,
        at: LATE.toISOString(),
        approvalId: id,
        status: "confirmed",
        text: 'Sam confirmed: added the appointment "Vet visit"',
        byUserId: "partner",
        byLabel: "Sam",
      },
    );

    // The confirm's key is committed with the action (§7.3).
    const commands = (await harness.snapshot(CommandsDoc, context))!.entries;
    assert.ok(commands.some((record) => record.key === "http:confirm-1"));
    assert.equal(commands.filter((record) => record.key === "http:confirm-1").length, 1);
  });
});

test("a double confirm is idempotent, with the same key or a new one", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const proposed = await proposeCreate(opened);
    const id = proposed.kind === "proposed" ? proposed.approval.id : "";
    const first = await confirmApproval(harness, context, { actor: sam, actionId: "http:c1", id, rev: 0, now: LATE });
    assert.equal(first.kind, "confirmed");
    const result = first.kind === "confirmed" ? first.approval.result : undefined;

    const sameKey = await confirmApproval(harness, context, { actor: sam, actionId: "http:c1", id, rev: 0, now: LATE });
    assert.equal(sameKey.kind, "replayed", "the same key replays its recorded answer");
    const newKey = await confirmApproval(harness, context, { actor: sam, actionId: "http:c2", id, rev: 0, now: LATE });
    assert.equal(newKey.kind, "replayed", "a second tap answers the stored result, it does not execute again");
    assert.deepEqual(newKey.kind === "replayed" ? newKey.approval.result : undefined, result);
    assert.deepEqual(newKey.kind === "replayed" ? newKey.retiredTaskIds : ["x"], [], "nothing to retire");

    const calendar = await readCalendar(harness, context);
    assert.equal(calendar.appointments.length, 1, "the action ran once");
    assert.equal(calendar.appointments[0]!.reminders.length, 2, "and armed its reminders once");
  });
});

test("a stale proposal revision executes nothing", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const proposed = await proposeCreate(opened);
    const id = proposed.kind === "proposed" ? proposed.approval.id : "";
    const outcome = await confirmApproval(harness, context, { actor: sam, actionId: "http:c1", id, rev: 7, now: LATE });
    assert.equal(outcome.kind, "stale");
    assert.equal(outcome.kind === "stale" ? outcome.approval.rev : -1, 0, "the answer carries the current proposal");
    assert.deepEqual((await readCalendar(harness, context)).appointments, [], "nothing was executed");
    assert.equal((await readApprovals(harness, context))[0]!.status, "pending");
  });
});

test("an expired proposal is unusable rather than surprising", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const proposed = await proposeCreate(opened);
    const id = proposed.kind === "proposed" ? proposed.approval.id : "";
    const later = new Date(LATE.getTime() + APPROVAL_TTL_MS);

    const outcome = await confirmApproval(harness, context, { actor: sam, actionId: "http:c1", id, rev: 0, now: later });
    assert.equal(outcome.kind, "expired");
    assert.deepEqual((await readCalendar(harness, context)).appointments, [], "nothing was executed");
    // The stored record is still pending: expiry is a reading, not a write.
    assert.equal((await readApprovals(harness, context))[0]!.status, "pending");
    assert.equal(stateAt((await readApprovals(harness, context))[0]!, later), "expired", "the reader derives it");
  });
});

test("declining a proposal executes nothing, and confirming a declined one is refused", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const proposed = await proposeCreate(opened);
    const id = proposed.kind === "proposed" ? proposed.approval.id : "";

    const declined = await cancelApproval(harness, context, { actor: sam, actionId: "http:d1", id, rev: 0, now: LATE });
    assert.equal(declined.kind, "cancelled");
    if (declined.kind !== "cancelled") return;
    assert.equal(declined.approval.status, "cancelled");
    assert.equal(declined.approval.decidedBy, "partner");
    assert.equal(declined.approval.result, undefined, "a declined proposal executed nothing");
    assert.deepEqual((await readCalendar(harness, context)).appointments, []);

    const activity = await harness.snapshot(ActivityDoc, context);
    assert.equal(activity!.entries.at(-1)!.kind, "approval.cancelled");
    const entry = (await readThreadSnapshot({ harness, context }, 0)).entries.find(
      (candidate) => candidate.kind === "approval",
    );
    assert.equal(entry?.kind === "approval" ? entry.status : "", "cancelled");

    const again = await cancelApproval(harness, context, { actor: sam, actionId: "http:d2", id, rev: 0, now: LATE });
    assert.equal(again.kind, "replayed", "a double decline is idempotent");
    const confirm = await confirmApproval(harness, context, { actor: sam, actionId: "http:c1", id, rev: 0, now: LATE });
    assert.equal(confirm.kind, "declined", "a declined proposal cannot be confirmed later");
    assert.deepEqual((await readCalendar(harness, context)).appointments, []);
  });
});

test("declining an already-confirmed proposal is refused: the change is done", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const proposed = await proposeCreate(opened);
    const id = proposed.kind === "proposed" ? proposed.approval.id : "";
    assert.equal(
      (await confirmApproval(harness, context, { actor: sam, actionId: "http:c1", id, rev: 0, now: LATE })).kind,
      "confirmed",
    );
    const declined = await cancelApproval(harness, context, { actor: sam, actionId: "http:d1", id, rev: 0, now: LATE });
    assert.equal(declined.kind, "already-confirmed");
    assert.equal(declined.kind === "already-confirmed" ? declined.approval.status : "", "confirmed");
    assert.equal((await readCalendar(harness, context)).appointments.length, 1, "the change is still there");
  });
});

test("a target that moved since the proposal is refused and the proposal stays pending", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const created = await createAppointment(harness, context, {
      actor: alex,
      actionId: "http:seed",
      fields: FIELDS,
      now: LATE,
    });
    assert.equal(created.kind, "created");
    const appointment = created.kind === "created" ? created.appointment : undefined;
    assert.ok(appointment);

    const proposed = await proposeApproval(harness, context, {
      actor: alex,
      actionId: "tool:update-1",
      request: { kind: "appointment.update", id: appointment.id },
      intent: async (tx) => appointmentUpdateAction(tx, appointment.id, { timeLocal: "10:30" }),
      now: LATE,
    });
    assert.equal(proposed.kind, "proposed");
    const id = proposed.kind === "proposed" ? proposed.approval.id : "";
    assert.match(
      proposed.kind === "proposed" ? proposed.approval.summary : "",
      /change the appointment "Vet visit" from 2026-12-20 at 09:00 to "Vet visit" on 2026-12-20 at 10:30/,
    );

    // The other caregiver edits the same visit before anyone confirms.
    const moved = await updateAppointment(harness, context, {
      actor: sam,
      actionId: "http:other-edit",
      id: appointment.id,
      rev: appointment.rev,
      fields: { ...FIELDS, timeLocal: "11:00" },
      now: LATE,
    });
    assert.equal(moved.kind, "changed");

    const outcome = await confirmApproval(harness, context, { actor: sam, actionId: "http:c1", id, rev: 0, now: LATE });
    assert.equal(outcome.kind, "target-changed", "the stored action is not applied to a record it never saw");
    const calendar = await readCalendar(harness, context);
    assert.equal(calendar.appointments[0]!.timeLocal, "11:00", "the other caregiver's edit stands");
    assert.equal(calendar.appointments[0]!.rev, 1);
    assert.equal(
      (await readApprovals(harness, context))[0]!.status,
      "pending",
      "the proposal is still decidable (a caregiver can decline it)",
    );
  });
});

test("a cancel proposal executes the cancellation and retires the armed reminders", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const created = await createAppointment(harness, context, {
      actor: alex,
      actionId: "http:seed",
      fields: FIELDS,
      now: LATE,
    });
    const appointment = created.kind === "created" ? created.appointment : undefined;
    assert.ok(appointment);
    assert.equal(appointment.reminders.length, 2);

    const proposed = await proposeApproval(harness, context, {
      actor: sam,
      actionId: "tool:cancel-1",
      request: { kind: "appointment.cancel", id: appointment.id },
      intent: async (tx) => appointmentCancelAction(tx, appointment.id),
      now: LATE,
    });
    const id = proposed.kind === "proposed" ? proposed.approval.id : "";
    assert.equal(
      proposed.kind === "proposed" ? proposed.approval.summary : "",
      'cancel the appointment "Vet visit" on 2026-12-20 at 09:00',
    );
    // Still scheduled until the human confirms.
    assert.equal((await readCalendar(harness, context)).appointments[0]!.status, "scheduled");

    const outcome = await confirmApproval(harness, context, { actor: alex, actionId: "http:c1", id, rev: 0, now: LATE });
    assert.equal(outcome.kind, "confirmed");
    if (outcome.kind !== "confirmed") return;
    assert.deepEqual(
      [...outcome.retiredTaskIds].sort((a, b) => a - b),
      appointment.reminders.map((ref) => ref.taskId).sort((a, b) => a - b),
      "the old reminder tasks travel back for the caller to retire",
    );
    const cancelled = (await readCalendar(harness, context)).appointments[0]!;
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(cancelled.reminders, []);
    assert.equal(cancelled.rev, 1);
  });
});

test("a meal-schedule proposal writes the stored list, and a moved schedule is refused", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const seeded = await updateMealSlots(harness, context, {
      actor: alex,
      actionId: "http:seed-slots",
      rev: 0,
      slots: [{ id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true }],
      now: LATE,
    });
    assert.equal(seeded, "updated");
    assert.equal((await readFeeding(harness, context)).rev, 1);

    const proposed = await proposeApproval(harness, context, {
      actor: alex,
      actionId: "tool:slots-1",
      request: { kind: "feeding.schedule", slots: SLOTS },
      intent: async (tx) => feedingScheduleAction(tx, SLOTS),
      now: LATE,
    });
    assert.equal(proposed.kind, "proposed");
    const id = proposed.kind === "proposed" ? proposed.approval.id : "";
    assert.deepEqual(
      proposed.kind === "proposed" ? proposed.approval.action : undefined,
      { kind: "feeding.schedule", rev: 1, slots: SLOTS },
      "the proposal captured the revision it was read at",
    );
    assert.equal(
      proposed.kind === "proposed" ? proposed.approval.summary : "",
      'change the meal schedule to 2 meals: "Breakfast" at 07:00, "Dinner" at 18:00',
    );
    assert.equal((await readFeeding(harness, context)).slots.length, 1, "nothing changed yet");

    const outcome = await confirmApproval(harness, context, { actor: sam, actionId: "http:c1", id, rev: 0, now: LATE });
    assert.equal(outcome.kind, "confirmed");
    const schedule = await readFeeding(harness, context);
    assert.equal(schedule.rev, 2);
    assert.deepEqual(schedule.slots, SLOTS);
    assert.equal(
      outcome.kind === "confirmed" ? outcome.approval.result?.summary : "",
      "changed the meal schedule (2 meals)",
    );

    // A second proposal whose schedule moved before confirmation: refused.
    const second = await proposeApproval(harness, context, {
      actor: alex,
      actionId: "tool:slots-2",
      request: { kind: "feeding.schedule", slots: SLOTS },
      intent: async (tx) => feedingScheduleAction(tx, SLOTS),
      now: LATE,
    });
    const secondId = second.kind === "proposed" ? second.approval.id : "";
    assert.equal(
      await updateMealSlots(harness, context, {
        actor: sam,
        actionId: "http:other-slots",
        rev: 2,
        slots: [{ id: "slot-b", label: "Breakfast", timeLocal: "06:30", active: true }],
        now: LATE,
      }),
      "updated",
    );
    const refused = await confirmApproval(harness, context, {
      actor: sam,
      actionId: "http:c2",
      id: secondId,
      rev: 0,
      now: LATE,
    });
    assert.equal(refused.kind, "target-changed");
    assert.equal(refused.kind === "target-changed" ? refused.message : "", "the meal schedule changed since the proposal was made; nothing was executed");
    assert.equal((await readFeeding(harness, context)).slots[0]!.timeLocal, "06:30", "the other save stands");
  });
});

test("a proposal is idempotent on its key, and a refused shape does not burn it", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const first = await proposeCreate(opened);
    assert.equal(first.kind, "proposed");
    const second = await proposeCreate(opened);
    assert.equal(second.kind, "replayed");
    assert.equal(
      first.kind === "proposed" && second.kind === "replayed" ? second.approval.id === first.approval.id : false,
      true,
    );
    assert.equal((await readApprovals(harness, context)).length, 1, "one key, one proposal");
    assert.equal((await harness.snapshot(NotificationsDoc, context))!.items.length, 2, "and one notification each");

    const collision = await proposeApproval(harness, context, {
      actor: alex,
      actionId: "tool:propose-1",
      request: { kind: "appointment.create", ...FIELDS, title: "Groomer" },
      intent: async (_tx, household) => appointmentCreateAction(household, { ...FIELDS, title: "Groomer" }),
      now: LATE,
    });
    assert.equal(collision.kind, "key-conflict", "one key cannot honestly describe two proposals");

    // A refused action rolls the whole commit back, including its key.
    await assert.rejects(
      proposeApproval(harness, context, {
        actor: alex,
        actionId: "tool:propose-bad",
        request: { kind: "appointment.create", title: "" },
        intent: async (_tx, household) => appointmentCreateAction(household, { ...FIELDS, title: "" }),
        now: LATE,
      }),
      /an appointment needs/,
    );
    assert.equal(
      (await harness.snapshot(CommandsDoc, context))!.entries.some((entry) => entry.key === "tool:propose-bad"),
      false,
      "a refused shape does not burn its key",
    );
    const retried = await proposeApproval(harness, context, {
      actor: alex,
      actionId: "tool:propose-bad",
      request: { kind: "appointment.create", title: "Groomer" },
      intent: async (_tx, household) => appointmentCreateAction(household, { ...FIELDS, title: "Groomer" }),
      now: LATE,
    });
    assert.equal(retried.kind, "proposed");
  });
});

test("a proposal with no identifiable speaker travels as the household fallback", async () => {
  await withApprovalHarness(async (opened) => {
    const outcome = await proposeApproval(opened.harness, context, {
      actor: householdActor,
      actionId: "tool:anon-1",
      request: { kind: "appointment.create", ...FIELDS },
      intent: async (_tx, household) => appointmentCreateAction(household, { ...FIELDS, reminderOffsetsMin: [] }),
      now: LATE,
    });
    assert.equal(outcome.kind, "proposed");
    if (outcome.kind !== "proposed") return;
    assert.equal(outcome.approval.requestedBy, null);
    assert.equal(outcome.approval.requestedByLabel, "Household");
    const items = (await opened.harness.snapshot(NotificationsDoc, context))!.items as NotificationIntent[];
    assert.match(items[1]!.body, /^Household asks: /);
  });
});

test("a proposal against a record that can no longer change is refused at propose time", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const created = await createAppointment(harness, context, {
      actor: alex,
      actionId: "http:seed",
      fields: FIELDS,
      now: LATE,
    });
    const appointment = created.kind === "created" ? created.appointment : undefined;
    assert.ok(appointment);
    const cancelled = await cancelAppointment(harness, context, {
      actor: sam,
      actionId: "http:other-cancel",
      id: appointment.id,
      rev: appointment.rev,
      now: LATE,
    });
    assert.equal(cancelled.kind, "changed");

    // A cancellation proposal for a cancelled visit would be a card that can
    // never execute, so it is refused where the agent can still be told.
    await assert.rejects(
      proposeApproval(harness, context, {
        actor: alex,
        actionId: "tool:cancel-dead",
        request: { kind: "appointment.cancel", id: appointment.id },
        intent: async (tx) => appointmentCancelAction(tx, appointment.id),
        now: LATE,
      }),
      /that appointment is already cancelled/,
    );
    await assert.rejects(
      proposeApproval(harness, context, {
        actor: alex,
        actionId: "tool:update-dead",
        request: { kind: "appointment.update", id: appointment.id },
        intent: async (tx) => appointmentUpdateAction(tx, appointment.id, { timeLocal: "10:30" }),
        now: LATE,
      }),
      /that appointment is already cancelled/,
    );
    assert.deepEqual(await readApprovals(harness, context), [], "no dead card was stored");
  });
});

test("an expired proposal can still be declined: expiry blocks execution, not dismissal", async () => {
  await withApprovalHarness(async (opened) => {
    const { harness } = opened;
    const proposed = await proposeCreate(opened);
    const id = proposed.kind === "proposed" ? proposed.approval.id : "";
    const later = new Date(LATE.getTime() + APPROVAL_TTL_MS);

    const confirm = await confirmApproval(harness, context, { actor: sam, actionId: "http:c1", id, rev: 0, now: later });
    assert.equal(confirm.kind, "expired", "expired cannot execute");
    const declined = await cancelApproval(harness, context, { actor: sam, actionId: "http:d1", id, rev: 0, now: later });
    assert.equal(declined.kind, "cancelled", "the expired card leaves the list with a decision on it");
    assert.equal((await readApprovals(harness, context))[0]!.status, "cancelled");
    assert.deepEqual((await readCalendar(harness, context)).appointments, [], "nothing was executed");
  });
});

// --- the document over a restart --------------------------------------------

test("the approval list survives a reopen, and a malformed one refuses boot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-approvals-reopen-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const config = { ...emptyConfig(), members: [owner, partner] };
  try {
    const first = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
    await bootstrapSession(first.harness, { config, context, timezone: "Europe/Paris", now: () => LATE });
    const proposed = await proposeApproval(first.harness, context, {
      actor: alex,
      actionId: "tool:propose-1",
      request: { kind: "appointment.create", ...FIELDS },
      intent: async (_tx, household) => appointmentCreateAction(household, { ...FIELDS, reminderOffsetsMin: [] }),
      now: LATE,
    });
    assert.equal(proposed.kind, "proposed");
    await first.harness.close(context);

    const second = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
    try {
      const reopened = await bootstrapSession(second.harness, { config, context, now: () => LATE });
      assert.deepEqual(reopened.docsCreated, [], "a second boot repairs nothing it already has");
      const approvals = await readApprovals(second.harness, context);
      assert.equal(approvals.length, 1, "the proposal survived the restart");
      assert.equal(approvals[0]!.status, "pending");

      // A document this build cannot read fails boot rather than being reset.
      await second.harness.commit(async (tx) => {
        const draft = await tx.doc(ApprovalsDoc);
        draft.approvals = [{ ...draft.approvals[0]!, status: "maybe" as never }];
      }, context);
      await assert.rejects(
        bootstrapSession(second.harness, { config, context, now: () => LATE }),
        /app.approvals/,
      );
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- bootstrap --------------------------------------------------------------

test("boot creates the approvals document and repairs a database that predates it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-approvals-boot-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const config = { ...emptyConfig(), members: [owner] };
  try {
    const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
    try {
      const first = await bootstrapSession(opened.harness, { config, context, timezone: "Europe/Paris", now: () => LATE });
      assert.ok(first.docsCreated.includes("app.approvals"));
      const document = await opened.harness.snapshot(ApprovalsDoc, context);
      assert.deepEqual(document, { schemaVersion: 1, approvals: [], createdAt: LATE.toISOString() });
      assert.deepEqual(parseApprovals(document), document);

      // A database from before P4-07: the document is missing, everything else
      // is there. The next boot re-creates it instead of failing.
      await opened.harness.commit(async (tx) => {
        await tx.retireDoc(ApprovalsDoc);
      }, context);
      assert.equal(await opened.harness.snapshot(ApprovalsDoc, context), undefined);
      const second = await bootstrapSession(opened.harness, { config, context, now: () => LATE });
      assert.deepEqual(second.docsCreated, ["app.approvals"]);
      assert.deepEqual(parseApprovals(await opened.harness.snapshot(ApprovalsDoc, context)), {
        schemaVersion: 1,
        approvals: [],
        createdAt: LATE.toISOString(),
      });
      // The calendar is unaffected by the repair, and vice versa.
      assert.ok(parseCalendar(await opened.harness.snapshot(CalendarDoc, context)));
    } finally {
      await opened.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
