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
  { id: "settings", label: "Settings", view: "Settings" },
];

const ROUTE_IDS = new Set(ROUTES.map((route) => route.id));

export function hashRoute(hash) {
  // `globalThis.location` so the store (and every view importing it) loads in a
  // plain Node test; a browser always has it.
  const raw = String(hash ?? globalThis.location?.hash ?? "").replace(/^#\/?/, "");
  return ROUTE_IDS.has(raw) ? raw : "today";
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
