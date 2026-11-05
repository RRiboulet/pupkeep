// P3-06: `app.showers` and its service (PLAN §8.1, §8.4, §7.3, §9.2, §16 P3-06).
//
// What is covered:
//   * the shape: a household-local date with the record, the §9.2 pairing, the
//     text bounds and control characters, unique ids, and no ordering or
//     one-a-day rule (a second rinse is legitimate);
//   * the derived next due date: the latest shower by *calendar date* plus the
//     household's interval, with "due today" and "overdue" pinned at exact day
//     boundaries, a view built from the household's zone and clock, and a zone
//     change unable to re-date history. The due-date arithmetic is calendar
//     arithmetic (no zone), so the DST cases here pin that the interval counts
//     dates, not instants — the comments say exactly that, no more;
//   * the service over a real harness: one commit (record + activity + key), the
//     household-local date at 23:30Z, text trimmed, replay, key conflict, the
//     household fallback actor, a refused shape writing nothing;
//   * bootstrap and durability: a database that predates P3-06 is repaired, a
//     malformed one refused, a household-less one refused, and the history
//     survives a reopen.

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
  CommandsDoc,
  ShowersDoc,
  emptyShowers,
  parseShowers,
} from "../src/server/domain/docs.ts";
import { ShowersUnavailableError, logShower, readShowerView, readShowers, showerView } from "../src/server/domain/showers.ts";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import {
  SHAMPOO_LIMIT,
  SHOWER_RULE,
  lastShower,
  parseShower,
  parseShowerFields,
  parseShowerList,
  showerHistory,
  showerStatus,
} from "../src/shared/showers.ts";
import { emptyHousehold, parseHousehold } from "../src/server/domain/docs.ts";
import { SHOWER_INTERVAL_MAX_DAYS } from "../src/shared/domain.ts";
import { watchProfileState } from "../src/server/agent/state.ts";
import { createLogger } from "../src/server/log.ts";
import type { Shower } from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
/** 23:30Z is already the next day in Paris: a UTC date would answer 29 October. */
const LATE = new Date("2026-10-29T23:30:00.000Z");
const TODAY = "2026-10-30";

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
const householdActor = async () => ({ id: null, label: "Household" });

function shower(overrides: Partial<Shower> = {}): Shower {
  return {
    id: "shower-1",
    localDate: TODAY,
    at: LATE.toISOString(),
    byUserId: "owner",
    byLabel: "Alex",
    source: "ui",
    actionId: "http:s-1",
    ...overrides,
  };
}

async function withShowersHarness(run: (opened: OpenedHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-showers-"));
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

test("a shower carries its household-local date, who and when, with one-line text", () => {
  assert.deepEqual(parseShower(shower()), shower());
  assert.deepEqual(parseShower(shower({ shampoo: "  oatmeal  ", notes: "towel dry " })), {
    ...shower(),
    shampoo: "oatmeal",
    notes: "towel dry",
  });
  assert.equal(parseShower({ ...shower(), extra: true }), undefined, "an unknown key is refused");
  assert.equal(parseShower({ ...shower(), localDate: "2026-02-30" }), undefined);
  assert.equal(parseShower({ ...shower(), at: "2026-10-29T23:30:00" }), undefined, "no zone-less instants");
  assert.equal(parseShower({ ...shower(), id: "" }), undefined);
  assert.equal(parseShower({ ...shower(), actionId: "http:s 1" }), undefined);
  assert.equal(parseShower({ ...shower(), shampoo: "x".repeat(SHAMPOO_LIMIT + 1) }), undefined);
  assert.equal(parseShower({ ...shower(), notes: "two\nlines" }), undefined);
  assert.equal(parseShower({ ...shower(), source: "email" }), undefined);
  // §9.2: no id always travels with the household label.
  assert.equal(parseShower({ ...shower(), byUserId: null }), undefined);
  assert.ok(parseShower({ ...shower(), byUserId: null, byLabel: "Household" }));

  assert.deepEqual(parseShowerFields({ shampoo: "   " }), {}, "empty text is absent, not stored");
  assert.deepEqual(parseShowerFields({ shampoo: "oatmeal", notes: "  " }), { shampoo: "oatmeal" });
  assert.equal(parseShowerFields({ shampoo: 4 }), undefined);
  assert.equal(parseShowerFields({ shampoo: "a\nb" }), undefined);
  assert.equal(parseShowerFields({ extra: true }), undefined);
});

test("the history allows two showers a day, and only a repeated id is refused", () => {
  const second = shower({ id: "shower-2", at: "2026-10-30T09:00:00.000Z" });
  assert.deepEqual(parseShowerList([shower(), second]), [shower(), second], "a second rinse is legitimate");
  assert.equal(parseShowerList([shower(), shower()]), undefined, "a repeated id is a bug, not a document");
  assert.deepEqual(parseShowers({ ...emptyShowers(), createdAt: LATE.toISOString() }), {
    schemaVersion: 1,
    showers: [],
    createdAt: LATE.toISOString(),
  });
  assert.equal(parseShowers({ ...emptyShowers(), createdAt: "yesterday" }), undefined);
  assert.equal(parseShowers({ ...emptyShowers(), showers: [{ id: "x" }], createdAt: LATE.toISOString() }), undefined);
});

// --- the derived next due date ---------------------------------------------

test("the next due date is the latest shower plus the household interval, by date", () => {
  const history = { showers: [shower({ localDate: "2026-10-09" }), shower({ id: "s-2", localDate: "2026-10-01" })] };
  const status = showerStatus(history, 21, "2026-10-30");
  assert.equal(status.last?.localDate, "2026-10-09", "the latest by calendar date, not by append order");
  assert.equal(status.nextDue, "2026-10-30");
  assert.equal(status.daysUntilDue, 0, "due exactly on the interval (the caller reads 0 as due)");
  assert.deepEqual(Object.keys(status).sort(), ["daysUntilDue", "last", "nextDue"], "one comparison, stated once");

  // One day early, one day late.
  assert.equal(showerStatus(history, 21, "2026-10-29").daysUntilDue, 1);
  assert.equal(showerStatus(history, 21, "2026-10-31").daysUntilDue, -1);

  // No history: nothing is due, and nothing is invented.
  assert.deepEqual(showerStatus({ showers: [] }, 21, TODAY), {
    last: null,
    nextDue: null,
    daysUntilDue: null,
  });

  // The interval is the household's setting; a shorter one makes it due sooner.
  assert.equal(showerStatus(history, 20, "2026-10-29").daysUntilDue, 0);
  assert.equal(showerStatus(history, 22, "2026-10-29").daysUntilDue, 2);
});

test("the interval crosses a month end and a leap day by calendar days", () => {
  const history = (localDate: string) => ({ showers: [shower({ localDate })] });
  // 31 January + 21 days is 21 February: February 2026 has 28 days, so a month
  // subtraction would be three days short.
  const january = showerStatus(history("2026-01-31"), 21, "2026-02-10");
  assert.equal(january.nextDue, "2026-02-21");
  assert.equal(january.daysUntilDue, 11);
  // A one-day interval steps into the next month, not onto the 32nd.
  assert.equal(showerStatus(history("2026-01-31"), 1, "2026-01-31").nextDue, "2026-02-01");
  // 2028 is a leap year: 28 February + 1 is the 29th, + 2 is 1 March.
  assert.equal(showerStatus(history("2028-02-28"), 1, "2028-02-29").nextDue, "2028-02-29");
  assert.equal(showerStatus(history("2028-02-28"), 2, "2028-03-01").nextDue, "2028-03-01");
  // A shower on the leap day itself counts 21 days forward normally.
  assert.equal(showerStatus(history("2028-02-29"), 21, "2028-03-21").nextDue, "2028-03-21");
});

test("showerStatus refuses an unvalidated interval or a due date that is not a date", () => {
  const history = { showers: [shower()] };
  assert.throws(() => showerStatus(history, Number.NaN, TODAY), /not a shower interval/);
  assert.throws(() => showerStatus(history, 0, TODAY), /not a shower interval/);
  assert.throws(() => showerStatus(history, 21.5, TODAY), /not a shower interval/);
  // A hand-written record at the end of the calendar cannot produce a date.
  assert.throws(
    () => showerStatus({ showers: [shower({ localDate: "9999-12-31" })] }, 21, TODAY),
    /not a calendar date/,
  );
});

test("the interval's one boundary rule lives in the settings parser", () => {
  const base = { ...emptyHousehold(), members: [{ id: "owner", name: "Alex" }], conversationId: 1, systemConversationId: 2, createdAt: LATE.toISOString() };
  const withInterval = (showerIntervalDays: unknown) => ({
    ...base,
    settings: { ...base.settings, showerIntervalDays },
  });
  assert.equal(parseHousehold(withInterval(21))?.settings.showerIntervalDays, 21);
  assert.equal(parseHousehold(withInterval(SHOWER_INTERVAL_MAX_DAYS))?.settings.showerIntervalDays, SHOWER_INTERVAL_MAX_DAYS);
  // A due date is a calendar date: the document refuses what the arithmetic
  // cannot honour, rather than rounding it away downstream.
  assert.equal(parseHousehold(withInterval(0)), undefined);
  assert.equal(parseHousehold(withInterval(0.2)), undefined, "whole days only");
  assert.equal(parseHousehold(withInterval(21.6)), undefined);
  assert.equal(parseHousehold(withInterval(SHOWER_INTERVAL_MAX_DAYS + 1)), undefined);
  assert.equal(parseHousehold(withInterval(Number.NaN)), undefined);
});

test("the view derives the due date from the household's zone and clock", () => {
  // 23:30Z on 29 October is already 30 October in Paris: the shower is dated
  // the 30th and the due date counts from there.
  const view = showerView(
    { ...emptyHousehold(), timezone: "Europe/Paris", settings: { ...emptyHousehold().settings, showerIntervalDays: 21 } },
    { ...emptyShowers(), createdAt: LATE.toISOString(), showers: [shower()] },
    LATE,
  );
  assert.equal(view.history[0]?.localDate, TODAY);
  assert.equal(view.status.nextDue, "2026-11-20");
  assert.equal(view.intervalDays, 21);
  // A DST change inside the interval cannot move the calendar date.
  const acrossDst = showerView(
    { ...emptyHousehold(), timezone: "Europe/Paris", settings: { ...emptyHousehold().settings, showerIntervalDays: 21 } },
    { ...emptyShowers(), createdAt: LATE.toISOString(), showers: [shower({ localDate: "2026-03-21" })] },
    new Date("2026-04-11T12:00:00.000Z"),
  );
  assert.equal(acrossDst.status.nextDue, "2026-04-11");
  assert.equal(acrossDst.status.daysUntilDue, 0);
  assert.deepEqual(showerView({ ...emptyHousehold() }, { ...emptyShowers(), createdAt: LATE.toISOString() }, LATE).status, {
    last: null,
    nextDue: null,
    daysUntilDue: null,
  });
});

test("a zone change cannot re-date history, and the date arithmetic has no DST", () => {
  // The stored local date is the day the household lived, never a value
  // re-derived from `at` today. 22:30Z on 9 October is already 00:30 on **10**
  // October in Paris (CEST, +2 — the fixture sits before the 25 October
  // change), while the record says the 9th. Re-deriving would give 10-10 and a
  // due date of 31 October; counting from the stored date gives 30 October, so
  // this fixture fails if a future edit starts re-deriving.
  const history = {
    showers: [shower({ localDate: "2026-10-09", at: "2026-10-09T22:30:00.000Z" })],
  };
  assert.equal(showerStatus(history, 21, "2026-10-30").nextDue, "2026-10-30");
  // A DST boundary inside the interval cannot move a calendar date.
  const acrossDst = showerStatus({ showers: [shower({ localDate: "2026-03-21" })] }, 21, "2026-04-11");
  assert.equal(acrossDst.nextDue, "2026-04-11");
  assert.equal(acrossDst.daysUntilDue, 0, "the European DST change on 29 March does not add or lose a day here");
  // A future-dated shower (a clock jump) is never due.
  const future = showerStatus({ showers: [shower({ localDate: "2026-11-05" })] }, 21, TODAY);
  assert.ok((future.daysUntilDue ?? 0) > 0);
});

test("the history lists newest first by date, and the latest is the calendar's", () => {
  const history = {
    showers: [
      shower({ id: "s-1", localDate: "2026-10-01" }),
      shower({ id: "s-2", localDate: "2026-10-09", at: "2026-10-09T18:00:00.000Z" }),
      shower({ id: "s-3", localDate: "2026-10-09", at: "2026-10-09T20:00:00.000Z" }),
    ],
  };
  assert.deepEqual(
    showerHistory(history).map((entry) => entry.id),
    ["s-3", "s-2", "s-1"],
    "same day: the later instant first",
  );
  assert.equal(lastShower(history)?.id, "s-3");
});

// --- the service -----------------------------------------------------------

test("logging a shower is one commit: the record, one activity line and the key", async () => {
  await withShowersHarness(async (opened) => {
    const outcome = await logShower(opened.harness, context, {
      actor: alex,
      actionId: "http:s-1",
      shampoo: "  oatmeal ",
      notes: "towel dry",
      source: "ui",
      now: LATE,
      id: "shower-1",
    });
    assert.equal(outcome.kind, "logged");
    assert.deepEqual(outcome.shower, {
      id: "shower-1",
      localDate: TODAY,
      at: LATE.toISOString(),
      shampoo: "oatmeal",
      notes: "towel dry",
      byUserId: "owner",
      byLabel: "Alex",
      source: "ui",
      actionId: "http:s-1",
    });
    assert.deepEqual((await readShowers(opened.harness, context)).showers, [outcome.shower]);
    const activity = await opened.harness.snapshot(ActivityDoc, context);
    assert.deepEqual(
      activity?.entries.filter((entry) => entry.kind === "shower.logged").map((entry) => entry.summary),
      ["Alex logged a shower"],
    );
    const commands = (await opened.harness.snapshot(CommandsDoc, context))?.entries ?? [];
    assert.deepEqual(commands.map((entry) => entry.key), ["http:s-1"]);
  });
});

test("the same action replays as success, a different body is a key conflict, a bad shape writes nothing", async () => {
  await withShowersHarness(async (opened) => {
    const input = {
      actor: alex,
      actionId: "http:s-1",
      shampoo: "oatmeal",
      source: "ui",
      now: LATE,
    } as const;
    const first = await logShower(opened.harness, context, input);
    assert.equal(first.kind, "logged");

    const replay = await logShower(opened.harness, context, { ...input, shampoo: " oatmeal " });
    assert.equal(replay.kind, "replayed");
    if (replay.kind === "replayed" && first.kind === "logged") assert.deepEqual(replay.shower, first.shower);
    assert.equal((await readShowers(opened.harness, context)).showers.length, 1, "a replay writes nothing");

    const conflict = await logShower(opened.harness, context, { ...input, shampoo: "tar" });
    assert.equal(conflict.kind, "key-conflict");

    await assert.rejects(
      logShower(opened.harness, context, {
        actor: alex,
        actionId: "http:s-bad",
        shampoo: "x".repeat(SHAMPOO_LIMIT + 1),
        source: "ui",
        now: LATE,
      }),
      (error: unknown) => error instanceof Error && error.message === SHOWER_RULE,
    );
    assert.equal((await readShowers(opened.harness, context)).showers.length, 1);
    const commands = (await opened.harness.snapshot(CommandsDoc, context))?.entries ?? [];
    assert.equal(commands.some((entry) => entry.key === "http:s-bad"), false, "a refused shower does not burn its key");
  });
});

test("a caregiver the household does not carry writes as the household fallback", async () => {
  await withShowersHarness(async (opened) => {
    const outcome = await logShower(opened.harness, context, {
      actor: householdActor,
      actionId: "tool:task-1",
      source: "agent",
      now: LATE,
    });
    assert.equal(outcome.kind, "logged");
    assert.equal(outcome.shower.byUserId, null);
    assert.equal(outcome.shower.byLabel, "Household");
    assert.equal(outcome.shower.source, "agent");
    assert.deepEqual(outcome.shower.shampoo, undefined);
    const activity = await opened.harness.snapshot(ActivityDoc, context);
    assert.deepEqual(
      activity?.entries.filter((entry) => entry.kind === "shower.logged").map((entry) => entry.summary),
      ["Household logged a shower"],
    );
  });
});

test("a shower commit publishes the care signal, and the frame carries no shower data", async () => {
  await withShowersHarness(async (opened) => {
    const frames: unknown[] = [];
    const watch = watchProfileState({
      harness: opened.harness,
      context,
      bus: { publishState: (profile: unknown) => frames.push(profile) },
      logger: createLogger({ scope: "test", sink: () => undefined }),
      now: () => LATE,
    });
    try {
      await logShower(opened.harness, context, {
        actor: alex,
        actionId: "http:s-1",
        source: "ui",
        now: LATE,
      });
      const deadline = Date.now() + 2000;
      while (frames.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(frames.length > 0, "app.showers is one of the documents behind the care frame");
      // The frame is a signal (P2-05): P3-07's card re-reads its own route.
      assert.equal("showers" in (frames.at(-1) as Record<string, unknown>), false);
    } finally {
      watch.stop();
    }
    const view = await readShowerView(opened.harness, context, LATE);
    assert.equal(view.history.length, 1);
    assert.equal(view.status.nextDue, "2026-11-20");
  });
});

test("a missing shower document is unavailable, not an empty history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-showers-empty-"));
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite") });
  try {
    await assert.rejects(readShowers(opened.harness, context), ShowersUnavailableError);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

// --- bootstrap and durability ---------------------------------------------

test("boot repairs a pre-P3-06 database and refuses a malformed or orphaned one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-showers-boot-"));
  const path = join(dir, "pupkeep.sqlite");
  try {
    const first = await openHarness({ path });
    try {
      await bootstrapSession(first.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => LATE,
      });
      await first.harness.commit(async (tx) => {
        await tx.retireDoc(ShowersDoc);
      }, context);
    } finally {
      await first.harness.close(context);
    }

    const second = await openHarness({ path });
    try {
      const boot = await bootstrapSession(second.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => LATE,
      });
      assert.equal(boot.created, false);
      assert.ok(boot.docsCreated.includes("app.showers"));
      assert.deepEqual((await readShowers(second.harness, context)).showers, []);

      await second.harness.commit(async (tx) => {
        const draft = await tx.doc(ShowersDoc);
        draft.showers = [{ id: "x" } as never];
      }, context);
      await assert.rejects(
        bootstrapSession(second.harness, {
          config: { ...emptyConfig(), members: [owner] },
          context,
          timezone: "Europe/Paris",
          now: () => LATE,
        }),
        /app\.showers is not a shape/,
      );
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the history survives a reopen of the database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-showers-durable-"));
  const path = join(dir, "pupkeep.sqlite");
  try {
    const first = await openHarness({ path });
    try {
      await bootstrapSession(first.harness, {
        config: { ...emptyConfig(), members: [owner] },
        context,
        timezone: "Europe/Paris",
        now: () => LATE,
      });
      await logShower(first.harness, context, {
        actor: alex,
        actionId: "http:s-1",
        shampoo: "oatmeal",
        source: "ui",
        now: LATE,
        id: "shower-1",
      });
    } finally {
      await first.harness.close(context);
    }

    const second = await openHarness({ path });
    try {
      const restored = await readShowers(second.harness, context);
      assert.equal(restored.showers.length, 1);
      assert.equal(restored.showers[0]?.shampoo, "oatmeal");
      assert.equal(restored.showers[0]?.localDate, TODAY);
      assert.deepEqual(parseShowers(restored), restored);
    } finally {
      await second.harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
