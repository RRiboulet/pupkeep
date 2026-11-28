// The client state store: a tiny observable for the shell, deliberately no
// framework and no build step. P1-09/P1-11 fill the slice of state that comes
// from the server (shared thread, live profile) but keep this shape, and the
// plan's "online-only, no offline writes" rule lives here too: there is no
// persistence layer to replay anything from, and the connection flag is the
// only piece of local state the UI trusts.

export const ROUTES = [
  { id: "today", label: "Today", view: "Today" },
  { id: "calendar", label: "Calendar", view: "Calendar" },
  { id: "pup", label: "Pup", view: "Pup profile" },
  { id: "agent", label: "Agent", view: "Shared thread" },
  { id: "notifications", label: "Notifications", view: "Notification centre" },
  { id: "settings", label: "Settings", view: "Settings" },
  // The mandatory first-launch page is a real route, but it is not a tab: the
  // shell forces every address here while setup is incomplete, and forces
  // `#/setup` back to Today once it is complete (the P1-14 reversal).
  { id: "setup", label: "First-run setup", view: "First-run setup" },
];

const ROUTE_IDS = new Set(ROUTES.map((route) => route.id));

export function hashRoute(hash) {
  // `globalThis.location` so the store (and every view importing it) loads in a
  // plain Node test; a browser always has it.
  const raw = String(hash ?? globalThis.location?.hash ?? "").replace(/^#\/?/, "");
  return ROUTE_IDS.has(raw) ? raw : "today";
}

/**
 * The shell's gate (the mandatory first-run setup, R1/R2). Given the route in
 * state and the latest profile, which screen does the shell paint?
 *
 *   - `"loading"`: no profile has been read yet, so no decision can be made
 *     and no view may flash — a household that finished setup months ago must
 *     not see Today (or the nav) flicker before the first read lands;
 *   - `"setup"`: setup is incomplete, so the whole app is the setup page and
 *     no navigation renders, whatever the route said;
 *   - otherwise the route itself, with `#/setup` answered by Today.
 */
export function gatedRoute(route, profile) {
  if (profile === null || profile === undefined) return { screen: "loading" };
  if (profile.setup?.complete === false) return { screen: "setup" };
  if (route === "setup") return { screen: "today" };
  return { screen: route };
}

/**
 * The gate's URL half (R1/R2): the browser's address must agree with the
 * gated screen, so a reload, a bookmark or back/forward all land where the
 * gate says. A no-op when they already agree — assigning the same hash fires
 * no `hashchange` and adds no history entry.
 */
export function reconcileHash(route, profile) {
  const location = globalThis.location;
  if (!location || profile === null || profile === undefined) return;
  if (profile.setup?.complete === false) {
    if (hashRoute() !== "setup") location.hash = "#/setup";
    return;
  }
  if (route === "setup" && hashRoute() !== "today") location.hash = "#/today";
}

const state = {
  route: hashRoute(),
  // Node has a `navigator` without `onLine`; a browser always has it.
  online: globalThis.navigator?.onLine !== false,
  /**
   * The last committed puppy profile (P1-11). `null` until the first read or
   * frame; a view fetches it itself and live updates arrive from `live.js`.
   */
  profile: null,
  /**
   * How many care views have been applied (P2-05). A feed does not bump any
   * document revision, so a frame can be value-identical to the one before it:
   * this counter, not the profile object, is what tells a view "a commit
   * happened, re-read if you depend on one the frame does not carry".
   */
  careSeq: 0,
  /**
   * The unread notification count for the nav badge (P4-06). Read from the
   * count-only route; 0 until the first read.
   */
  unreadNotifications: 0,
  /**
   * `/api/puppy` answered 401, so the shell's loading screen says so instead
   * of spinning forever: before the gate, every view fetched its own 401 and
   * the shell painted a screen to put the sentence in.
   */
  signedOut: false,
};

const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in state) || state[key] === value) continue;
    state[key] = value;
    changed = true;
  }
  if (changed) for (const listener of listeners) listener(state);
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
