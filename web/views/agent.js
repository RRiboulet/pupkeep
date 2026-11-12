// Agent — the shared household thread (PLAN §9, §9.3, §9.4, §13.1), replacing
// the placeholder that stood here until the browser UI for the completed
// backend landed.
//
// This screen is a client of a contract that is already complete on the server:
//
//   GET  /api/agent/thread        the snapshot (entries oldest first + status)
//   POST /api/agent/messages      submit one caregiver message (busy = 409)
//   GET  /api/agent/events        SSE: `snapshot`, then one `batch` per commit
//   GET  /api/agent/events/poll   the long-poll fallback (full snapshots only)
//   GET  /api/approvals           the proposals with their derived state
//   POST /api/approvals/{confirm,cancel}   a caregiver's tap (rev + key)
//   GET  /api/models, /api/budget the model and this month's spend
//
// What the screen is careful about:
//   * the server's snapshot is authoritative. A live `batch` carries raw Pi
//     Durable events, not the transcript projection, so the cheap and honest
//     reaction to an entry-bearing batch is one debounced snapshot read — the
//     client never re-implements `readThreadSnapshot` and cannot drift from it.
//     `seq` orders the answers: a snapshot older than the last applied commit
//     is dropped, because arrival order is not freshness order;
//   * one stream. The shell already owns the single `/api/agent/events`
//     EventSource (live.js); this view subscribes to it and opens a poll only
//     when the browser has no EventSource at all. Two connections from one tab
//     would spend two of the per-member slots for no gain;
//   * busy is global. One caregiver's submission disables the other's composer
//     and says who is being answered; v1 rejects input while a run owns the
//     thread, so a 409 keeps the draft and the key for a safe retry;
//   * a proposal is a request, not a change. The card carries the revision it
//     read; confirm/cancel send it with a fresh Idempotency-Key, and every 409
//     (stale, expired, declined, already confirmed, target changed) re-reads the
//     list and shows the server's sentence;
//   * text is rendered as text. Entries come from caregivers and the model, so
//     no `innerHTML`, no inline style, no inline handler anywhere (CSP
//     `default-src 'self'`). A model reply's bold, inline code and bullet lists
//     are the one exception to "one text node": `markdown.js` parses a tiny
//     subset into plain records and `markdown-view.js` maps them to vnodes, so
//     the caregiver reads `Breakfast` instead of `**Breakfast**` and the model's
//     characters still never become markup. A caregiver's own typing is shown
//     literally, as typed.
//
// The class, not a hook: the shell serves no import map and the vendored hooks
// module imports a bare `preact` specifier (PLAN §13.2).

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, newIdempotencyKey, requestJson } from "../client.js";
import { subscribeThread } from "../live.js";
import { pendingSave } from "../profile-form.js";
import { getState } from "../store.js";
import { dateText, localDate, localTimeText } from "../clock.js";
import { budgetPercent, budgetStateText, spendText } from "../models.js";
import { MarkdownText } from "../markdown-view.js";

const html = htm.bind(h);

const SIGNED_OUT = "Please sign in again.";
const THREAD_FAILED = "Could not load the shared thread. Try again in a moment.";
const APPROVALS_FAILED = "Could not load the proposals. Try again in a moment.";
const SEND_FAILED = "The message was not sent. Try again.";
const BUSY_SENTENCE =
  "The assistant is still finishing a reply. Your message was not sent — try again when it is free.";
const REFRESH_DEBOUNCE_MS = 120;
const POLL_INTERVAL_MS = 4000;
const EXPIRY_TICK_MS = 30_000;
const BUSY_CATCHUP_MS = 15_000;
/** A stalled mobile link must not leave the composer saying "Sending…" for minutes. */
const MUTATION_TIMEOUT_MS = 60_000;
const SEND_TIMEOUT =
  "Pupkeep did not answer in time. Your message is kept; sending it again reuses the same id, so it cannot post twice.";
const DECISION_TIMEOUT =
  "Pupkeep did not answer in time. The proposal list has been refreshed; check the card before trying again.";
const APPROVAL_HISTORY = 5;
const TEXT_LIMIT = 2000;

/** The server's 409 codes, as a sentence a caregiver reads. */
const APPROVAL_CODES = {
  stale: "The proposal changed since it was read. The card below is the committed one.",
  expired: "That proposal expired; nothing was executed.",
  declined: "That proposal was declined; nothing was executed.",
  already_confirmed: "That proposal was already confirmed; the change is done.",
  target_changed: "The appointment or schedule changed after this was proposed; nothing was executed.",
  idempotency_conflict: "That confirmation was already used for something else; nothing was executed.",
};

function entriesOf(thread) {
  return Array.isArray(thread?.entries) ? thread.entries : [];
}

function normalizeStatus(status) {
  const queued = Number(status?.queued);
  return {
    busy: status?.busy === true,
    queued: Number.isFinite(queued) && queued > 0 ? Math.trunc(queued) : 0,
  };
}

/**
 * `POST /api/agent/messages` answers the accepted submission's own status string
 * (`"queued" | "placed" | "done" | "unanswered"`), not the thread status the
 * snapshot carries. Anything not clearly terminal leaves the composer closed
 * until the authoritative snapshot says the thread is free.
 */
function acceptedBusy(status) {
  return typeof status === "string" ? status !== "done" && status !== "unanswered" : true;
}

/**
 * The proposal's state as of this render. The server derives `expired` at read
 * time, but a card left open past the TTL must stop offering buttons even
 * before the next read; the clock is only used to stop a tap the server would
 * refuse anyway.
 */
function approvalStateOf(approval) {
  if (!approval) return "pending";
  if (approval.state !== undefined && approval.state !== "pending") return approval.state;
  const expires = Date.parse(String(approval.expiresAt ?? ""));
  if (Number.isFinite(expires) && expires <= Date.now()) return "expired";
  return "pending";
}

function canDecide(approval) {
  return approvalStateOf(approval) === "pending";
}

function approvalStateLabel(state) {
  switch (state) {
    case "confirmed":
      return "Confirmed";
    case "cancelled":
      return "Declined";
    case "expired":
      return "Expired";
    default:
      return "Waiting";
  }
}

/** `HH:MM` today, or `20 Dec 2026 09:00` when it is another day. */
function stampText(at, timezone) {
  if (typeof at !== "string" || at === "") return "";
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime())) return "";

  if (typeof timezone === "string" && timezone !== "") {
    const time = localTimeText(instant, timezone);
    if (!/^\d{2}:\d{2}$/.test(time)) return "";
    const day = localDate(instant, timezone);
    const today = getState().profile?.today ?? localDate(new Date(), timezone);
    if (day === null || day === today) return time;
    return `${dateText(day)} ${time}`;
  }

  // The household profile has not been read yet: use the device's own clock
  // rather than claiming every entry has an unknown time.
  const time = instant.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = instant.toDateString() === new Date().toDateString();
  if (sameDay) return time;
  return `${instant.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} ${time}`;
}

function orderApprovals(approvals) {
  return [...approvals].sort((a, b) => {
    const byCreated = Date.parse(String(b?.createdAt ?? "")) - Date.parse(String(a?.createdAt ?? ""));
    if (Number.isFinite(byCreated) && byCreated !== 0) return byCreated;
    return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
  });
}

/**
 * Live tool arguments, keyed by call id. The snapshot projection carries the
 * result text but not the arguments, so the expanded card can only show them
 * for calls this tab watched; a reload or a remount keeps the result only. The
 * map is bounded so a long-lived tab cannot grow with the transcript.
 */
function withToolArgs(known, callId, args) {
  if (typeof callId !== "string" || callId === "") return known;
  const next = { ...known, [callId]: args };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete next[key];
  return next;
}

export class Agent extends Component {
  state = {
    /** The last applied snapshot (`{conversationId, seq, entries, model}`), or null. */
    thread: null,
    /** Busy is global; it is updated by the snapshot and by run events. */
    status: { busy: false, queued: 0 },
    loading: true,
    threadError: null,
    /** `{memberId, role, label, authorId}`; the only source of "my" bubbles. */
    session: null,
    models: null,
    modelsError: null,
    budget: null,
    budgetError: null,
    approvals: [],
    approvalsLoading: true,
    approvalsError: null,
    /** The composer's text, kept across a refused or ambiguous send. */
    draft: "",
    pending: null,
    sending: false,
    sendError: null,
    /** `"open"`, `"reconnecting"`, `"polling"`, or `"connecting"`. */
    connection: "connecting",
    /** The latest model failure/retry sentence from the run, or null. */
    modelError: null,
    /** Tool arguments seen live, by tool-call id (`tool_execution_start`). */
    toolArgs: {},
    /** The approval id whose decision is on the wire, or null. */
    actionBusy: null,
    actionNotice: null,
    actionError: null,
    /** Bumped by the expiry ticker so an old pending card stops offering taps. */
    tick: 0,
  };

  componentDidMount() {
    this.request = this.props?.request ?? requestJson;
    this.unmounted = false;
    // The newest server counter seen in a snapshot or in an entry-bearing batch.
    // It is what keeps an older HTTP answer from landing on top of a live commit
    // (a non-entry batch must not raise it; see `onBatch`).
    this.seqFloor = 0;
    // The highest batch counter seen, for a gap check: a dropped batch must
    // trigger one snapshot read rather than leaving the transcript short.
    this.lastBatchSeq = undefined;
    this.nearBottom = true;
    this.unsubscribeThread = subscribeThread((event) => this.onThreadEvent(event));
    if (typeof window !== "undefined") {
      window.addEventListener("scroll", this.onScroll, { passive: true });
    }

    void this.loadThread();
    void this.loadApprovals();
    void this.loadStatus();
    void this.loadSession();

    if (typeof EventSource !== "function") this.startPolling();

    this.expiryTimer = setInterval(() => {
      if (this.unmounted) return;
      if (this.state.approvals.some((approval) => approvalStateOf(approval) === "pending")) {
        this.setState({ tick: this.state.tick + 1 });
      }
    }, EXPIRY_TICK_MS);
    this.expiryTimer.unref?.();

    // A missed `run_end` (a flapping link, a server restart) must not leave the
    // composers disabled for the rest of the session. While a run is believed
    // to be in flight, a slow read of the authoritative snapshot is cheap and
    // corrects the state; when the thread is idle this makes no request.
    this.busyTimer = setInterval(() => {
      if (!this.unmounted && this.state.status.busy) void this.loadThread();
    }, BUSY_CATCHUP_MS);
    this.busyTimer.unref?.();
  }

  componentWillUnmount() {
    this.unmounted = true;
    this.unsubscribeThread?.();
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    if (this.expiryTimer !== undefined) clearInterval(this.expiryTimer);
    if (this.busyTimer !== undefined) clearInterval(this.busyTimer);
    if (this.sendWatchdog !== undefined) clearTimeout(this.sendWatchdog);
    if (this.decisionWatchdog !== undefined) clearTimeout(this.decisionWatchdog);
    if (typeof window !== "undefined") {
      window.removeEventListener("scroll", this.onScroll);
    }
  }

  componentDidUpdate(previousProps, previousState) {
    // A new entry lands at the bottom unless the caregiver has scrolled up to
    // read history; never yank the page away from what they are reading.
    const before = entriesOf(previousState.thread).length;
    const after = entriesOf(this.state.thread).length;
    if (after > before && this.nearBottom !== false) this.scrollToEnd();
  }

  onScroll = () => {
    if (typeof window === "undefined") return;
    const doc = globalThis.document?.documentElement;
    const height = doc?.scrollHeight ?? 0;
    this.nearBottom = window.innerHeight + window.scrollY >= height - 200;
  };

  scrollToEnd() {
    const scroll = () => this.endRef?.scrollIntoView?.({ block: "end" });
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(scroll);
    else scroll();
  }

  timezone() {
    return getState().profile?.household?.timezone ?? null;
  }

  // --- live frames ---------------------------------------------------------

  onThreadEvent(event) {
    if (this.unmounted) return;
    switch (event?.type) {
      case "snapshot":
        this.applySnapshot(event.snapshot);
        return;
      case "batch":
        this.onBatch(event);
        return;
      case "open":
        // A reconnect is a catch-up point: the stream does not replay commits
        // that landed while it was down, and approvals have no frame of their
        // own. The snapshot is authoritative, so one read of each is enough.
        // `seq` is a per-process counter and restarts at 0 with the server, so
        // the ordering baseline must not survive a reattach: a fresh counter
        // would otherwise look older than every snapshot and freeze the thread.
        this.seqFloor = 0;
        this.lastBatchSeq = undefined;
        this.setState({ connection: "open" });
        void this.loadThread();
        void this.loadApprovals();
        void this.loadStatus();
        return;
      case "reconnect":
      case "error":
        this.setState({ connection: "reconnecting" });
        return;
      default:
        return;
    }
  }

  /**
   * Apply a whole thread snapshot, never backwards. `seq` is the server's event
   * counter; an older answer loses even when it arrives later.
   */
  applySnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.entries)) return false;
    const seq = Number(snapshot.seq);
    if (Number.isFinite(seq) && seq < (this.seqFloor ?? 0)) return false;
    if (Number.isFinite(seq)) {
      this.seqFloor = seq;
      this.lastBatchSeq = Math.max(this.lastBatchSeq ?? 0, seq);
    }
    this.setState({
      thread: snapshot,
      status: normalizeStatus(snapshot.status),
      loading: false,
      threadError: null,
    });
    return true;
  }

  /**
   * One commit's Pi Durable events. Only three things are read here: whether a
   * run is in flight, whether the model reported a problem, and whether an
   * entry was appended (which is answered with one debounced snapshot). The
   * transcript projection stays server-side.
   */
  onBatch(batch) {
    const seq = Number(batch?.seq);
    // A gap means a commit was not delivered: the next snapshot catches up.
    const gap = Number.isFinite(seq) && this.lastBatchSeq !== undefined && seq > this.lastBatchSeq + 1;
    if (Number.isFinite(seq)) this.lastBatchSeq = Math.max(this.lastBatchSeq ?? 0, seq);

    let status = this.state.status;
    let modelError = this.state.modelError;
    let toolArgs = this.state.toolArgs;
    let statusChanged = false;
    let argsChanged = false;
    let refresh = gap;
    // Only an entry-bearing batch raises the floor. Raising it for, say, a
    // `usage_changed` frame could reject the very snapshot that contains the
    // entry a preceding batch announced — and nothing would ask again.
    let entryBearing = false;
    let approvals = false;
    let budget = false;
    let panel = false;

    for (const event of Array.isArray(batch?.events) ? batch.events : []) {
      switch (event?.type) {
        case "snapshot":
          // The Pi Durable stream replaces undelivered batches with a snapshot
          // under overflow; the transcript projection is still the server's, so
          // re-read it rather than trying to merge a raw one.
          refresh = true;
          entryBearing = true;
          break;
        case "run_start":
          // A new turn clears the previous turn's complaint; if this attempt
          // fails too, `auto_retry_start`/`task_failed` sets it again.
          modelError = null;
          if (!status.busy) {
            status = { ...status, busy: true };
            statusChanged = true;
          }
          break;
        case "message_start":
        case "auto_retry_end":
          if (!status.busy) {
            status = { ...status, busy: true };
            statusChanged = true;
          }
          break;
        case "run_end":
          status = { busy: false, queued: 0 };
          statusChanged = true;
          refresh = true;
          // The turn's usage has changed: the month's spend is a fresh read.
          budget = true;
          break;
        case "auto_retry_start":
          status = { ...status, busy: true };
          statusChanged = true;
          modelError = String(event.errorMessage ?? "The model call failed; the server is retrying.");
          break;
        case "task_failed":
          modelError = String(event.message ?? "The assistant run failed.");
          break;
        case "message_end":
        case "entry_appended": {
          refresh = true;
          entryBearing = true;
          if (event.entry?.kind === "app.approval") approvals = true;
          // A new turn entry means the previous model complaint is no longer the
          // current state of the thread.
          modelError = null;
          break;
        }
        case "tool_execution_start":
          toolArgs = withToolArgs(toolArgs, event.toolCallId, event.args);
          argsChanged = true;
          break;
        case "tool_execution_end":
          // A proposing tool writes `app.approvals` and no transcript entry for
          // the proposal itself, so the cards are the only surface that shows it.
          // A faulted/orphaned call has no result entry, so it needs no read of
          // the transcript — only the approval list.
          approvals = true;
          if (event.entry !== undefined) {
            refresh = true;
            entryBearing = true;
          }
          break;
        case "agent_changed":
          // Another screen (Settings) may have picked a different model.
          panel = true;
          break;
        case "inbox_update":
          status = { ...status, queued: Array.isArray(event.items) ? event.items.length : 0 };
          statusChanged = true;
          break;
        default:
          break;
      }
    }

    if (entryBearing && Number.isFinite(seq)) {
      this.seqFloor = Math.max(this.seqFloor ?? 0, seq);
    }

    const patch = {};
    if (statusChanged) patch.status = status;
    if (modelError !== this.state.modelError) patch.modelError = modelError;
    if (argsChanged) patch.toolArgs = toolArgs;
    if (Object.keys(patch).length > 0) this.setState(patch);

    // A disabled textarea loses focus when the caregiver sends. When the run
    // releases the thread, put the caret back where they were typing.
    if (status.busy === false && statusChanged && this.focusAfterBusy) {
      this.focusAfterBusy = false;
      setTimeout(() => {
        if (!this.unmounted) this.composer?.focus?.();
      }, 0);
    }

    if (refresh) this.scheduleRefresh();
    if (approvals) void this.loadApprovals();
    if (budget || panel) void this.loadStatus();
  }

  scheduleRefresh() {
    if (this.unmounted) return;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.loadThread();
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * The no-EventSource fallback. The long-poll route always answers a full
   * snapshot, so the same `applySnapshot` order guard applies; approvals have
   * no long-poll frame, so they are read on the same cadence.
   */
  startPolling() {
    this.setState({ connection: "polling" });
    const tick = async () => {
      if (this.unmounted) return;
      const applied = await this.loadThread(
        `/api/agent/events/poll?since=${Math.max(0, this.seqFloor ?? 0)}&ms=${POLL_INTERVAL_MS}`,
      );
      if (this.unmounted) return;
      void this.loadApprovals();
      // The model/usage read is the expensive one; polling needs it for the
      // composer's budget state, not on every thread tick.
      this.pollTicks = (this.pollTicks ?? 0) + 1;
      if (this.pollTicks % 5 === 1) void this.loadStatus();
      // The long poll itself already waited ~POLL_INTERVAL_MS; a wake caused by
      // a commit should be followed immediately, while a failed read waits.
      this.pollTimer = setTimeout(tick, applied ? 250 : POLL_INTERVAL_MS);
    };
    this.pollTimer = setTimeout(tick, 0);
  }

  // --- reads ---------------------------------------------------------------

  async loadThread(path = "/api/agent/thread") {
    const seq = (this.loadSeq = (this.loadSeq ?? 0) + 1);
    let result;
    try {
      result = await this.request(path);
    } catch (error) {
      if (seq !== this.loadSeq || this.unmounted) return false;
      this.setState({
        loading: false,
        threadError: error instanceof NetworkError ? error.message : THREAD_FAILED,
      });
      return false;
    }
    if (seq !== this.loadSeq || this.unmounted) return false;
    if (result.status === 401) {
      this.setState({ loading: false, threadError: SIGNED_OUT });
      return false;
    }
    if (!result.ok || !result.body) {
      this.setState({ loading: false, threadError: THREAD_FAILED });
      return false;
    }
    return this.applySnapshot(result.body);
  }

  async loadApprovals() {
    const seq = (this.approvalSeq = (this.approvalSeq ?? 0) + 1);
    let result;
    try {
      result = await this.request("/api/approvals");
    } catch (error) {
      if (seq !== this.approvalSeq || this.unmounted) return;
      this.setState({
        approvalsLoading: false,
        approvalsError: error instanceof NetworkError ? error.message : APPROVALS_FAILED,
      });
      return;
    }
    if (seq !== this.approvalSeq || this.unmounted) return;
    if (result.status === 401) {
      this.setState({ approvalsLoading: false, approvalsError: SIGNED_OUT });
      return;
    }
    if (!result.ok || !result.body) {
      this.setState({ approvalsLoading: false, approvalsError: APPROVALS_FAILED });
      return;
    }
    this.setState({
      approvals: Array.isArray(result.body.approvals) ? result.body.approvals : [],
      approvalsLoading: false,
      approvalsError: null,
    });
  }

  /**
   * The model and the month's spend. `/api/models` already carries a budget
   * view; `/api/budget` is read beside it because it is the authoritative,
   * cheap read (`/api/models` additionally runs the allowlist/catalog work).
   */
  async loadStatus() {
    const seq = (this.statusSeq = (this.statusSeq ?? 0) + 1);
    let models = null;
    let modelsError = null;
    let budget = null;
    let budgetError = null;

    const [modelsAnswer, budgetAnswer] = await Promise.allSettled([
      this.request("/api/models"),
      this.request("/api/budget"),
    ]);

    if (modelsAnswer.status === "fulfilled") {
      const result = modelsAnswer.value;
      if (result.status === 401) modelsError = SIGNED_OUT;
      else if (!result.ok || !result.body) modelsError = "Could not read the model settings.";
      else models = result.body;
    } else {
      modelsError =
        modelsAnswer.reason instanceof NetworkError
          ? modelsAnswer.reason.message
          : "Could not read the model settings.";
    }

    if (budgetAnswer.status === "fulfilled") {
      const result = budgetAnswer.value;
      if (result.status === 401) budgetError = SIGNED_OUT;
      else if (!result.ok || !result.body?.budget) budgetError = "Could not read the monthly spend.";
      else budget = result.body.budget;
    } else {
      budgetError =
        budgetAnswer.reason instanceof NetworkError
          ? budgetAnswer.reason.message
          : "Could not read the monthly spend.";
    }

    if (seq !== this.statusSeq || this.unmounted) return;
    this.setState((state) => ({
      models: models ?? state.models,
      modelsError,
      budget: budget ?? state.budget ?? state.models?.budget ?? null,
      budgetError,
    }));
  }

  async loadSession() {
    let result;
    try {
      result = await this.request("/api/session");
    } catch {
      return; // The bubbles fall back to the neutral side; the thread still works.
    }
    if (this.unmounted || !result.ok || !result.body) return;
    this.setState({ session: result.body });
  }

  // --- composer ------------------------------------------------------------

  setDraft(value) {
    this.setState({ draft: value, sendError: null });
  }

  onKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void this.send();
  }

  /**
   * One intended message, one `clientMessageId`. The key is held with the body
   * it belongs to, so retrying after a lost response replays instead of
   * posting twice; editing the draft makes it a different message and a fresh
   * key (the rule P1-11 gave every form).
   */
  async send() {
    const text = String(this.state.draft ?? "").trim();
    if (text === "" || this.state.sending) return;
    if (this.state.status.busy) {
      this.setState({ sendError: BUSY_SENTENCE });
      return;
    }

    const pending = pendingSave(this.state.pending, { text });
    this.setState({ sending: true, pending, sendError: null });

    // A stalled connection would otherwise leave the composer at "Sending…"
    // until the browser's own TCP timeout. The key stays held, so a later tap
    // is still the same intended message.
    const token = (this.sendToken = (this.sendToken ?? 0) + 1);
    const alive = () => !this.unmounted && this.sendToken === token;
    // Clear the id this attempt created, never whichever id is current now: a
    // timed-out attempt may resolve after the caregiver started a new one.
    const watchdog = (this.sendWatchdog = setTimeout(() => {
      if (!alive()) return;
      this.sendToken += 1;
      this.setState({ sending: false, sendError: SEND_TIMEOUT });
    }, MUTATION_TIMEOUT_MS));

    let result;
    try {
      result = await this.request("/api/agent/messages", {
        method: "POST",
        body: { text, clientMessageId: pending.key },
        idempotencyKey: pending.key,
      });
    } catch (error) {
      if (!alive()) return;
      // Ambiguous: the key is kept so the retry cannot duplicate a commit that
      // may have landed.
      this.setState({
        sending: false,
        sendError: error instanceof NetworkError ? error.message : SEND_FAILED,
      });
      return;
    } finally {
      clearTimeout(watchdog);
      if (this.sendWatchdog === watchdog) this.sendWatchdog = undefined;
    }
    if (!alive()) return;

    if (result.status === 401) {
      this.setState({ sending: false, sendError: SIGNED_OUT });
      return;
    }
    if (result.status === 409) {
      const answer = result.body ?? {};
      const message =
        answer.error === "busy"
          ? BUSY_SENTENCE
          : String(answer.message ?? answer.error ?? SEND_FAILED);
      this.setState({ sending: false, sendError: message });
      // A budget refusal moves the status panel; the text stays in the composer.
      if (answer.error === "budget_exhausted") void this.loadStatus();
      return;
    }
    if (!result.ok || !result.body) {
      const answer = result.body ?? {};
      this.setState({
        sending: false,
        sendError: String(answer.message ?? answer.error ?? SEND_FAILED),
      });
      return;
    }

    // Accepted: the `app.chat` entry is already committed, so the draft can go
    // and the entry arrives from the snapshot/stream rather than an optimistic
    // copy that might disagree with the server.
    const status = {
      busy: acceptedBusy(result.body.status),
      queued: this.state.status.queued,
    };
    this.focusAfterBusy = status.busy;
    this.setState({ sending: false, draft: "", pending: null, sendError: null, status }, () => {
      this.composer?.focus?.();
    });
    void this.loadThread();
  }

  // --- approvals -----------------------------------------------------------

  mergeApproval(approval) {
    if (!approval || typeof approval.id !== "string") return;
    const exists = this.state.approvals.some((entry) => entry.id === approval.id);
    const next = exists
      ? this.state.approvals.map((entry) => (entry.id === approval.id ? approval : entry))
      : [approval, ...this.state.approvals];
    this.setState({ approvals: orderApprovals(next) });
  }

  async decide(approval, decision) {
    if (!approval || this.state.actionBusy !== null) return;
    if (!canDecide(approval)) {
      this.setState({ actionError: "That proposal can no longer be decided; the list has been refreshed." });
      void this.loadApprovals();
      return;
    }

    this.setState({ actionBusy: approval.id, actionError: null, actionNotice: null });
    const path = decision === "confirm" ? "/api/approvals/confirm" : "/api/approvals/cancel";

    const token = (this.decisionToken = (this.decisionToken ?? 0) + 1);
    const alive = () => !this.unmounted && this.decisionToken === token;
    const watchdog = (this.decisionWatchdog = setTimeout(() => {
      if (!alive()) return;
      this.decisionToken += 1;
      this.setState({ actionBusy: null, actionError: DECISION_TIMEOUT });
      void this.loadApprovals();
    }, MUTATION_TIMEOUT_MS));

    let result;
    try {
      result = await this.request(path, {
        method: "POST",
        body: { id: approval.id, rev: approval.rev },
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      if (!alive()) return;
      this.setState({
        actionBusy: null,
        actionError:
          error instanceof NetworkError ? error.message : "The decision was not saved. Try again.",
      });
      return;
    } finally {
      clearTimeout(watchdog);
      if (this.decisionWatchdog === watchdog) this.decisionWatchdog = undefined;
    }
    if (!alive()) return;

    if (result.status === 401) {
      this.setState({ actionBusy: null, actionError: SIGNED_OUT });
      return;
    }
    if (result.status === 409) {
      const answer = result.body ?? {};
      if (answer.approval) this.mergeApproval(answer.approval);
      this.setState({
        actionBusy: null,
        actionError: String(answer.message ?? APPROVAL_CODES[answer.error] ?? "The proposal could not be decided."),
      });
      void this.loadApprovals();
      void this.loadThread();
      return;
    }
    if (!result.ok || !result.body) {
      const answer = result.body ?? {};
      this.setState({
        actionBusy: null,
        actionError: String(answer.message ?? answer.error ?? "The proposal could not be decided. Try again."),
      });
      void this.loadApprovals();
      return;
    }

    if (result.body.approval) this.mergeApproval(result.body.approval);
    const replayed = result.body.replayed === true;
    this.setState({
      actionBusy: null,
      actionNotice:
        decision === "confirm"
          ? replayed
            ? "Already confirmed; the change is done."
            : "Confirmed — the change is done."
          : replayed
            ? "Already declined; nothing was changed."
            : "Declined — nothing was changed.",
    });
    void this.loadApprovals();
    // The deciding commit appends `app.approval` to the transcript.
    void this.loadThread();
  }

  // --- rendering -----------------------------------------------------------

  isMine(entry) {
    const session = this.state.session;
    if (!session?.authorId || entry?.authorId === null || entry?.authorId === undefined) return false;
    return entry.authorId === session.authorId;
  }

  /** The newest chat/assistant/decision line, for the polite live region. */
  liveAnnouncement() {
    const entries = entriesOf(this.state.thread);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.kind === "chat") return `${entry.authorName}: ${entry.text}`;
      if (entry?.kind === "assistant") return `Assistant: ${entry.text}`;
      if (entry?.kind === "approval") return entry.text;
    }
    return "";
  }

  /** A new proposal is announced once, without turning every tool card into speech. */
  pendingAnnouncement() {
    const pending = (this.state.approvals ?? []).find(
      (approval) => approvalStateOf(approval) === "pending",
    );
    return pending ? `A proposal is waiting for your confirmation: ${pending.summary}` : "";
  }

  busySentence() {
    const entries = entriesOf(this.state.thread);
    let lastChat = null;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.kind === "chat") {
        lastChat = entries[index];
        break;
      }
    }
    const who = lastChat?.authorName ? `replying to ${lastChat.authorName}` : "working";
    const queued = this.state.status.queued > 0 ? ` ${this.state.status.queued} message(s) waiting.` : "";
    return `The assistant is ${who}…${queued}`;
  }

  renderStatus() {
    const models = this.state.models;
    const budget = this.state.budget ?? models?.budget ?? null;
    const current = models?.current ?? null;
    const modelId = current?.id ?? this.state.thread?.model ?? null;
    const free = current === null || current === undefined ? null : current.paid !== true;
    const modelHint = !modelId
      ? html`No model is attached yet — <a href="#settings">add a provider key in Settings</a>.`
      : html`Using <span class="agent__model-id">${modelId}</span>
          ${free === null ? null : html`<span class="agent__tag">${free ? "Free" : "Paid"}</span>`}`;

    return html`
      <section class="card agent__status" aria-label="Model and budget">
        <p class="agent__model">${modelHint}</p>
        ${this.state.modelsError
          ? html`<p class="field__hint">${this.state.modelsError}</p>`
          : null}
        ${this.state.modelsError || this.state.budgetError
          ? html`<p class="field__hint">
              <button type="button" class="link-button" onClick=${() => void this.loadStatus()}>Try again</button>
            </p>`
          : null}
        ${budget
          ? html`
              <p class="field__hint">${spendText(budget)}</p>
              <progress
                class="budget-bar"
                max="100"
                value=${budgetPercent(budget)}
                aria-label=${spendText(budget)}
              ></progress>
              <p class=${budget.state === "blocked" ? "notice notice--warn" : "field__hint"}>
                ${budgetStateText(budget.state)}
              </p>
            `
          : this.state.budgetError
            ? html`<p class="field__hint">${this.state.budgetError}</p>`
            : html`<p class="field__hint">Reading this month's spend…</p>`}
        ${this.state.modelError
          ? html`
              <p class="notice notice--error" role="alert">
                The model reported: ${this.state.modelError}
                <a href="#settings">Check the model in Settings</a>.
              </p>
            `
          : null}
      </section>
    `;
  }

  renderApprovalCard(approval) {
    const state = approvalStateOf(approval);
    const timezone = this.timezone();
    const decided =
      approval.decidedAt && approval.decidedByLabel
        ? `${approvalStateLabel(state)} ${stampText(approval.decidedAt, timezone)} by ${approval.decidedByLabel}`
        : state === "expired"
          ? `Expired ${stampText(approval.expiresAt, timezone)}`
          : state === "pending"
            ? `Expires ${stampText(approval.expiresAt, timezone)}`
            : approvalStateLabel(state);
    const busy = this.state.actionBusy === approval.id;

    return html`
      <li key=${approval.id} class=${`approval-card approval-card--${state}`}>
        <div class="approval-card__head">
          <p class="approval-card__summary">${approval.summary}</p>
          <span class="approval-card__state">${approvalStateLabel(state)}</span>
        </div>
        <p class="field__hint">
          Asked by ${approval.requestedByLabel} ${stampText(approval.createdAt, timezone)} · ${decided}
        </p>
        ${state === "pending"
          ? html`
              <div class="form__actions">
                <button
                  type="button"
                  class="button"
                  disabled=${this.state.actionBusy !== null}
                  onClick=${() => void this.decide(approval, "confirm")}
                >
                  ${busy ? "Working…" : "Confirm"}
                </button>
                <button
                  type="button"
                  class="button button--ghost"
                  disabled=${this.state.actionBusy !== null}
                  onClick=${() => void this.decide(approval, "cancel")}
                >
                  Decline
                </button>
              </div>
            `
          : null}
      </li>
    `;
  }

  renderApprovals() {
    const approvals = this.state.approvals ?? [];
    const pending = approvals.filter((approval) => approvalStateOf(approval) === "pending");
    const recent = approvals
      .filter((approval) => approvalStateOf(approval) !== "pending")
      .slice(0, APPROVAL_HISTORY);
    const show = pending.length > 0 || recent.length > 0 || this.state.approvalsError !== null;
    if (!show) return null;

    return html`
      <section class="card approvals" aria-labelledby="agent-approvals">
        <h2 id="agent-approvals" class="card__title">Waiting for your confirmation</h2>
        ${this.state.approvalsError
          ? html`<p class="notice notice--error" role="alert">
              ${this.state.approvalsError}
              ${this.state.approvalsError === SIGNED_OUT
                ? null
                : html`<button type="button" class="link-button" onClick=${() => void this.loadApprovals()}>Try again</button>`}
            </p>`
          : null}
        ${this.state.actionError
          ? html`<p class="notice notice--error" role="alert">${this.state.actionError}</p>`
          : null}
        ${this.state.actionNotice
          ? html`<p class="notice" role="status">${this.state.actionNotice}</p>`
          : null}
        ${pending.length === 0
          ? html`<p class="field__hint">Nothing is waiting for a tap.</p>`
          : html`<ul class="approval-list">${pending.map((approval) => this.renderApprovalCard(approval))}</ul>`}
        ${recent.length > 0
          ? html`
              <details class="approvals__recent">
                <summary>Recent proposals</summary>
                <ul class="approval-list">${recent.map((approval) => this.renderApprovalCard(approval))}</ul>
              </details>
            `
          : null}
      </section>
    `;
  }

  renderEntry(entry) {
    const timezone = this.timezone();
    const when = stampText(entry?.at, timezone);
    const meta = when === "" ? null : html`<span class="thread__time">${when}</span>`;

    if (entry?.kind === "chat") {
      const mine = this.isMine(entry);
      return html`
        <li
          key=${`chat-${entry.entryId}`}
          class=${`thread__entry${mine ? " thread__entry--mine" : " thread__entry--theirs"}`}
        >
          <p class="thread__meta">${entry.authorName}${meta ? html` · ${meta}` : null}</p>
          <p class="thread__bubble">${entry.text}</p>
        </li>
      `;
    }

    if (entry?.kind === "assistant") {
      // The reply's bubble owns real blocks now, and it is written on one line
      // with no whitespace around the child: the bubble is `pre-wrap`, so a
      // text node left by the template's indentation would print as a blank
      // line before the first paragraph.
      return html`
        <li key=${`assistant-${entry.entryId}`} class="thread__entry thread__entry--agent">
          <p class="thread__meta">Assistant${meta ? html` · ${meta}` : null}</p>
          <div class="thread__bubble thread__bubble--agent"><${MarkdownText} text=${entry.text} /></div>
        </li>
      `;
    }

    if (entry?.kind === "tool") {
      const failed = entry.status === "error";
      const args = this.state.toolArgs?.[entry.toolCallId];
      // The arguments are only known for calls this tab watched live (the
      // snapshot projection omits them); the result is always in the snapshot.
      const argsText = args === undefined ? "" : JSON.stringify(args, null, 2).slice(0, 4_000);
      return html`
        <li key=${`tool-${entry.entryId}`} class="thread__entry thread__entry--tool">
          <details class="tool-card">
            <summary>
              ${entry.toolName || "Tool"} · ${failed ? "failed" : "done"}${meta ? html` · ${meta}` : null}
            </summary>
            <p class="field__hint">By ${entry.byLabel}</p>
            ${argsText
              ? html`<pre class="tool-card__args">${argsText}</pre>`
              : null}
            ${entry.text
              ? html`<pre class="tool-card__result">${entry.text}</pre>`
              : html`<p class="field__hint">The tool returned no text.</p>`}
          </details>
        </li>
      `;
    }

    if (entry?.kind === "approval") {
      const confirmed = entry.status === "confirmed";
      return html`
        <li key=${`approval-${entry.entryId}`} class="thread__entry thread__entry--approval">
          <div class=${`approval-note approval-note--${confirmed ? "confirmed" : "cancelled"}`}>
            <p class="approval-note__text">${entry.text}</p>
            <p class="field__hint">
              ${confirmed ? "Confirmed" : "Declined"} by ${entry.byLabel}${when ? ` · ${when}` : ""}
            </p>
          </div>
        </li>
      `;
    }

    return null;
  }

  renderComposer() {
    const busy = this.state.status.busy;
    const sending = this.state.sending;
    const disabled = busy || sending || this.state.threadError === SIGNED_OUT;

    return html`
      <form
        class="agent__composer"
        onSubmit=${(event) => {
          event.preventDefault();
          void this.send();
        }}
      >
        <label class="visually-hidden" for="agent-compose">Message to the household assistant</label>
        <textarea
          id="agent-compose"
          class="agent__input"
          rows="3"
          maxlength=${TEXT_LIMIT}
          placeholder=${busy ? "The assistant is busy…" : "Tell the household assistant what happened…"}
          value=${this.state.draft}
          disabled=${disabled}
          onInput=${(event) => this.setDraft(event.target.value)}
          onKeyDown=${(event) => this.onKeyDown(event)}
          ref=${(element) => (this.composer = element)}
        ></textarea>
        <div class="agent__composer-row">
          <p class="field__hint">Enter sends · Shift+Enter adds a line.</p>
          <button type="submit" class="button" disabled=${disabled || this.state.draft.trim() === ""}>
            ${sending ? "Sending…" : "Send"}
          </button>
        </div>
        ${this.state.sendError
          ? html`<p class="notice notice--error" role="alert">${this.state.sendError}</p>`
          : null}
      </form>
    `;
  }

  render() {
    const connection = this.state.connection;
    const entries = entriesOf(this.state.thread);
    const loading = this.state.loading && this.state.thread === null;

    return html`
      <section class="view agent" aria-labelledby="agent-heading">
        <h1 id="agent-heading">Agent</h1>
        <p class="field__hint">
          One shared thread for both caregivers. Ask the household assistant to log care or change the plan.
        </p>
        ${this.renderStatus()}
        ${connection === "reconnecting"
          ? html`<p class="notice notice--warn" role="status">
              Reconnecting to the shared thread… Your draft is kept and no message is lost.
            </p>`
          : null}
        ${connection === "polling"
          ? html`<p class="field__hint">Live updates are polling; the thread catches up every few seconds.</p>`
          : null}
        ${this.state.threadError
          ? html`<p class="notice notice--error" role="alert">
              ${this.state.threadError}
              ${this.state.threadError === SIGNED_OUT
                ? null
                : html`<button type="button" class="link-button" onClick=${() => void this.loadThread()}>Try again</button>`}
            </p>`
          : null}
        ${this.state.status.busy
          ? html`<p class="agent__busy" role="status" aria-live="polite">${this.busySentence()}</p>`
          : null}
        <!-- New messages are announced singly; the transcript list itself is
             not a live region, or every tool card would be read out. -->
        <p class="visually-hidden" aria-live="polite" aria-atomic="true">${this.liveAnnouncement()}</p>
        <p class="visually-hidden" aria-live="polite" aria-atomic="true">${this.pendingAnnouncement()}</p>
        ${this.renderApprovals()}
        ${loading
          ? html`<p class="placeholder">Loading the shared thread…</p>`
          : entries.length === 0
            ? html`<p class="placeholder">
                No messages yet. Tell the assistant what happened, or ask it what today looks like.
              </p>`
            : html`
                <ol class="thread" aria-busy=${this.state.status.busy}>
                  ${entries.map((entry) => this.renderEntry(entry))}
                </ol>
              `}
        <div class="thread__end" ref=${(element) => (this.endRef = element)}></div>
        ${this.state.threadError === SIGNED_OUT ? null : this.renderComposer()}
      </section>
    `;
  }
}
