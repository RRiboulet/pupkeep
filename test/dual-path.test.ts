// P3-08: one dual-path test per care surface (PLAN §16 P3-08, §15.3, Gate G3).
//
// Gate G3's line is "UI and agent produce identical domain results". Each test
// below boots two identical apps on the same pinned clock and household zone,
// applies the *same intent* once over HTTP and once through the agent tool, and
// compares the committed care document.
//
// "Identical" cannot mean the whole record: §7.3 and §9.2 require some fields to
// differ by channel — the record id, the action id (`http:` vs `tool:`), the
// source (`ui` vs `agent`) and the actor (a session member vs the tool's
// household fallback). Those fields are listed per surface and removed before
// the comparison; everything else — the slot, the local date, the instant, the
// status, the text — is compared as serialized JSON. The provenance itself is
// asserted separately, so a change that quietly made both paths say `ui` would
// fail here too.
//
// Determinism: both apps share one fixed clock and one zone, the schedules are
// written through the real route, and the five surface comparisons neither
// sleep nor poll. The one attribution test polls a real provider run, because a
// model turn is not a clock question.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createFeedTools } from "../src/server/agent/feed-tools.ts";
import { createGrowthTools } from "../src/server/agent/growth-tools.ts";
import { createShowerTools } from "../src/server/agent/shower-tools.ts";
import { createTrainingTools } from "../src/server/agent/training-tools.ts";
import { createWalkTools } from "../src/server/agent/walk-tools.ts";
import { readFeeding } from "../src/server/domain/feeding.ts";
import { readGrowth } from "../src/server/domain/growth.ts";
import { readShowers } from "../src/server/domain/showers.ts";
import { readTraining } from "../src/server/domain/training.ts";
import { readWalks } from "../src/server/domain/walks.ts";
import { ActivityDoc } from "../src/server/domain/docs.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import type { MealSlot } from "../src/shared/domain.ts";
import {
  conversationIdOf,
  startTestApp,
  toolApi,
  until,
  type TestApp,
} from "./support/app.ts";

const context = BACKGROUND_CONTEXT;
/** One instant for both apps: every stored date and time derives from it. */
const T0 = Date.parse("2026-10-30T08:00:00.000Z");
const ZONE = "Europe/Paris";
const SLOT: MealSlot = { id: "slot-b", label: "Breakfast", timeLocal: "07:00", active: true };

/**
 * The fields §7.3/§9.2 say may differ between the two channels. Everything else
 * in a record is the domain result and must match to the byte.
 */
const EVENT_PROVENANCE = ["id", "actionId", "source", "byUserId", "byLabel"] as const;
const WALK_PROVENANCE = [
  "id",
  "startedActionId",
  "endActionId",
  "startedBy",
  "startedByLabel",
  "endedBy",
  "endedByLabel",
] as const;
/** A milestone's `id` is the catalog id — domain data, not record identity. */
const STATE_PROVENANCE = ["actionId", "source", "byUserId", "byLabel"] as const;
/** A custom milestone's id is random (`custom:<uuid>`), so it is provenance here. */
const CUSTOM_PROVENANCE = ["id", "actionId", "source", "byUserId", "byLabel"] as const;

function without<T extends object>(value: T, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

/** The domain payload, as serialized JSON, with only the channel's provenance removed. */
function payload(records: readonly object[], provenance: readonly string[]): string {
  return JSON.stringify(records.map((record) => without(record, provenance)));
}

function boot(prefix: string): Promise<TestApp> {
  return startTestApp({ prefix, now: T0, timezone: ZONE });
}

/**
 * Two identical apps. If the second boot fails, the first is closed rather than
 * leaked: the caller's `finally` has not started yet.
 */
async function bootPair(prefix: string): Promise<[TestApp, TestApp]> {
  const ui = await boot(`${prefix}-ui-`);
  try {
    return [ui, await boot(`${prefix}-agent-`)];
  } catch (error) {
    await ui.stop();
    throw error;
  }
}

async function mutate(app: TestApp, method: "POST" | "PATCH", path: string, body: unknown, key: string): Promise<Response> {
  return fetch(`${app.url}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
      "Idempotency-Key": key,
      Cookie: `${SESSION_COOKIE}=${app.cookies.owner}`,
      Origin: app.url,
    },
    body: JSON.stringify(body),
  });
}

function toolNamed(name: string) {
  const tools = new Map(
    [
      ...(createFeedTools().tools ?? []),
      ...(createWalkTools().tools ?? []),
      ...(createGrowthTools().tools ?? []),
      ...(createTrainingTools().tools ?? []),
      ...(createShowerTools().tools ?? []),
    ].map((tool) => [tool.name, tool]),
  );
  const tool = tools.get(name);
  assert.ok(tool, `the ${name} tool is registered`);
  return tool;
}

async function toolCall(app: TestApp, name: string, args: Record<string, unknown>, taskId: string) {
  return toolNamed(name).execute(args, toolApi(app, await conversationIdOf(app), taskId), context);
}

/** A real meal schedule on both apps, so the feed write has an active slot. */
async function schedule(app: TestApp): Promise<void> {
  const response = await mutate(app, "PATCH", "/api/feeding/slots", { rev: 0, slots: [SLOT] }, "schedule");
  assert.equal(response.status, 200);
}

// --- attribution -------------------------------------------------------------

/**
 * Gate G3's second half: "all logs attributed". The tool-side suites pin the
 * household fallback; this drives a real shared-thread run as the *partner*, so
 * the speaker is the second caregiver who typed — not the owner, not the
 * fallback, and not whoever opened the run. The feed surface proves the same
 * path in P2-04 with the owner; this is the Phase 3 representative.
 */
test("attribution: a milestone tool call from the real thread belongs to the caregiver who spoke", async () => {
  const app = await startTestApp({
    prefix: "pupkeep-dual-attribution-",
    now: T0,
    timezone: ZONE,
    partner: true,
    responses: [
      fauxAssistantMessage([fauxToolCall("update_milestone", { milestoneId: "catalog:sit", status: "mastered" })], {
        stopReason: "toolUse",
      }),
      () => fauxAssistantMessage("Done."),
    ],
  });
  try {
    const posted = await fetch(`${app.url}/api/agent/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        Cookie: `${SESSION_COOKIE}=${app.cookies.partner}`,
        Origin: app.url,
      },
      body: JSON.stringify({ text: "Rex sat on command", clientMessageId: "m-attribution" }),
    });
    assert.equal(posted.status, 202);

    const state = await until(async () => (await readTraining(app.app.app, context)).states[0]);
    assert.equal(state.id, "catalog:sit");
    assert.equal(state.status, "mastered");
    // The actor came from the assistant entry's stop, not from the model's
    // arguments: the tool call names no caregiver at all.
    assert.equal(state.byUserId, "partner");
    assert.equal(state.byLabel, "Sam");
    assert.equal(state.source, "agent");
    assert.match(state.actionId, /^tool:/, "the real task id, not a client key");

    const activity = await app.app.app.snapshot(ActivityDoc, context);
    assert.ok(activity?.entries.some((entry) => entry.summary === 'Sam marked "Sit" mastered'));
  } finally {
    await app.stop();
  }
});


// --- feed -------------------------------------------------------------------

test("feed: the route and the tool commit one identical meal", async () => {
  const [ui, agent] = await bootPair("pupkeep-dual-feed");
  try {
    await schedule(ui);
    await schedule(agent);
    const fed = await mutate(ui, "POST", "/api/feeding/fed", { slotId: SLOT.id }, "feed-1");
    assert.equal(fed.status, 200);
    const extra = await mutate(ui, "POST", "/api/feeding/extra", { note: "training treat" }, "feed-extra");
    assert.equal(extra.status, 200);

    const logged = await toolCall(agent, "log_feeding", { slotId: SLOT.id }, "task-feed");
    assert.equal(logged.isError, undefined);
    const extraLogged = await toolCall(agent, "log_extra_feeding", { note: "training treat" }, "task-extra");
    assert.equal(extraLogged.isError, undefined);

    const uiFeeding = await readFeeding(ui.app.app, context);
    const agentFeeding = await readFeeding(agent.app.app, context);
    assert.equal(agentFeeding.events.length, 2, "a scheduled meal and an extra feeding");
    assert.equal(
      payload(agentFeeding.events, EVENT_PROVENANCE),
      payload(uiFeeding.events, EVENT_PROVENANCE),
      "the slot, the null-slot extra, the local dates and instants — byte for byte",
    );
    // The provenance is the documented difference, and it is not silent.
    assert.equal(uiFeeding.events[0]!.source, "ui");
    assert.equal(agentFeeding.events[0]!.source, "agent");
    assert.match(uiFeeding.events[0]!.actionId, /^http:/);
    assert.match(agentFeeding.events[0]!.actionId, /^tool:/);
    assert.equal(uiFeeding.events[0]!.byLabel, "Alex");
    assert.equal(agentFeeding.events[0]!.byLabel, "Household", "a model-less tool call is the household fallback");
    // The extra feeding never claims a slot, on either path.
    assert.equal(uiFeeding.events[1]!.slotId, null);
    assert.equal(agentFeeding.events[1]!.slotId, null);
  } finally {
    await ui.stop();
    await agent.stop();
  }
});

// --- walk -------------------------------------------------------------------

test("walk: the route and the tool commit one identical walk", async () => {
  const [ui, agent] = await bootPair("pupkeep-dual-walk");
  try {
    const started = await mutate(ui, "POST", "/api/walks/start", {}, "walk-start");
    assert.equal(started.status, 200);
    const { walk } = (await started.json()) as { walk: { id: string } };
    const ended = await mutate(
      ui,
      "POST",
      "/api/walks/end",
      { walkId: walk.id, pee: 1, mood: "calm" },
      "walk-end",
    );
    assert.equal(ended.status, 200);

    assert.equal((await toolCall(agent, "start_walk", {}, "task-start")).isError, undefined);
    assert.equal((await toolCall(agent, "end_walk", { pee: 1, mood: "calm" }, "task-end")).isError, undefined);

    const uiWalks = await readWalks(ui.app.app, context);
    const agentWalks = await readWalks(agent.app.app, context);
    assert.equal(agentWalks.walks.length, 1);
    assert.equal(
      payload(agentWalks.walks, WALK_PROVENANCE),
      payload(uiWalks.walks, WALK_PROVENANCE),
      "the same start and end instants and observations — byte for byte",
    );
    assert.equal(uiWalks.walks[0]!.startedByLabel, "Alex");
    assert.equal(agentWalks.walks[0]!.startedByLabel, "Household");
    assert.match(uiWalks.walks[0]!.startedActionId, /^http:/);
    assert.match(agentWalks.walks[0]!.startedActionId, /^tool:/);
  } finally {
    await ui.stop();
    await agent.stop();
  }
});

// --- growth -----------------------------------------------------------------

test("growth: the route and the tool commit one identical measurement", async () => {
  const [ui, agent] = await bootPair("pupkeep-dual-growth");
  try {
    const logged = await mutate(
      ui,
      "POST",
      "/api/growth",
      { weightKg: 4.25, heightCm: 31.5, note: "after a nap" },
      "weigh-1",
    );
    assert.equal(logged.status, 200);

    const measured = await toolCall(
      agent,
      "log_measurement",
      { weightKg: 4.25, heightCm: 31.5, note: "after a nap" },
      "task-weigh",
    );
    assert.equal(measured.isError, undefined);

    const uiGrowth = await readGrowth(ui.app.app, context);
    const agentGrowth = await readGrowth(agent.app.app, context);
    assert.equal(agentGrowth.measurements.length, 1);
    assert.equal(
      payload(agentGrowth.measurements, EVENT_PROVENANCE),
      payload(uiGrowth.measurements, EVENT_PROVENANCE),
      "the same grams, centimetres, note and household-local date — byte for byte",
    );
    assert.equal(uiGrowth.measurements[0]!.source, "ui");
    assert.equal(agentGrowth.measurements[0]!.source, "agent");
    assert.equal(uiGrowth.measurements[0]!.localDate, "2026-10-30");
    assert.equal(agentGrowth.measurements[0]!.localDate, "2026-10-30");
    // The actor is provenance too: the route is the signed-in member, the tool
    // with no chat entry is the §9.2 household fallback.
    assert.equal(uiGrowth.measurements[0]!.byLabel, "Alex");
    assert.equal(uiGrowth.measurements[0]!.byUserId, "owner");
    assert.equal(agentGrowth.measurements[0]!.byLabel, "Household");
    assert.equal(agentGrowth.measurements[0]!.byUserId, null);
  } finally {
    await ui.stop();
    await agent.stop();
  }
});

// --- milestones -------------------------------------------------------------

test("milestones: the route and the tool commit one identical status change and custom entry", async () => {
  const [ui, agent] = await bootPair("pupkeep-dual-training");
  try {
    const changed = await mutate(
      ui,
      "POST",
      "/api/training/milestone",
      { milestoneId: "catalog:sit", status: "mastered", note: "steady now" },
      "milestone-1",
    );
    assert.equal(changed.status, 200);
    const added = await mutate(ui, "POST", "/api/training/custom", { title: "Roll over" }, "milestone-custom");
    assert.equal(added.status, 200);

    const updated = await toolCall(
      agent,
      "update_milestone",
      { milestoneId: "catalog:sit", status: "mastered", note: "steady now" },
      "task-milestone",
    );
    assert.equal(updated.isError, undefined);
    const addedByTool = await toolCall(agent, "add_milestone", { title: "Roll over" }, "task-custom");
    assert.equal(addedByTool.isError, undefined);

    const uiTraining = await readTraining(ui.app.app, context);
    const agentTraining = await readTraining(agent.app.app, context);
    assert.equal(agentTraining.states.length, 1);
    assert.equal(
      payload(agentTraining.states, STATE_PROVENANCE),
      payload(uiTraining.states, STATE_PROVENANCE),
      "the same milestone, status, note and mastery instant — byte for byte",
    );
    // The household's own milestone is the other half of `app.training`.
    assert.equal(agentTraining.custom.length, 1);
    assert.equal(
      payload(agentTraining.custom, CUSTOM_PROVENANCE),
      payload(uiTraining.custom, CUSTOM_PROVENANCE),
      "the same custom title and creation instant — byte for byte",
    );
    assert.equal(uiTraining.custom[0]!.title, "Roll over");
    assert.match(uiTraining.custom[0]!.id, /^custom:/);
    assert.equal(uiTraining.states[0]!.source, "ui");
    assert.equal(agentTraining.states[0]!.source, "agent");
    assert.equal(uiTraining.states[0]!.id, "catalog:sit", "the catalog id stays domain data");
    assert.equal(uiTraining.states[0]!.byLabel, "Alex");
    assert.equal(agentTraining.states[0]!.byLabel, "Household");
    assert.equal(agentTraining.states[0]!.byUserId, null);
  } finally {
    await ui.stop();
    await agent.stop();
  }
});

// --- showers ----------------------------------------------------------------

test("showers: the route and the tool commit one identical shower", async () => {
  const [ui, agent] = await bootPair("pupkeep-dual-shower");
  try {
    const logged = await mutate(
      ui,
      "POST",
      "/api/showers",
      { shampoo: "Oatmeal", notes: "towel dry" },
      "shower-1",
    );
    assert.equal(logged.status, 200);

    const washed = await toolCall(agent, "log_shower", { shampoo: "Oatmeal", notes: "towel dry" }, "task-shower");
    assert.equal(washed.isError, undefined);

    const uiShowers = await readShowers(ui.app.app, context);
    const agentShowers = await readShowers(agent.app.app, context);
    assert.equal(agentShowers.showers.length, 1);
    assert.equal(
      payload(agentShowers.showers, EVENT_PROVENANCE),
      payload(uiShowers.showers, EVENT_PROVENANCE),
      "the same shampoo, note, household-local date and instant — byte for byte",
    );
    assert.equal(uiShowers.showers[0]!.source, "ui");
    assert.equal(agentShowers.showers[0]!.source, "agent");
    assert.equal(uiShowers.showers[0]!.localDate, "2026-10-30");
    assert.equal(agentShowers.showers[0]!.localDate, "2026-10-30");
    assert.equal(uiShowers.showers[0]!.byLabel, "Alex");
    assert.equal(agentShowers.showers[0]!.byLabel, "Household");
    assert.equal(agentShowers.showers[0]!.byUserId, null);
  } finally {
    await ui.stop();
    await agent.stop();
  }
});
