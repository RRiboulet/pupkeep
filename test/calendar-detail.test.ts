// The appointment detail card's When line, rendered to vnodes without a DOM
// (same pattern as `test/client.test.js`).
//
// The bug this pins: the template put the time range and the duration on two
// lines of one `<dd>`. htm strips the whitespace around a newline between two
// expressions, so the browser received two adjacent text nodes and showed
// "10:30–11:0030 min". The separator is now part of the string, and only when
// there is a duration to separate — `durationText()` is "" for a non-positive
// or missing one, and a naive " · " prefix would leave a dangling separator.

import assert from "node:assert/strict";
import { test } from "node:test";

// `web/` is plain JS the browser loads directly and tsc does not type (it sits
// outside the project's include), so the specifier is not a literal here: the
// import yields `any` instead of demanding a declaration file, the same untyped
// seam `test/client.test.js` exercises.
const VIEW = "../web/views/calendar.js";
const { Calendar } = await import(VIEW);

/** An appointment as the grid and the detail read it. */
function appointmentOf(overrides = {}) {
  return {
    id: "a-1",
    rev: 1,
    title: "Vet visit",
    localDate: "2026-11-13",
    timeLocal: "10:30",
    durationMin: 30,
    reminderOffsetsMin: [1440],
    timezone: "Europe/Paris",
    status: "scheduled",
    location: "Rue de Lyon",
    vetName: "Dr Moreau",
    notes: "",
    // The server's derived instants: 10:30–11:00 in Paris (CET, +01:00).
    startsAt: "2026-11-13T09:30:00.000Z",
    endsAt: "2026-11-13T10:00:00.000Z",
    ...overrides,
  };
}

/** Every child of an htm vnode in one flat list, nested arrays included. */
function flatChildren(node: any, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const child of node) flatChildren(child, out);
  } else {
    out.push(node);
  }
  return out;
}

/** The text a leaf vnode (or a string) contributes, whitespace aside. */
function textOf(node: any): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object") return textOf(node.props?.children);
  return "";
}

/** The rendered `When` value: the `<dd>` after the `When` label in the facts. */
function whenLine(appointment: any, view: any = {}) {
  const card = new Calendar({});
  card.state.view = {
    today: "2026-11-13",
    timezone: "Europe/Paris",
    appointments: [appointment],
    defaultReminderOffsetsMin: [],
    ...view,
  };
  card.state.detailId = appointment.id;
  // A mounted-enough card: the detail render reads `state` and nothing else.
  card.setState = (patch: any) => Object.assign(card.state, patch);

  const section = card.renderDetail();
  const facts = flatChildren(section.props?.children).find(
    (node) => node?.type === "dl" && node.props?.class === "calendar__facts",
  );
  assert.ok(facts, "the detail card renders its facts list");
  const children = flatChildren(facts.props?.children);
  const label = children.findIndex((node) => node?.type === "dt" && textOf(node) === "When");
  assert.notEqual(label, -1, "the facts list names a When row");
  const value = children[label + 1];
  assert.equal(value?.type, "dd", "the When label is followed by its value");
  return textOf(value).replace(/\s+/g, " ").trim();
}

test("the detail's When line separates the end time from the duration", () => {
  assert.equal(whenLine(appointmentOf()), "13 Nov 2026, 10:30–11:00 · 30 min");
});

test("a two-hour appointment reads as hours, not minutes", () => {
  const appointment = appointmentOf({
    durationMin: 120,
    startsAt: "2026-11-13T09:30:00.000Z",
    endsAt: "2026-11-13T11:30:00.000Z",
  });
  assert.equal(whenLine(appointment), "13 Nov 2026, 10:30–12:30 · 2 h");
});

test("a zero or absent duration leaves the range with no dangling separator", () => {
  const zero = appointmentOf({ durationMin: 0, startsAt: undefined, endsAt: undefined });
  assert.equal(whenLine(zero), "13 Nov 2026, 10:30–10:30");
  assert.ok(!whenLine(zero).includes(" · "), "no separator when durationText() is empty");

  const absent = appointmentOf({ durationMin: undefined, startsAt: undefined, endsAt: undefined });
  assert.equal(whenLine(absent), "13 Nov 2026, 10:30");
  assert.ok(!whenLine(absent).includes(" · "), "the wall clock cannot end an unknown duration");
});

test("a zone mismatch keeps its zone after the duration, not before it", () => {
  // 10:30–11:00 in New York (EST, -05:00), read in a Paris household.
  const appointment = appointmentOf({
    timezone: "America/New_York",
    startsAt: "2026-11-13T15:30:00.000Z",
    endsAt: "2026-11-13T16:00:00.000Z",
  });
  const line = whenLine(appointment);
  assert.equal(line, "13 Nov 2026, 10:30–11:00 · 30 min (America/New_York)");
  assert.ok(line.indexOf("(America/New_York)") > line.indexOf("· 30 min"), "the zone names the record, after its duration");
});
