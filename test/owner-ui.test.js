// The owner's UI against a real server, through the real client (PLAN §15.1).
//
// Why this file exists, and why it is not covered twice:
//   * `test/client.test.js` drives every view with a fake `request`, and the
//     `*-routes` suites drive the server with hand-built requests. Neither
//     exercises `web/client.js`, the seam between them — so a change in how the
//     browser encodes a request passes both suites and only fails in a browser.
//     That is exactly what happened in P4-06: the Settings test button is a POST
//     with no body, the client sent no content type for it, the server refused
//     with 415, and both suites stayed green.
//   * here the real views call the real `requestJson`, which reaches a real app
//     over HTTP with a real session cookie. Only what a browser supplies and
//     Node does not is bridged: a relative URL, the session cookie, and the
//     `Origin` header on a mutation.
//   * the transport contract itself (the guard's two headers, a body where a
//     route reads one, a key replay, a 401 as an answer) is asserted first, so a
//     future view cannot quietly depend on a request shape nothing sends.
//
// Plain JavaScript because `web/` is excluded from `tsc`; Node runs the
// TypeScript imports directly through type stripping.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import { startTestApp } from "./support/app.ts";
import { NetworkError, newIdempotencyKey, requestJson } from "../web/client.js";
import { Agent } from "../web/views/agent.js";
import { Invite } from "../web/views/invite.js";
import { Notifications } from "../web/views/notifications.js";
import { Settings } from "../web/views/settings.js";
import { Showers } from "../web/views/showers.js";
import { Today } from "../web/views/today.js";

/** The real fetch, captured before any test replaces it. */
const realFetch = globalThis.fetch;

/**
 * Boot one app and point the browser client at it. `requestJson` asks `fetch`
 * for a relative path and lets the browser attach the cookie and the `Origin`
 * header; the bridge adds exactly those, records what went on the wire, and
 * leaves everything else to the app's own code.
 */
async function ownerUi(options = {}) {
  const app = await startTestApp({
    prefix: "pupkeep-owner-ui-",
    ...(options.responses === undefined ? {} : { responses: options.responses }),
  });
  const cookie =
    options.anonymous === true
      ? null
      : options.role === "partner"
        ? app.cookies.partner
        : app.cookies.owner;

  /** Every request the client made: method, absolute URL, headers, raw body. */
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), app.url).toString();
    const headers = new Headers(init.headers ?? {});
    if (typeof cookie === "string") headers.set("Cookie", `${SESSION_COOKIE}=${cookie}`);
    const method = String(init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") headers.set("Origin", app.url);
    sent.push({ method, url, headers: Object.fromEntries(headers), body: init.body });
    return realFetch(url, { ...init, headers });
  };

  let closed = false;
  return {
    app,
    sent,
    async close() {
      if (closed) return;
      closed = true;
      globalThis.fetch = realFetch;
      await app.stop();
    },
  };
}

/**
 * A mounted-enough view: the real class, its real action methods, and the real
 * client. Only `setState` is replaced, because there is no renderer here — the
 * same seam `client.test.js` uses for its fake-request tests.
 */
function mount(View, props = {}, state = {}) {
  const view = new View(props);
  view.request = requestJson;
  view.state = { ...view.state, ...state };
  view.setState = (patch, callback) => {
    Object.assign(view.state, typeof patch === "function" ? patch(view.state) : patch);
    if (typeof callback === "function") callback();
  };
  return view;
}

/** A raw mutation against the app, for the guard's own refusals. */
function rawMutation(ui, headers = {}) {
  return realFetch(`${ui.app.url}/api/notifications/test`, {
    method: "POST",
    headers: {
      Cookie: `${SESSION_COOKIE}=${ui.app.cookies.owner}`,
      Origin: ui.app.url,
      "Idempotency-Key": newIdempotencyKey(),
      ...headers,
    },
  });
}

// --- the transport contract ------------------------------------------------

test("the test-notification button is a bodyless POST the server accepts", async () => {
  const ui = await ownerUi();
  try {
    const settings = mount(Settings);
    await settings.test();
    assert.equal(settings.state.error, null, "the view reported no failure");
    assert.match(String(settings.state.message), /Test queued/);

    const centre = await requestJson("/api/notifications");
    assert.equal(centre.status, 200);
    assert.ok(
      centre.body.items.some((item) => item.category === "test"),
      "the test item is in the centre",
    );
  } finally {
    await ui.close();
  }
});

test("the guard's two headers are what the client always sends", async () => {
  const ui = await ownerUi();
  try {
    assert.equal((await rawMutation(ui)).status, 403, "without X-Pupkeep-Request a mutation is forbidden");
    assert.equal(
      (await rawMutation(ui, { "X-Pupkeep-Request": "1" })).status,
      415,
      "without a JSON content type it is unsupported",
    );
    assert.equal(
      (await rawMutation(ui, { "X-Pupkeep-Request": "1", "Content-Type": "application/json" })).status,
      200,
      "with both, even a bodyless mutation is accepted",
    );
  } finally {
    await ui.close();
  }
});

test("a content type is not a substitute for a body where the route reads one", async () => {
  const ui = await ownerUi();
  try {
    const result = await requestJson("/api/notifications/read", {
      method: "POST",
      idempotencyKey: newIdempotencyKey(),
    });
    assert.equal(result.status, 409);
    assert.match(String(result.body.error), /a body is required/);
  } finally {
    await ui.close();
  }
});

test("a read carries neither the mutation header nor a content type", async () => {
  const ui = await ownerUi();
  try {
    const read = await requestJson("/api/notifications");
    assert.equal(read.status, 200);
    const last = ui.sent.at(-1);
    assert.equal(last.method, "GET");
    assert.equal(last.headers["accept"], "application/json");
    assert.equal(last.headers["x-pupkeep-request"], undefined);
    assert.equal(last.headers["content-type"], undefined);
  } finally {
    await ui.close();
  }
});

test("a missing session is an answer, and only a dead connection throws", async () => {
  const anonymous = await ownerUi({ anonymous: true });
  try {
    const refused = await requestJson("/api/notifications");
    assert.equal(refused.status, 401, "signed out is a status the UI can render");
    assert.equal(typeof refused.body?.error, "string");
  } finally {
    await anonymous.close();
  }

  // A server that is gone is the one case with nothing to switch on.
  const app = await startTestApp({ prefix: "pupkeep-owner-ui-dead-" });
  await app.stop();
  const url = app.url;
  globalThis.fetch = (input, init) => realFetch(new URL(String(input), url).toString(), init);
  try {
    await assert.rejects(() => requestJson("/api/notifications"), NetworkError);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("one key and one body are one shower, and the retry says so", async () => {
  const ui = await ownerUi();
  try {
    const key = newIdempotencyKey();
    const body = { shampoo: "oatmeal" };
    const first = await requestJson("/api/showers", { method: "POST", body, idempotencyKey: key });
    assert.equal(first.status, 200);
    assert.equal(first.body.replayed, false);

    const retry = await requestJson("/api/showers", { method: "POST", body, idempotencyKey: key });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.replayed, true);

    const history = await requestJson("/api/showers");
    assert.equal(history.body.history.length, 1, "the retry committed nothing");
  } finally {
    await ui.close();
  }
});

// --- the owner's screens ----------------------------------------------------

test("the owner's message reaches the shared thread through the real client", async () => {
  const ui = await ownerUi({ responses: [() => fauxAssistantMessage("Noted.")] });
  try {
    const agent = mount(Agent, {}, { loading: false, draft: "is it walk time?" });
    agent.unmounted = false;
    agent.loadThread = async () => {};

    await agent.send();
    assert.equal(agent.state.sendError, null);
    assert.equal(agent.state.sending, false);
    assert.equal(agent.state.draft, "", "an accepted message clears the composer");

    const thread = await requestJson("/api/agent/thread");
    const chat = thread.body.entries.filter((entry) => entry.kind === "chat");
    assert.equal(chat.length, 1);
    assert.equal(chat[0].text, "is it walk time?");
    assert.equal(chat[0].authorId, "owner");
  } finally {
    await ui.close();
  }
});

test("a message retried with the same clientMessageId is one entry", async () => {
  const ui = await ownerUi({ responses: [() => fauxAssistantMessage("Noted.")] });
  try {
    const key = newIdempotencyKey();
    const body = { text: "double tap", clientMessageId: key };
    const first = await requestJson("/api/agent/messages", { method: "POST", body, idempotencyKey: key });
    assert.equal(first.status, 202);

    // The retry may be refused as busy; either way it must not place a second entry.
    const retry = await requestJson("/api/agent/messages", { method: "POST", body, idempotencyKey: key });
    assert.ok([202, 409].includes(retry.status), `the retry answers a status, not a crash: ${retry.status}`);

    const thread = await requestJson("/api/agent/thread");
    const placed = thread.body.entries.filter((entry) => entry.kind === "chat" && entry.text === "double tap");
    assert.equal(placed.length, 1, "the key deduped the retry");
  } finally {
    await ui.close();
  }
});

test("the notification centre reads, and marking all read clears the badge", async () => {
  const ui = await ownerUi();
  try {
    const queued = await requestJson("/api/notifications/test", {
      method: "POST",
      idempotencyKey: newIdempotencyKey(),
    });
    assert.equal(queued.status, 200);

    const view = mount(Notifications, {}, { loading: true });
    await view.load();
    assert.equal(view.state.loading, false);
    assert.equal(view.state.error, null);
    assert.equal(view.state.unread, 1);

    await view.markRead(undefined, true);
    assert.equal(view.state.busy, null);
    // The card re-reads after a mark rather than trusting the answer's count.
    await view.load();
    assert.equal(view.state.unread, 0);
    assert.ok(view.state.items.every((item) => item.readAt !== null), "every item is read");
  } finally {
    await ui.close();
  }
});

test("the owner's monthly cap is saved and read back", async () => {
  const ui = await ownerUi();
  try {
    const settings = mount(Settings);
    await settings.loadModels();
    assert.equal(settings.state.role, "owner");
    assert.equal(settings.state.modelsError, null);

    settings.setState({ capDraft: "12.50" });
    await settings.saveCap();
    assert.equal(settings.state.modelsError, null);
    assert.equal(settings.state.modelsMessage, "Monthly cap saved.");

    const budget = await requestJson("/api/budget");
    assert.equal(budget.body.budget.capUsd, 12.5);
  } finally {
    await ui.close();
  }
});

test("logging a shower from the card commits one shower", async () => {
  const ui = await ownerUi();
  try {
    const showers = mount(Showers, {});
    await showers.save({ preventDefault() {} });
    assert.equal(showers.state.error, null);
    assert.equal(showers.state.message, "Logged.");

    const view = await requestJson("/api/showers");
    assert.equal(view.body.history.length, 1);
    assert.equal(view.body.history[0].source, "ui");
  } finally {
    await ui.close();
  }
});

test("the owner's invite mints a link the card can show once", async () => {
  const ui = await ownerUi();
  try {
    const invite = mount(Invite, { role: "owner" }, { name: "Sam" });
    await invite.createInvite();
    assert.equal(invite.state.error, null);
    assert.match(String(invite.state.link), /\/invite\?code=/);
    assert.equal(invite.state.name, "", "the name field is cleared");
    assert.match(String(invite.state.message), /expires in/);
  } finally {
    await ui.close();
  }
});

test("the owner's Today card feeds a meal and walks the dog", async () => {
  const ui = await ownerUi();
  try {
    // A fresh household has no meal schedule until setup writes one.
    const profile = await requestJson("/api/puppy");
    const seeded = await requestJson("/api/feeding/slots", {
      method: "PATCH",
      body: {
        rev: profile.body.meals.rev,
        slots: [{ id: "slot-breakfast", label: "Breakfast", timeLocal: "07:00", active: true }],
      },
      idempotencyKey: newIdempotencyKey(),
    });
    assert.equal(seeded.status, 200, "the meal schedule is set for the fixture");

    const today = mount(Today, {}, { loading: false });
    await today.load();
    assert.equal(today.state.error, null);
    const slot = today.state.day.slots[0]?.slot;
    assert.ok(slot, "the household has a meal slot to feed");

    await today.markFed(slot.id);
    assert.equal(today.state.error, null);
    assert.ok(
      today.state.day.slots.find((entry) => entry.slot.id === slot.id)?.feed,
      "the committed day carries the feed",
    );

    await today.startWalk();
    assert.equal(today.state.walkError, null);
    assert.ok(today.state.walk?.open, "a walk is open");
    await today.endWalk();
    assert.equal(today.state.walkError, null);
    assert.equal(today.state.walk?.open ?? null, null, "the walk is closed");
  } finally {
    await ui.close();
  }
});
