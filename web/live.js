// Live care state for the whole shell (PLAN §9.4 as extended by P1-11).
//
// One authenticated EventSource carries the shared thread's events and the
// committed care state. The Agent screen subscribes to the same connection
// through `subscribeThread`, so there is exactly one stream, one reconnect
// policy and one per-member connection cap — two connections from one tab would
// spend two of the four slots the server allows and make an eviction more
// likely for no benefit.
//
// Frames the shell does not render yet are ignored, never fatal: an event name
// without a listener is simply not delivered, and a malformed payload must not
// take the page down.

import { requestJson } from "./client.js";
import { refreshUnread as readUnread } from "./notifications.js";
import { isNewer } from "./profile-form.js";
import { getState, setState } from "./store.js";

const RECONNECT_DELAY_MS = 1000;

/**
 * Thread listeners, notified by the one stream `startLive` owns. The payloads
 * mirror the server's wire contract (thread.ts / http.ts `writeEvent`):
 *
 *   { type: "snapshot", snapshot }  the authoritative thread snapshot
 *   { type: "batch", seq, events }  one commit's Pi Durable events
 *   { type: "open" }                the connection opened or re-opened
 *   { type: "reconnect" }           the server asked the client to reattach
 *   { type: "error" }               the browser is retrying the connection
 */
const threadListeners = new Set();

function notifyThread(event) {
  for (const listener of [...threadListeners]) {
    try {
      listener(event);
    } catch {
      // One broken listener must not starve the others or the care frames.
    }
  }
}

/** Subscribe an Agent screen to the shared thread's live frames. */
export function subscribeThread(listener) {
  threadListeners.add(listener);
  return () => threadListeners.delete(listener);
}

function parsedThreadFrame(event, notify) {
  try {
    notify(JSON.parse(event.data));
  } catch {
    // Ignore one bad frame; the next snapshot or a reload re-syncs.
  }
}

/**
 * Apply a whole care view, never backwards. A reconnect's `GET` and the stream
 * that follows it can arrive in either order (a flapping tunnel is the usual
 * way), so arrival order is not freshness order: the three document revisions
 * decide. Returns whether the view was applied.
 */
export function applyCareView(view) {
  if (!view || typeof view.rev !== "number") return false;
  if (!isNewer(view, getState().profile)) return false;
  // Every applied view bumps the sequence, even when the payload is identical
  // (a feed changes no revision): views that read a document the frame does not
  // carry use it as the "re-read" signal.
  setState({ profile: view, careSeq: getState().careSeq + 1 });
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
  const refreshBadge = deps.refreshUnread ?? readUnread;
  // A browser without EventSource keeps working: the views fetch on mount.
  const makeSource =
    deps.createSource ?? (typeof EventSource === "function" ? (url) => new EventSource(url) : undefined);
  if (!makeSource) {
    // Still read the care state once: the shell's Today gate and the setup
    // checklist (P1-14) are decided from this view, and without it they would
    // stay on "not read yet" forever.
    void refresh();
    void refreshBadge();
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
      notifyThread({ type: "open" });
      void refresh();
      void refreshBadge();
    });

    // The server's first frame: the whole thread, so a missed delta cannot
    // leave half-old state on screen.
    source.addEventListener("snapshot", (event) => {
      parsedThreadFrame(event, (snapshot) => notifyThread({ type: "snapshot", snapshot }));
    });

    // One commit's raw Pi Durable events. The Agent screen is the one place
    // that understands them; the shell itself only cares about `profile`.
    source.addEventListener("batch", (event) => {
      parsedThreadFrame(event, (batch) => notifyThread({ type: "batch", ...batch }));
    });

    // The browser is retrying by itself; tell the Agent screen so it can show a
    // polite reconnecting state rather than an unexplained gap.
    source.addEventListener("error", () => {
      notifyThread({ type: "error" });
    });

    // A full view, not a delta: applying it is a replacement, so a missed frame
    // cannot leave half-old state on screen.
    source.addEventListener("profile", (event) => {
      try {
        applyCareView(JSON.parse(event.data));
      } catch {
        // Ignore one bad frame; the next commit or a reload re-syncs.
      }
      // The badge is a second, cheap read: the frame carries no notification
      // data, and a care action may have added one.
      void refreshBadge();
    });

    // The server is restarting or shutting down: it asked us to reattach. The
    // browser's own retry would replay the same dead connection, so close and
    // open a fresh one instead (which starts from a fresh snapshot).
    source.addEventListener("reconnect", () => {
      notifyThread({ type: "reconnect" });
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
