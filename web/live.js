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

// A stream can connect and then deliver nothing at all. Cloudflare's quick
// tunnel buffers a streaming GET response: the client sees the `200` and the
// headers, then no body bytes — not the snapshot frame, not the heartbeat
// (cloudflared#1449). A healthy stream is chatty, so silence is diagnosable:
//
//   * `handleEvents` writes its headers, a `retry:` comment and then the
//     snapshot in one synchronous block, so an open stream has a frame within
//     milliseconds; 5 s without one means the response body is being held;
//   * the server's heartbeat is every 15 s (`KEEPALIVE_MS` in
//     `src/server/http.ts`), so 20 s without any frame means the transport is
//     buffering, not merely idle.
//
// The fallback polls the care state every 4 s (cheap document reads) and probes
// the stream again once a minute: a quick tunnel is fixed by a restart or by
// switching to the daily Tailscale path, and a probe that receives its snapshot
// switches the page back to live frames without a reload.
const FIRST_FRAME_MS = 5_000;
const SILENCE_MS = 20_000;
const POLL_MS = 4_000;
const RETRY_MS = 60_000;

/**
 * Whether the one live transport has fallen back to polling. A view mounted
 * after the fallback began has no `open`/`poll` frame to learn this from, so it
 * asks here before deciding whether to start its own poll loop.
 */
let polling = false;
export function isPolling() {
  return polling;
}

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

  const firstFrameMs = deps.firstFrameMs ?? FIRST_FRAME_MS;
  const silenceMs = deps.silenceMs ?? SILENCE_MS;
  const pollMs = deps.pollMs ?? POLL_MS;
  const retryMs = deps.retryMs ?? RETRY_MS;

  let source = null;
  let probe = null;
  let retry = null;
  let watchdog = null;
  let pollTimer = null;
  let probeTimer = null;
  let closed = false;
  // One process, one tab, one transport: a fresh `startLive` owns the mode.
  polling = false;

  const clearTimer = (handle) => {
    if (handle !== null) clearTimeout(handle);
    return null;
  };

  const stopWatchdog = () => {
    watchdog = clearTimer(watchdog);
  };

  // The stream is healthy until it stays silent: `firstFrameMs` after `open`,
  // then `silenceMs` after every frame. A callback only ever enters polling.
  const armWatchdog = (ms) => {
    stopWatchdog();
    if (closed || polling) return;
    watchdog = setTimeout(() => {
      watchdog = null;
      if (!closed && !polling) enterPolling();
    }, ms);
  };

  const stopPollLoop = () => {
    pollTimer = clearTimer(pollTimer);
  };

  // In polling mode one tab holds a long-poll slot (`agent.js`) plus this
  // fallback's probe for up to `firstFrameMs` every `retryMs`. Two tabs of one
  // caregiver can therefore reach the server's four-per-member cap briefly;
  // the cap evicts the oldest connection rather than failing, so the evicted
  // poll answers 503 and the Agent screen retries on its next tick.
  const startPollLoop = () => {
    const tick = async () => {
      if (closed || !polling) return;
      try {
        await refresh();
        await refreshBadge();
      } catch {
        // A failed poll is not fatal; the next tick tries again.
      }
      if (closed || !polling) return;
      pollTimer = setTimeout(tick, pollMs);
    };
    pollTimer = setTimeout(tick, pollMs);
  };

  const scheduleRetry = () => {
    if (closed || !polling || retry !== null) return;
    retry = setTimeout(() => {
      retry = null;
      openProbe();
    }, retryMs);
  };

  // A probe is a throwaway EventSource: it either delivers its snapshot within
  // `firstFrameMs` (and becomes the live source) or it is closed and the next
  // probe is scheduled, without disturbing the care poll loop.
  const armProbe = (candidate) => {
    probeTimer = clearTimer(probeTimer);
    if (closed || probe !== candidate) return;
    probeTimer = setTimeout(() => {
      probeTimer = null;
      if (closed || probe !== candidate) return;
      probe = null;
      candidate.close();
      scheduleRetry();
    }, firstFrameMs);
  };

  const openProbe = () => {
    if (closed || !polling) return;
    const candidate = makeSource("/api/agent/events");
    probe = candidate;
    attach(candidate);
    armProbe(candidate);
  };

  // The probe is alive again: stop the care poll loop and the retry timer, keep
  // the new source, and tell the Agent screen so it can run its catch-up reads.
  const promote = (candidate) => {
    if (closed || probe !== candidate) return;
    probe = null;
    probeTimer = clearTimer(probeTimer);
    polling = false;
    stopPollLoop();
    retry = clearTimer(retry);
    source = candidate;
    notifyThread({ type: "open" });
    void refresh();
    void refreshBadge();
  };

  const enterPolling = () => {
    if (closed || polling) return;
    polling = true;
    stopWatchdog();
    if (source !== null) {
      source.close();
      source = null;
    }
    retry = clearTimer(retry);
    notifyThread({ type: "poll" });
    startPollLoop();
    scheduleRetry();
  };

  /**
   * Wire one EventSource. The same handlers serve the live source and a probe:
   * `active` drops frames from a connection that has been replaced. Every
   * event that carries a body frame (`snapshot`, `batch`, `heartbeat`,
   * `profile`) proves the body is flowing and restarts the silence clock. An
   * `error` is evidence the body is *not* flowing, so it must not restart it:
   * EventSource retries every few seconds, and a re-arming clock would keep
   * the watchdog from ever firing during an outage that fails on connect.
   */
  const attach = (candidate) => {
    const active = () => !closed && (source === candidate || probe === candidate);

    const frame = () => {
      if (!active()) return false;
      if (probe === candidate) promote(candidate);
      if (source !== candidate) return false;
      armWatchdog(silenceMs);
      return true;
    };

    // Fires on the first connection and on every automatic reconnect.
    candidate.addEventListener("open", () => {
      if (!active()) return;
      if (probe === candidate) {
        // The probe opened: its snapshot should follow immediately, so restart
        // the first-frame clock from the connection rather than its creation.
        armProbe(candidate);
        return;
      }
      notifyThread({ type: "open" });
      void refresh();
      void refreshBadge();
      armWatchdog(firstFrameMs);
    });

    // The server's first frame: the whole thread, so a missed delta cannot
    // leave half-old state on screen.
    candidate.addEventListener("snapshot", (event) => {
      if (!frame()) return;
      parsedThreadFrame(event, (snapshot) => notifyThread({ type: "snapshot", snapshot }));
    });

    // One commit's raw Pi Durable events. The Agent screen is the one place
    // that understands them; the shell itself only cares about `profile`.
    candidate.addEventListener("batch", (event) => {
      if (!frame()) return;
      parsedThreadFrame(event, (batch) => notifyThread({ type: "batch", ...batch }));
    });

    // A keepalive proves the body is not being buffered. Nothing renders it.
    candidate.addEventListener("heartbeat", () => {
      frame();
    });

    // The browser is retrying by itself; tell the Agent screen so it can show a
    // polite reconnecting state rather than an unexplained gap. A probe's error
    // is not reported: the probe is ours, and polling is still working. The
    // watchdog armed by the last real frame (or by `openStream`) keeps running,
    // so an outage that lasts past `silenceMs` still reaches polling.
    candidate.addEventListener("error", () => {
      if (!active()) return;
      if (probe === candidate) return;
      notifyThread({ type: "error" });
    });

    // A full view, not a delta: applying it is a replacement, so a missed frame
    // cannot leave half-old state on screen.
    candidate.addEventListener("profile", (event) => {
      if (!frame()) return;
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
    candidate.addEventListener("reconnect", () => {
      if (probe === candidate) {
        // The server is closing this probe (cap eviction, shutdown). That is
        // not a recovered body: drop the probe and let the next retry try
        // again, without promoting a connection that is already ended.
        probe = null;
        probeTimer = clearTimer(probeTimer);
        candidate.close();
        scheduleRetry();
        return;
      }
      if (!frame()) return;
      notifyThread({ type: "reconnect" });
      if (source === candidate) source = null;
      candidate.close();
      retry = clearTimer(retry);
      retry = setTimeout(openStream, RECONNECT_DELAY_MS);
    });
  };

  const openStream = () => {
    if (closed || polling) return;
    source = makeSource("/api/agent/events");
    attach(source);
    // A connection that never opens (a hung TCP connect, an intermediary that
    // never returns headers) emits no event at all, so the first-frame clock
    // starts at creation, not at `open`.
    armWatchdog(firstFrameMs);
  };

  openStream();

  return {
    close() {
      closed = true;
      stopWatchdog();
      stopPollLoop();
      retry = clearTimer(retry);
      probeTimer = clearTimer(probeTimer);
      if (probe !== null) probe.close();
      probe = null;
      if (source !== null) source.close();
      source = null;
      polling = false;
    },
  };
}
