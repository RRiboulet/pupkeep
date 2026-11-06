// The notification centre's pure half (PLAN §12.3, §13.1, §16 P4-06).
//
// What a Node test can pin without a browser: the category labels, the unread
// count, the prefs body, the test/intent request shapes and the "when" copy for a
// stored intent. The view in `views/notifications.js` and the Settings card turn
// these into elements.
//
// The badge is the one piece the shell needs everywhere: `refreshUnread` reads
// the count-only route and publishes it to the store, so the nav can show it
// without loading the list. Like `meals.js`, this module imports no Preact.

import { requestJson } from "./client.js";
import { dateText, localDate, localTimeText } from "./clock.js";
import { getState, setState } from "./store.js";

/** §12.1's vocabulary as a caregiver sees it. */
export const CATEGORY_LABELS = {
  appointment: "Appointments",
  feed_overdue: "Missed meals",
  fed: "Meals logged",
  approval: "Confirmations",
  test: "Test",
};

/** The order Settings offers; the catalog's own order. */
export const CATEGORY_ORDER = ["appointment", "feed_overdue", "fed", "approval", "test"];

/** The labels a prefs checkboxes list uses (every §12.1 category). */
export function categoryOptions(selected) {
  const chosen = new Set(selected ?? []);
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    checked: chosen.has(category),
  }));
}

/** How many of `items` are unread; the badge's number. */
export function unreadOf(items) {
  return (items ?? []).filter((item) => item.readAt === null).length;
}

/** The PATCH body for prefs; duplicates and unknown categories are dropped. */
export function prefsBody(enabled, categories) {
  const seen = new Set();
  const list = [];
  for (const category of categories ?? []) {
    if (!(category in CATEGORY_LABELS) || seen.has(category)) continue;
    seen.add(category);
    list.push(category);
  }
  return { enabled: enabled === true, categories: list };
}

/** The PUT body for an ntfy topic; an empty field clears it. */
export function ntfyBody(topic) {
  const text = String(topic ?? "").trim();
  return { topic: text === "" ? null : text };
}

/**
 * When an intent was made, in the household zone (never the device's). The date
 * must come from the same zone as the time: after local midnight in a zone ahead
 * of UTC, the UTC date is still yesterday.
 */
export function intentWhenText(createdAt, timezone) {
  if (typeof createdAt !== "string") return "";
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return "";
  const day = localDate(at, timezone) ?? at.toISOString().slice(0, 10);
  const date = dateText(day);
  const time = localTimeText(at, timezone);
  return /^\d{2}:\d{2}$/.test(time) ? `${date} ${time}` : date;
}

/**
 * Read the unread count for the nav badge. A failure is silent: a stale badge
 * is better than an error banner on every page, and the next frame retries.
 */
export async function refreshUnread(request = requestJson) {
  try {
    const result = await request("/api/notifications/unread");
    if (!result.ok || typeof result.body?.unread !== "number") return;
    setState({ unreadNotifications: result.body.unread });
  } catch {
    // Offline: the next connect or commit refreshes the badge.
  }
}

/** The badge's text: `""` under one, `9+` above nine. */
export function badgeText(unread) {
  const count = Math.max(0, Math.trunc(Number(unread) || 0));
  if (count === 0) return "";
  return count > 9 ? "9+" : String(count);
}

