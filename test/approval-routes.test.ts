// P4-07: the approval HTTP surface (PLAN §7.3, §7.4, §9.3, §14.2, §16 P4-07).
//
// What is covered:
//   * the read: a caregiver's proposals with their derived state, newest first;
//   * confirm: one commit that executes the stored action, answers the decided
//     proposal and (for an appointment) its derived view, and makes the record
//     visible on the calendar route;
//   * the refusals: a stale revision (409 with the current proposal), an expired
//     proposal, a declined one, a confirmed one that cannot be declined, an
//     unknown id (404), a reused key, and a target that moved;
//   * a double confirm is idempotent, and both caregivers may decide (a member
//     is not owner-gated for approvals);
//   * the shared mutation guards (session, origin, request header, JSON, key).

import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import {
  appointmentCancelAction,
  appointmentCreateAction,
  proposeApproval,
} from "../src/server/domain/approvals.ts";
import { CalendarDoc, parseCalendar } from "../src/server/domain/docs.ts";
import { cancelAppointment, createAppointment, updateAppointment } from "../src/server/domain/calendar.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { APPROVAL_TTL_MS } from "../src/shared/approvals.ts";
import type { Appointment } from "../src/shared/domain.ts";
import type { ApprovalView } from "../src/server/domain/approvals.ts";
import type { ThreadSnapshot } from "../src/shared/chat.ts";
import { startTestApp, type TestApp } from "./support/app.ts";

const context = BACKGROUND_CONTEXT;
/** 23:30Z is 30 October in Paris: the household's today starts there. */
const LATE = new Date("2026-10-29T23:30:00.000Z");

const FIELDS = {
  title: "Vet visit",
  localDate: "2026-12-20",
  timeLocal: "09:00",
  durationMin: 30,
  location: "Rue de Lyon",
};

type Fixture = TestApp & { clock: { now: number } };

async function startApprovalApp(now = LATE.getTime()): Promise<Fixture> {
  const clock = { now };
  const fixture = await startTestApp({
    prefix: "pupkeep-approval-routes-",
    now: () => clock.now,
    partner: true,
    timezone: "Europe/Paris",
  });
  return { ...fixture, clock };
}

interface MutateOptions {
  body?: Record<string, unknown>;
  key?: string;
  omitOrigin?: boolean;
  omitHeader?: boolean;
  omitKey?: boolean;
  contentType?: string;
}

async function post(
  fixture: Fixture,
  path: string,
  token: string,
  options: MutateOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": options.contentType ?? "application/json",
    ...(options.omitHeader ? {} : { [REQUEST_HEADER]: REQUEST_HEADER_VALUE }),
    Cookie: `${SESSION_COOKIE}=${token}`,
    ...(options.omitOrigin ? {} : { Origin: fixture.url }),
  };
  if (!options.omitKey && options.key !== undefined) headers["Idempotency-Key"] = options.key;
  return fetch(`${fixture.url}${path}`, { method: "POST", headers, body: JSON.stringify(options.body ?? {}) });
}

async function getApprovals(fixture: Fixture, token = fixture.cookies.owner): Promise<{ status: number; body: { approvals: ApprovalView[] } }> {
  const response = await fetch(`${fixture.url}/api/approvals`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
  return { status: response.status, body: (await response.json()) as { approvals: ApprovalView[] } };
}

async function appointments(fixture: Fixture): Promise<readonly Appointment[]> {
  const snapshot = await fixture.app.app.snapshot(CalendarDoc, context);
  const calendar = snapshot === undefined ? undefined : parseCalendar(snapshot);
  assert.ok(calendar, "app.calendar is readable");
  return calendar.appointments;
}

/** A proposal as the agent's tool would commit it, for the caregiver to decide. */
async function propose(fixture: Fixture, actionId = "tool:propose-1"): Promise<ApprovalView> {
  const outcome = await proposeApproval(fixture.app.app, context, {
    actor: async () => ({ id: "owner", label: "Alex" }),
    actionId,
    request: { kind: "appointment.create", ...FIELDS },
    intent: async (_tx, household) =>
      appointmentCreateAction(household, { ...FIELDS, reminderOffsetsMin: [1440, 60] }),
    now: new Date(fixture.clock.now),
  });
  assert.equal(outcome.kind, "proposed");
  if (outcome.kind !== "proposed") throw new Error("unreachable");
  return { ...outcome.approval, state: "pending" };
}

// --- the read ---------------------------------------------------------------

test("GET /api/approvals needs a session and answers an empty list", async () => {
  const fixture = await startApprovalApp();
  try {
    assert.equal((await fetch(`${fixture.url}/api/approvals`)).status, 401);
    const { status, body } = await getApprovals(fixture);
    assert.equal(status, 200);
    assert.deepEqual(body.approvals, []);
  } finally {
    await fixture.stop();
  }
});

test("a proposal is listed as pending with its expiry and its requester", async () => {
  const fixture = await startApprovalApp();
  try {
    const proposed = await propose(fixture);
    const { body } = await getApprovals(fixture);
    assert.equal(body.approvals.length, 1);
    assert.equal(body.approvals[0]!.state, "pending");
    assert.equal(body.approvals[0]!.requestedByLabel, "Alex");
    assert.equal(body.approvals[0]!.expiresAt, new Date(LATE.getTime() + APPROVAL_TTL_MS).toISOString());
    assert.equal(body.approvals[0]!.summary, 'add the appointment "Vet visit" on 2026-12-20 at 09:00');
    // Nothing has been booked: Gate G4's sentence at the HTTP surface.
    assert.deepEqual(await appointments(fixture), []);
    assert.equal(proposed.rev, 0);
  } finally {
    await fixture.stop();
  }
});

// --- confirm ----------------------------------------------------------------

test("confirming executes the stored action and answers the decided proposal", async () => {
  const fixture = await startApprovalApp();
  try {
    const proposed = await propose(fixture);
    const response = await post(fixture, "/api/approvals/confirm", fixture.cookies.partner!, {
      body: { id: proposed.id, rev: proposed.rev },
      key: "confirm-1",
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { approval: ApprovalView; replayed: boolean; appointment: { startsAt: string } };
    assert.equal(body.replayed, false);
    assert.equal(body.approval.state, "confirmed");
    assert.equal(body.approval.decidedByLabel, "Sam");
    assert.ok(body.approval.result);
    assert.equal(body.appointment.startsAt, "2026-12-20T08:00:00.000Z", "the derived instant, in the household zone");

    const committed = await appointments(fixture);
    assert.equal(committed.length, 1, "the appointment exists after the confirmation");
    assert.equal(committed[0]!.title, "Vet visit");
    assert.equal(committed[0]!.reminders.length, 2, "with its reminders armed");

    // The calendar route serves it, so the screen that was open can re-read.
    const listed = await fetch(`${fixture.url}/api/appointments?from=2026-12-01&to=2026-12-31`, {
      headers: { Cookie: `${SESSION_COOKIE}=${fixture.cookies.owner}` },
    });
    assert.equal(listed.status, 200);
    const calendar = (await listed.json()) as { appointments: { title: string }[] };
    assert.deepEqual(calendar.appointments.map((entry) => entry.title), ["Vet visit"]);

    // §9.3's thread entry reaches both caregivers over the thread route.
    const thread = await fetch(`${fixture.url}/api/agent/thread`, {
      headers: { Cookie: `${SESSION_COOKIE}=${fixture.cookies.owner}` },
    });
    const snapshot = (await thread.json()) as ThreadSnapshot;
    const entry = snapshot.entries.find((candidate) => candidate.kind === "approval");
    assert.ok(entry);
    assert.equal(entry.kind === "approval" ? entry.status : "", "confirmed");
    assert.equal(entry.kind === "approval" ? entry.byLabel : "", "Sam");
  } finally {
    await fixture.stop();
  }
});

test("a double confirm answers the stored result and executes nothing again", async () => {
  const fixture = await startApprovalApp();
  try {
    const proposed = await propose(fixture);
    const first = await post(fixture, "/api/approvals/confirm", fixture.cookies.owner, {
      body: { id: proposed.id, rev: proposed.rev },
      key: "confirm-1",
    });
    assert.equal(first.status, 200);

    const again = await post(fixture, "/api/approvals/confirm", fixture.cookies.partner!, {
      body: { id: proposed.id, rev: proposed.rev },
      key: "confirm-2",
    });
    assert.equal(again.status, 200, "a second tap is not an error");
    const body = (await again.json()) as { approval: ApprovalView; replayed: boolean };
    assert.equal(body.replayed, true);
    assert.equal(body.approval.state, "confirmed");
    assert.equal((await appointments(fixture)).length, 1, "the action ran once");

    const sameKey = await post(fixture, "/api/approvals/confirm", fixture.cookies.partner!, {
      body: { id: proposed.id, rev: proposed.rev },
      key: "confirm-2",
    });
    assert.equal(sameKey.status, 200);
    assert.equal(((await sameKey.json()) as { replayed: boolean }).replayed, true);
  } finally {
    await fixture.stop();
  }
});

test("a stale revision is a 409 that carries the current proposal", async () => {
  const fixture = await startApprovalApp();
  try {
    const proposed = await propose(fixture);
    const response = await post(fixture, "/api/approvals/confirm", fixture.cookies.owner, {
      body: { id: proposed.id, rev: 9 },
      key: "confirm-1",
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string; approval: ApprovalView };
    assert.equal(body.error, "stale");
    assert.equal(body.approval.rev, 0);
    assert.deepEqual(await appointments(fixture), [], "nothing was executed");
  } finally {
    await fixture.stop();
  }
});

test("an expired proposal is refused with its own error", async () => {
  const fixture = await startApprovalApp();
  try {
    const proposed = await propose(fixture);
    fixture.clock.now = LATE.getTime() + APPROVAL_TTL_MS;
    const { body: listed } = await getApprovals(fixture);
    assert.equal(listed.approvals[0]!.state, "expired", "the read derives the expiry");
    const response = await post(fixture, "/api/approvals/confirm", fixture.cookies.owner, {
      body: { id: proposed.id, rev: proposed.rev },
      key: "confirm-1",
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "expired");
    assert.deepEqual(await appointments(fixture), []);
  } finally {
    await fixture.stop();
  }
});

test("an unknown proposal is a 404, and a reused key is the one key conflict", async () => {
  const fixture = await startApprovalApp();
  try {
    const missing = await post(fixture, "/api/approvals/confirm", fixture.cookies.owner, {
      body: { id: "nope", rev: 0 },
      key: "confirm-1",
    });
    assert.equal(missing.status, 404);

    const proposed = await propose(fixture);
    const declined = await post(fixture, "/api/approvals/cancel", fixture.cookies.owner, {
      body: { id: proposed.id, rev: proposed.rev },
      key: "decide-1",
    });
    assert.equal(declined.status, 200);
    const reused = await post(fixture, "/api/approvals/cancel", fixture.cookies.owner, {
      body: { id: proposed.id, rev: proposed.rev + 1 },
      key: "decide-1",
    });
    assert.equal(reused.status, 409);
    assert.equal(((await reused.json()) as { error: string }).error, "idempotency_conflict");
  } finally {
    await fixture.stop();
  }
});

test("declining executes nothing, and confirming or declining afterwards is refused", async () => {
  const fixture = await startApprovalApp();
  try {
    const proposed = await propose(fixture);
    const declined = await post(fixture, "/api/approvals/cancel", fixture.cookies.partner!, {
      body: { id: proposed.id, rev: proposed.rev },
      key: "decide-1",
    });
    assert.equal(declined.status, 200);
    const body = (await declined.json()) as { approval: ApprovalView };
    assert.equal(body.approval.state, "cancelled");
    assert.equal(body.approval.result, undefined);
    assert.deepEqual(await appointments(fixture), [], "a declined proposal booked nothing");

    const confirmAfter = await post(fixture, "/api/approvals/confirm", fixture.cookies.owner, {
      body: { id: proposed.id, rev: proposed.rev },
      key: "confirm-1",
    });
    assert.equal(confirmAfter.status, 409);
    assert.equal(((await confirmAfter.json()) as { error: string }).error, "declined");

    // And a confirmed proposal cannot be declined afterwards.
    const other = await propose(fixture, "tool:propose-2");
    const confirmed = await post(fixture, "/api/approvals/confirm", fixture.cookies.owner, {
      body: { id: other.id, rev: other.rev },
      key: "confirm-2",
    });
    assert.equal(confirmed.status, 200);
    const declineAfter = await post(fixture, "/api/approvals/cancel", fixture.cookies.partner!, {
      body: { id: other.id, rev: other.rev },
      key: "decide-2",
    });
    assert.equal(declineAfter.status, 409);
    assert.equal(((await declineAfter.json()) as { error: string }).error, "already_confirmed");
  } finally {
    await fixture.stop();
  }
});

test("a proposal whose appointment moved is refused and stays pending", async () => {
  const fixture = await startApprovalApp();
  try {
    const created = await createAppointment(fixture.app.app, context, {
      actor: async () => ({ id: "owner", label: "Alex" }),
      actionId: "http:seed",
      fields: FIELDS,
      now: new Date(fixture.clock.now),
    });
    assert.equal(created.kind, "created");
    const appointment = created.kind === "created" ? created.appointment : undefined;
    assert.ok(appointment);

    const proposed = await proposeApproval(fixture.app.app, context, {
      actor: async () => ({ id: "owner", label: "Alex" }),
      actionId: "tool:cancel-1",
      request: { kind: "appointment.cancel", id: appointment.id },
      intent: async (tx) => appointmentCancelAction(tx, appointment.id),
      now: new Date(fixture.clock.now),
    });
    assert.equal(proposed.kind, "proposed");
    if (proposed.kind !== "proposed") return;

    const moved = await updateAppointment(fixture.app.app, context, {
      actor: async () => ({ id: "partner", label: "Sam" }),
      actionId: "http:other-edit",
      id: appointment.id,
      rev: appointment.rev,
      fields: { ...FIELDS, timeLocal: "11:00" },
      now: new Date(fixture.clock.now),
    });
    assert.equal(moved.kind, "changed");

    const response = await post(fixture, "/api/approvals/confirm", fixture.cookies.partner!, {
      body: { id: proposed.approval.id, rev: proposed.approval.rev },
      key: "confirm-1",
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, "target_changed");
    assert.match(body.message, /the appointment changed since the proposal was made/);
    const current = await appointments(fixture);
    assert.equal(current[0]!.timeLocal, "11:00", "the other caregiver's edit stands");
    assert.equal(current[0]!.status, "scheduled");
    const { body: listed } = await getApprovals(fixture);
    assert.equal(listed.approvals[0]!.state, "pending", "the caregiver can still decline it");
  } finally {
    await fixture.stop();
  }
});

test("a proposal against an already-cancelled appointment never becomes a dead card", async () => {
  const fixture = await startApprovalApp();
  try {
    const created = await createAppointment(fixture.app.app, context, {
      actor: async () => ({ id: "owner", label: "Alex" }),
      actionId: "http:seed",
      fields: FIELDS,
      now: new Date(fixture.clock.now),
    });
    const appointment = created.kind === "created" ? created.appointment : undefined;
    assert.ok(appointment);
    const cancelled = await cancelAppointment(fixture.app.app, context, {
      actor: async () => ({ id: "partner", label: "Sam" }),
      actionId: "http:other-cancel",
      id: appointment.id,
      rev: appointment.rev,
      now: new Date(fixture.clock.now),
    });
    assert.equal(cancelled.kind, "changed");

    // The domain refuses the proposal where the agent can still be told.
    await assert.rejects(
      proposeApproval(fixture.app.app, context, {
        actor: async () => ({ id: "owner", label: "Alex" }),
        actionId: "tool:cancel-dead",
        request: { kind: "appointment.cancel", id: appointment.id },
        intent: async (tx) => appointmentCancelAction(tx, appointment.id),
        now: new Date(fixture.clock.now),
      }),
      /already cancelled/,
    );
    const { body } = await getApprovals(fixture);
    assert.deepEqual(body.approvals, [], "no proposal for an action that could never run");
  } finally {
    await fixture.stop();
  }
});

test("declining an expired proposal still works, so the card can be cleared", async () => {
  const fixture = await startApprovalApp();
  try {
    const proposed = await propose(fixture);
    fixture.clock.now = LATE.getTime() + APPROVAL_TTL_MS;
    const declined = await post(fixture, "/api/approvals/cancel", fixture.cookies.partner!, {
      body: { id: proposed.id, rev: proposed.rev },
      key: "decide-expired",
    });
    assert.equal(declined.status, 200, "expiry blocks execution, not dismissal");
    const body = (await declined.json()) as { approval: ApprovalView };
    assert.equal(body.approval.state, "cancelled");
    assert.equal(body.approval.result, undefined);
    assert.deepEqual(await appointments(fixture), []);
  } finally {
    await fixture.stop();
  }
});

// --- the guards -------------------------------------------------------------

test("a decision needs a session, an origin, the request header, JSON and a key", async () => {
  const fixture = await startApprovalApp();
  try {
    const proposed = await propose(fixture);
    const body = { id: proposed.id, rev: proposed.rev };
    const unauthenticated = await fetch(`${fixture.url}/api/approvals/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [REQUEST_HEADER]: REQUEST_HEADER_VALUE },
      body: JSON.stringify(body),
    });
    assert.equal(unauthenticated.status, 401);

    const cases: Array<[string, MutateOptions]> = [
      ["no origin", { omitOrigin: true }],
      ["no request header", { omitHeader: true }],
      ["no key", { omitKey: true }],
      ["not JSON", { contentType: "text/plain" }],
    ];
    for (const [label, options] of cases) {
      const response = await post(fixture, "/api/approvals/confirm", fixture.cookies.owner, {
        body,
        key: "confirm-1",
        ...options,
      });
      assert.ok(response.status === 403 || response.status === 409 || response.status === 415, label);
      assert.notEqual(response.status, 200, label);
    }
    assert.deepEqual(await appointments(fixture), [], "no guard bypass executed the action");
  } finally {
    await fixture.stop();
  }
});
