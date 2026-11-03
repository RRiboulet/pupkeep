// Live care state for the whole shell (PLAN §9.4 as extended by P1-11).
//
// One authenticated EventSource carries the shared thread's events and the
// committed care state. This module only understands the `profile` frame today;
// the thread renderer will subscribe to the same connection when its own task
// lands, so there is exactly one stream, one reconnect policy and one
// per-member connection cap.
//
// Frames the shell does not render yet are ignored, never fatal: an event name
// without a listener is simply not delivered, and a malformed payload must not
// take the page down.

import { requestJson } from "./client.js";
import { isNewer } from "./profile-form.js";
import { getState, setState } from "./store.js";

const RECONNECT_DELAY_MS = 1000;

/**
 * Apply a whole care view, never backwards. A reconnect's `GET` and the stream
 * that follows it can arrive in either order (a flapping tunnel is the usual
 * way), so arrival order is not freshness order: the three document revisions
 * decide. Returns whether the view was applied.
 */
export function applyCareView(view) {
  if (!view || typeof view.rev !== "number") return false;
  if (!isNewer(view, getState().profile)) return false;
  setState({ profile: view });
  return true;
}

/**
 * Read the profile once. Called on every (re)connect, because a commit that
 * lands while the stream is down is not replayed: the next connection starts
 * from the thread's snapshot, which carries no care state. One GET is cheaper
 * than either a stale caregiver list or a full page reload.
 */
export async function refreshProfile() {
  try {
    const result = await requestJson("/api/puppy");
    if (!result.ok || result.status === 401) return;
    applyCareView(result.body);
  } catch {
    // Offline: the next connect or a reload catches up.
  }
}

/**
 * Open the stream and keep it open. Returns a handle with `close()` for tests
 * and for a future sign-out; the caller normally ignores it.
 *
 * `deps` is a test seam, not a configuration: production passes nothing.
 */
export function startLive(deps = {}) {
  const refresh = deps.refresh ?? refreshProfile;
  // A browser without EventSource keeps working: the views fetch on mount.
  const makeSource =
    deps.createSource ?? (typeof EventSource === "function" ? (url) => new EventSource(url) : undefined);
  if (!makeSource) {
    // Still read the care state once: the shell's Today gate and the setup
    // checklist (P1-14) are decided from this view, and without it they would
    // stay on "not read yet" forever.
    void refresh();
    return { close() {} };
  }
  let source = null;
  let retry = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    source = makeSource("/api/agent/events");

    // Fires on the first connection and on every automatic reconnect.
    source.addEventListener("open", () => {
      void refresh();
    });

    // A full view, not a delta: applying it is a replacement, so a missed frame
    // cannot leave half-old state on screen.
    source.addEventListener("profile", (event) => {
      try {
        applyCareView(JSON.parse(event.data));
      } catch {
        // Ignore one bad frame; the next commit or a reload re-syncs.
      }
    });

    // The server is restarting or shutting down: it asked us to reattach. The
    // browser's own retry would replay the same dead connection, so close and
    // open a fresh one instead (which starts from a fresh snapshot).
    source.addEventListener("reconnect", () => {
      source?.close();
      source = null;
      if (retry !== null) clearTimeout(retry);
      retry = setTimeout(open, RECONNECT_DELAY_MS);
    });
  };

  open();

  return {
    close() {
      closed = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      source?.close();
      source = null;
    },
  };
}
