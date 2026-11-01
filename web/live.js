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

import { setState } from "./store.js";

const RECONNECT_DELAY_MS = 1000;

/**
 * Open the stream and keep it open. Returns a handle with `close()` for tests
 * and for a future sign-out; the caller normally ignores it.
 */
export function startLive() {
  if (typeof EventSource !== "function") return { close() {} };

  let source = null;
  let retry = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    source = new EventSource("/api/agent/events");

    // A full view, not a delta: applying it is a replacement, so a missed frame
    // cannot leave half-old state on screen.
    source.addEventListener("profile", (event) => {
      try {
        const profile = JSON.parse(event.data);
        if (profile && typeof profile.rev === "number") setState({ profile });
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
