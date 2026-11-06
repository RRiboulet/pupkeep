// P4-02: the appointment HTTP surface (PLAN §7.3, §7.4, §8.4, §10.1, §13.1,
// §14.2, §16 P4-02).
//
// What is covered:
//   * the ranged read: the household's zone and today, the default range, the
//     derived instants, cancelled history included, and a refused bad range;
//   * create: one commit, the household default reminder offsets, the zone
//     snapshot, the DST-correct derived instant, replay, key conflict and a
//     refused shape writing nothing;
//   * update and cancel: the revision echo, a stale 409 carrying the current
//     appointment, a missing id as 404, and cancellation as a state change that
//     stays readable;
//   * the next-appointment read for Today;
//   * the shared mutation guards (session, origin, request header, JSON, key)
//     and a partner's access.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import { ActivityDoc, CalendarDoc, CommandsDoc, parseCalendar } from "../src/server/domain/docs.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { APPOINTMENT_RULE } from "../src/shared/calendar.ts";
import type { Appointment } from "../src/shared/domain.ts";
import type { AppointmentView, CalendarView } from "../src/server/domain/calendar.ts";
import { startTestApp, type TestApp } from "./support/app.ts";

const context = BACKGROUND_CONTEXT;
/** 23:30Z is already 30 October in Paris: the default range starts there. */
const LATE = new Date("2026-10-29T23:30:00.000Z");
const TODAY = "2026-10-30";

type Fixture = TestApp;

function startCalendarApp(): Promise<Fixture> {
  return startTestApp({ prefix: "pupkeep-calendar-routes-", now: LATE.getTime(), timezone: "Europe/Paris" });
}

interface MutateOptions {
  body?: Record<string, unknown>;
  key?: string;
  omitOrigin?: boolean;
  omitHeader?: boolean;
  omitKey?: boolean;
  contentType?: string;
}

async function post(fixture: Fixture, path: string, token: string, options: MutateOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": options.contentType ?? "application/json",
    ...(options.omitHeader ? {} : { [REQUEST_HEADER]: REQUEST_HEADER_VALUE }),
    Cookie: `${SESSION_COOKIE}=${token}`,
    ...(options.omitOrigin ? {} : { Origin: fixture.url }),
  };
  if (!options.omitKey && options.key !== undefined) headers["Idempotency-Key"] = options.key;
  return fetch(`${fixture.url}${path}`, { method: "POST", headers, body: JSON.stringify(options.body ?? {}) });
}

async function get(
  fixture: Fixture,
  path: string,
  token = fixture.cookies.owner,
): Promise<{ status: number; body: CalendarView; headers: Headers }> {
  const response = await fetch(`${fixture.url}${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
  return { status: response.status, body: (await response.json()) as CalendarView, headers: response.headers };
}

function fields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Vet visit",
    localDate: "2026-12-20",
    timeLocal: "09:00",
    durationMin: 30,
    location: "Rue de Lyon",
    ...overrides,
  };
}

interface CreateAnswer {
  appointment: AppointmentView;
  replayed: boolean;
}

interface ChangeAnswer {
  appointment: AppointmentView;
  replayed: boolean;
}

async function committed(fixture: Fixture): Promise<readonly Appointment[]> {
  const snapshot = await fixture.app.app.snapshot(CalendarDoc, context);
  const calendar = snapshot === undefined ? undefined : parseCalendar(snapshot);
  assert.ok(calendar, "app.calendar is readable");
  return calendar.appointments;
}

// --- the reads --------------------------------------------------------------

test("GET /api/appointments answers the empty default range and needs a session", async () => {
  const fixture = await startCalendarApp();
  try {
    assert.equal((await fetch(`${fixture.url}/api/appointments`)).status, 401);

    const { status, body, headers } = await get(fixture, "/api/appointments");
    assert.equal(status, 200);
    assert.equal(headers.get("cache-control"), "no-store");
    assert.equal(body.timezone, "Europe/Paris");
    assert.equal(body.today, TODAY);
    assert.equal(body.from, TODAY, "the default range starts today");
    assert.equal(body.to, "2027-01-28", "…and spans 90 days");
    assert.deepEqual(body.appointments, []);
    assert.equal(body.next, null);
    assert.deepEqual(body.defaultReminderOffsetsMin, [1440, 60], "the create form starts from the setting");
  } finally {
    await fixture.stop();
  }
});

test("creating an appointment answers the derived instants, the zone snapshot and the defaults", async () => {
  const fixture = await startCalendarApp();
  try {
    const created = await post(fixture, "/api/appointments", fixture.cookies.owner, {
      key: "a-1",
      body: fields({ title: "  Vet visit " }),
    });
    assert.equal(created.status, 200);
    const answer = (await created.json()) as CreateAnswer;
    assert.equal(answer.replayed, false);
    assert.equal(answer.appointment.localDate, "2026-12-20");
    assert.equal(answer.appointment.timeLocal, "09:00");
    assert.equal(answer.appointment.timezone, "Europe/Paris", "the household zone at the write");
    // Booked in October (CEST, +2) for December (CET, +1): the wall clock, not
    // the booking-day offset, decides the instant.
    assert.equal(answer.appointment.startsAt, "2026-12-20T08:00:00.000Z");
    assert.equal(answer.appointment.endsAt, "2026-12-20T08:30:00.000Z", "start plus the stored duration");
    assert.equal(answer.appointment.title, "Vet visit");
    assert.equal(answer.appointment.location, "Rue de Lyon");
    assert.equal(answer.appointment.rev, 0);
    assert.equal(answer.appointment.status, "scheduled");
    assert.deepEqual(answer.appointment.reminderOffsetsMin, [1440, 60], "the household default");
    assert.equal(answer.appointment.reminders.length, 2, "both default offsets are ahead of the clock");
    assert.deepEqual(
      answer.appointment.reminders.map((ref) => ref.offsetMin),
      [1440, 60],
      "one task per offset, in the stored order",
    );
    assert.ok(answer.appointment.reminders.every((ref) => ref.taskId > 0));
    assert.equal(answer.appointment.createdByLabel, "Alex");

    const { body } = await get(fixture, "/api/appointments");
    assert.equal(body.appointments.length, 1);
    assert.equal(body.appointments[0]?.id, answer.appointment.id);
    assert.equal(body.next?.id, answer.appointment.id);

    const activity = await fixture.app.app.snapshot(ActivityDoc, context);
    assert.equal(activity?.entries.at(-1)?.kind, "appointment.created");
    assert.equal(activity?.entries.at(-1)?.summary, 'Alex added the appointment "Vet visit"');
    const commands = (await fixture.app.app.snapshot(CommandsDoc, context))?.entries ?? [];
    assert.ok(commands.some((entry) => entry.key === "http:a-1"), "the create committed its key");
  } finally {
    await fixture.stop();
  }
});

test("a repeated key replays, a different body is the key conflict, and a refused shape writes nothing", async () => {
  const fixture = await startCalendarApp();
  try {
    const first = await post(fixture, "/api/appointments", fixture.cookies.owner, { key: "a-1", body: fields() });
    assert.equal(first.status, 200);
    const recorded = ((await first.json()) as CreateAnswer).appointment;

    const replay = await post(fixture, "/api/appointments", fixture.cookies.owner, {
      key: "a-1",
      body: fields({ title: " Vet visit " }),
    });
    assert.equal(replay.status, 200);
    const replayed = (await replay.json()) as CreateAnswer;
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.appointment.id, recorded.id);
    assert.equal((await committed(fixture)).length, 1);

    const conflict = await post(fixture, "/api/appointments", fixture.cookies.owner, {
      key: "a-1",
      body: fields({ title: "Groomer" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: string }).error, "idempotency_conflict");

    const refused = await post(fixture, "/api/appointments", fixture.cookies.owner, {
      key: "a-bad",
      body: fields({ durationMin: 1 }),
    });
    assert.equal(refused.status, 409);
    const refusal = (await refused.json()) as { error: string };
    assert.equal(refusal.error, APPOINTMENT_RULE);
    assert.equal((await committed(fixture)).length, 1, "a refused appointment writes nothing");
    const commands = (await fixture.app.app.snapshot(CommandsDoc, context))?.entries ?? [];
    assert.equal(commands.some((entry) => entry.key === "http:a-bad"), false, "a refusal does not burn its key");
  } finally {
    await fixture.stop();
  }
});

test("the range filters by household-local date and includes cancelled history", async () => {
  const fixture = await startCalendarApp();
  try {
    const create = async (key: string, date: string) => {
      const response = await post(fixture, "/api/appointments", fixture.cookies.owner, {
        key,
        body: fields({ localDate: date, title: `Visit ${date}` }),
      });
      assert.equal(response.status, 200);
      return ((await response.json()) as CreateAnswer).appointment;
    };
    const november = await create("a-nov", "2026-11-20");
    await create("a-dec", "2026-12-20");
    await create("a-jan", "2027-01-10");

    const cancelled = await post(fixture, "/api/appointments/cancel", fixture.cookies.owner, {
      key: "a-cancel",
      body: { id: november.id, rev: november.rev },
    });
    assert.equal(cancelled.status, 200);

    const month = await get(fixture, "/api/appointments?from=2026-11-01&to=2026-11-30");
    assert.equal(month.status, 200);
    assert.equal(month.body.appointments.length, 1, "only November's record");
    assert.equal(month.body.appointments[0]?.localDate, "2026-11-20");
    assert.equal(month.body.appointments[0]?.status, "cancelled", "history stays readable");

    const quarter = await get(fixture, "/api/appointments");
    assert.deepEqual(
      quarter.body.appointments.map((entry) => entry.localDate),
      ["2026-11-20", "2026-12-20", "2027-01-10"],
      "sorted by the derived instant",
    );

    assert.equal((await get(fixture, "/api/appointments?from=2026-12-01&to=2026-11-01")).status, 409);
    assert.equal((await get(fixture, "/api/appointments?from=2026-13-01")).status, 409);
    assert.equal((await get(fixture, "/api/appointments?from=2020-01-01&to=2026-01-01")).status, 409);
  } finally {
    await fixture.stop();
  }
});

test("GET /api/appointments/next answers the earliest scheduled appointment", async () => {
  const fixture = await startCalendarApp();
  try {
    const create = async (key: string, date: string, time: string) => {
      const response = await post(fixture, "/api/appointments", fixture.cookies.owner, {
        key,
        body: fields({ localDate: date, timeLocal: time, title: `Visit ${date}` }),
      });
      assert.equal(response.status, 200);
      return ((await response.json()) as CreateAnswer).appointment;
    };
    const past = await create("a-past", "2026-10-01", "09:00");
    const later = await create("a-later", "2027-02-01", "09:00");
    const sooner = await create("a-sooner", "2026-11-20", "09:00");

    const next = await fetch(`${fixture.url}/api/appointments/next`, {
      headers: { Cookie: `${SESSION_COOKIE}=${fixture.cookies.owner}` },
    });
    assert.equal(next.status, 200);
    const body = (await next.json()) as { today: string; timezone: string; next: AppointmentView | null };
    assert.equal(body.today, TODAY);
    assert.equal(body.timezone, "Europe/Paris");
    assert.equal(body.next?.id, sooner.id, "the past visit is not upcoming");

    await post(fixture, "/api/appointments/cancel", fixture.cookies.owner, {
      key: "a-cancel",
      body: { id: sooner.id, rev: sooner.rev },
    });
    const afterCancel = (await (
      await fetch(`${fixture.url}/api/appointments/next`, {
        headers: { Cookie: `${SESSION_COOKIE}=${fixture.cookies.owner}` },
      })
    ).json()) as { next: AppointmentView | null };
    assert.equal(afterCancel.next?.id, later.id, "a cancelled appointment is not next");
    assert.notEqual(afterCancel.next?.id, past.id);
  } finally {
    await fixture.stop();
  }
});

// --- update and cancel ------------------------------------------------------

test("an update bumps the revision; a stale one carries the current appointment", async () => {
  const fixture = await startCalendarApp();
  try {
    const created = (await (
      await post(fixture, "/api/appointments", fixture.cookies.owner, { key: "a-1", body: fields() })
    ).json()) as CreateAnswer;
    const id = created.appointment.id;

    const updated = await post(fixture, "/api/appointments/update", fixture.cookies.owner, {
      key: "a-2",
      body: { id, rev: 0, ...fields({ title: "Vet visit (moved)", timeLocal: "10:30" }) },
    });
    assert.equal(updated.status, 200);
    const answer = (await updated.json()) as ChangeAnswer;
    assert.equal(answer.replayed, false);
    assert.equal(answer.appointment.rev, 1);
    assert.equal(answer.appointment.title, "Vet visit (moved)");
    assert.equal(answer.appointment.startsAt, "2026-12-20T09:30:00.000Z", "10:30 CET");

    const stale = await post(fixture, "/api/appointments/update", fixture.cookies.owner, {
      key: "a-3",
      body: { id, rev: 0, ...fields({ title: "Too late" }) },
    });
    assert.equal(stale.status, 409);
    const staleBody = (await stale.json()) as { error: string; appointment: AppointmentView };
    assert.equal(staleBody.error, "stale");
    assert.equal(staleBody.appointment.id, id, "the current record travels with the conflict");
    assert.equal(staleBody.appointment.rev, 1);
    assert.equal(staleBody.appointment.title, "Vet visit (moved)");

    assert.equal(
      (
        await post(fixture, "/api/appointments/update", fixture.cookies.owner, {
          key: "a-missing",
          body: { id: "no-such-id", rev: 0, ...fields() },
        })
      ).status,
      404,
    );
  } finally {
    await fixture.stop();
  }
});

test("a cancel is a state change, replays, and refuses a second different cancel", async () => {
  const fixture = await startCalendarApp();
  try {
    const created = (await (
      await post(fixture, "/api/appointments", fixture.cookies.owner, { key: "a-1", body: fields() })
    ).json()) as CreateAnswer;
    const id = created.appointment.id;

    const cancelled = await post(fixture, "/api/appointments/cancel", fixture.cookies.owner, {
      key: "a-2",
      body: { id, rev: 0 },
    });
    assert.equal(cancelled.status, 200);
    const answer = (await cancelled.json()) as ChangeAnswer;
    assert.equal(answer.appointment.status, "cancelled");
    assert.equal(answer.appointment.rev, 1);

    const replay = await post(fixture, "/api/appointments/cancel", fixture.cookies.owner, {
      key: "a-2",
      body: { id, rev: 0 },
    });
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as ChangeAnswer).replayed, true);

    const again = await post(fixture, "/api/appointments/cancel", fixture.cookies.owner, {
      key: "a-3",
      body: { id, rev: 1 },
    });
    assert.equal(again.status, 409);
    assert.match(((await again.json()) as { error: string }).error, /cancelled/);

    assert.equal((await committed(fixture)).length, 1, "the record stays: a cancellation is not a delete");
    const { body } = await get(fixture, "/api/appointments");
    assert.equal(body.appointments[0]?.status, "cancelled");
    assert.equal(body.next, null, "a cancelled appointment is never next");
  } finally {
    await fixture.stop();
  }
});

test("the appointment routes need a session, an origin, the request header, JSON and a key", async () => {
  const fixture = await startCalendarApp();
  try {
    assert.equal((await post(fixture, "/api/appointments", "", { key: "k", body: fields() })).status, 401);
    assert.equal(
      (
        await post(fixture, "/api/appointments", fixture.cookies.owner, {
          key: "k",
          body: fields(),
          omitOrigin: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(fixture, "/api/appointments", fixture.cookies.owner, {
          key: "k",
          body: fields(),
          omitHeader: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(fixture, "/api/appointments", fixture.cookies.owner, {
          key: "k",
          body: fields(),
          contentType: "text/plain",
        })
      ).status,
      415,
    );
    const noKey = await post(fixture, "/api/appointments", fixture.cookies.owner, { body: fields() });
    assert.equal(noKey.status, 409);
    assert.match(((await noKey.json()) as { error: string }).error, /Idempotency-Key/);
    assert.deepEqual(await committed(fixture), []);
    // A body key the route does not accept is refused, not silently dropped.
    const unknown = await post(fixture, "/api/appointments", fixture.cookies.owner, {
      key: "k-unknown",
      body: { ...fields(), startsAt: "2026-12-20T08:00:00.000Z" },
    });
    assert.equal(unknown.status, 409);
    assert.match(((await unknown.json()) as { error: string }).error, /startsAt/);
  } finally {
    await fixture.stop();
  }
});

test("the partner can read and create appointments", async () => {
  const fixture = await startTestApp({
    prefix: "pupkeep-calendar-partner-",
    now: LATE.getTime(),
    timezone: "Europe/Paris",
    partner: true,
  });
  try {
    assert.ok(fixture.cookies.partner);
    const created = await post(fixture, "/api/appointments", fixture.cookies.partner, {
      key: "p-1",
      body: fields({ title: "Groomer" }),
    });
    assert.equal(created.status, 200);
    const answer = (await created.json()) as CreateAnswer;
    assert.equal(answer.appointment.createdByLabel, "Sam");

    const read = await get(fixture, "/api/appointments", fixture.cookies.owner);
    assert.equal(read.status, 200);
    assert.equal(read.body.appointments.length, 1);
  } finally {
    await fixture.stop();
  }
});
