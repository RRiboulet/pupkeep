// Today — the care surface the two caregivers live on (PLAN §13.1).
//
// This build owns the meals card (fed/pending/overdue, mark-fed, extra feeding)
// and the walk card (start, a live server-corrected timer, end, and a stale
// discard). The agent bar, weight and recent activity arrive with their phases;
// the first-run setup gate already lives here (P1-14).
//
// Three rules shape the screen:
//   * **never optimistic.** Nothing is marked fed until the server's commit
//     returns; a 409 `already_fed` shows the other caregiver's feed and re-reads
//     the day instead of pretending the tap worked (P2-03's shape carries who
//     and when for exactly this);
//   * **one idempotency key per intended action**, held with the body it belongs
//     to (`pendingSave`, P1-11's rule): a double-tap or a lost response replays
//     instead of logging a second meal or reporting a false conflict;
//   * **the day comes from the server**, including the household-local date and
//     the reminder delay, and `live.js`'s `profile` frame — published when
//     `app.feeding` commits — makes the other caregiver's meal appear without a
//     reload. A local tick re-evaluates "overdue" without a request.
//
// The class, not a hook: the shell serves no import map and the vendored hooks
// module imports a bare `preact` specifier (PLAN §13.2).

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, requestJson } from "../client.js";
import { pendingSave } from "../profile-form.js";
import { getState, subscribe } from "../store.js";
import { feedTimeText, localDate, mealClock, mealRows } from "../meals.js";
import { correctedNow, timerText, walkMinutes, walkSeconds, walkStale, walkTimeText } from "../walks.js";
import { Setup } from "./setup.js";

const html = htm.bind(h);

/**
 * How often the card re-renders. One second keeps an open walk's timer live
 * (§13.1); the meals card only needs "overdue" to age, which the same tick does
 * for free — the tick makes no request.
 */
export const TICK_MS = 1_000;

const SIGNED_OUT = "Please sign in again.";
const LOAD_FAILED = "Could not load today's meals. Try again in a moment.";

export class Today extends Component {
  state = {
    /** The committed day view, or null before the first read. */
    day: null,
    loading: true,
    error: null,
    message: null,
    /** `"slot-b"` or `"extra"` while a write is on the wire. */
    busy: null,
    extraOpen: false,
    extraAmount: "",
    extraNote: "",
    /** Idempotency keys, held with the body each belongs to (P1-11's rule). */
    pending: null,
    /** Bumped by the local ticker so overdue state ages without a request. */
    tick: 0,
    /** The care-view sequence last acted on, so one frame triggers one re-read. */
    seenCare: -1,
    /** `{open, serverNow, staleAfterMs, receivedAt}` for the walk card, or null. */
    walk: null,
    walkLoading: true,
    walkError: null,
    walkMessage: null,
    walkBusy: null,
    walkFormOpen: false,
    walkDiscardOpen: false,
    walkDraft: { pee: "", poop: "", dogsMet: "", mood: "", notes: "" },
    walkPending: null,
  };

  componentDidMount() {
    this.request = this.props?.request ?? requestJson;
    this.unsubscribe = subscribe((state) => this.onStore(state));
    // The day route needs no profile: read it on mount instead of waiting for
    // the first care frame (which may never come if `/api/puppy` keeps failing).
    if (!this.gated()) void this.load();
    if (!this.gated()) void this.loadWalks();
    this.timer = setInterval(() => this.onTick(), TICK_MS);
    this.timer.unref?.();
  }

  componentWillUnmount() {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A new care view means the committed meals may have moved: `app.feeding` is
   * one of the documents behind the `profile` frame, and a feed does not bump a
   * revision, so identity — not `isNewer` — is what says "re-read".
   */
  onStore(state) {
    const seq = state?.careSeq ?? 0;
    if (seq === this.state.seenCare) return;
    this.setState({ seenCare: seq });
    if (!this.gated()) {
      void this.load();
      void this.loadWalks();
    }
  }

  /** P1-14: an unfinished household sees the wizard, not a meals card. */
  gated() {
    return getState().profile?.setup?.complete === false;
  }

  /** The household zone, or `null` before the profile is read: times then say unknown rather than UTC. */
  timezone() {
    return getState().profile?.household?.timezone ?? null;
  }

  /**
   * The local tick: re-render so "overdue" ages, and re-read the day the moment
   * the household's date has moved on. Without the second half, a phone left on
   * Today overnight would keep showing yesterday's slots under "Today".
   */
  onTick() {
    this.ticks = (this.ticks ?? 0) + 1;
    // A live walk timer needs the second; the meals card only ages "overdue",
    // so with no walk open the screen re-renders once every 30 ticks. No tick
    // makes a request.
    const open = this.state.walk?.open ?? null;
    if (!open && this.ticks % 30 !== 0) return;
    this.setState({ tick: this.state.tick + 1 });
    if (this.gated()) return;
    const day = this.state.day;
    if (!day) return;
    const today = localDate(new Date(), this.timezone());
    if (today !== null && today !== day.localDate) void this.load();
  }

  /**
   * A write's answer carries the plain committed day; the reminder delay is
   * view metadata the GET supplied, and a settings change reaches this card
   * through the same `profile` frame, so the cached value is current.
   */
  mergeDay(day) {
    const valid = (value) => Number.isFinite(value) && value >= 0;
    const delay = valid(day.overdueAfterMin) ? day.overdueAfterMin : this.state.day?.overdueAfterMin;
    return valid(delay) ? { ...day, overdueAfterMin: delay } : day;
  }

  /** The open walk plus the server clock the timer is corrected against. */
  async loadWalks() {
    // Arrival order is not freshness order: a read that started before a
    // committed write must not restore a closed walk.
    const seq = (this.walkSeq = (this.walkSeq ?? 0) + 1);
    try {
      const result = await this.request("/api/walks");
      if (seq !== this.walkSeq) return;
      if (result.status === 401) {
        this.setState({ walkLoading: false, walkError: SIGNED_OUT });
        return;
      }
      if (!result.ok || !result.body) {
        this.setState({ walkLoading: false, walkError: "Could not load the walk. Try again in a moment." });
        return;
      }
      this.setState({ walk: { ...result.body, receivedAt: Date.now() }, walkLoading: false, walkError: null });
    } catch (error) {
      if (seq !== this.walkSeq) return;
      this.setState({
        walkLoading: false,
        walkError: error instanceof NetworkError ? error.message : "Could not load the walk.",
      });
    }
  }

  async load() {
    // Arrival order is not freshness order (P1-11's rule): a read that started
    // before a committed write must not overwrite that write's day. `loadSeq` is
    // bumped by every read and by every commit.
    const seq = (this.loadSeq = (this.loadSeq ?? 0) + 1);
    try {
      const result = await this.request("/api/feeding/day");
      if (seq !== this.loadSeq) return;
      if (result.status === 401) {
        this.setState({ loading: false, error: SIGNED_OUT });
        return;
      }
      if (!result.ok || !result.body) {
        this.setState({ loading: false, error: LOAD_FAILED });
        return;
      }
      this.setState({ day: result.body, loading: false, error: null });
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.setState({
        loading: false,
        error: error instanceof NetworkError ? error.message : LOAD_FAILED,
      });
    }
  }

  /**
   * One write, one key. The body is the whole action — the slot and the optional
   * amount/note — so a retry of the same form reuses the key and a changed form
   * is a new action. The answer is the server's committed day, never a guess.
   */
  async write(path, body, busy) {
    // An instance flag, not rendered state: `this.state` is not replaced until
    // Preact's next render, so two taps in one task would both pass a state
    // check. `busy` below is only for what the caregiver sees.
    if (this.mealWriting) return;
    this.mealWriting = true;
    const pending = pendingSave(this.state.pending, body);
    this.setState({ busy, pending, message: null, error: null });
    let result;
    try {
      result = await this.request(path, { method: "POST", body, idempotencyKey: pending.key });
    } catch (error) {
      // An ambiguous failure: keep the key, so retrying the same body replays
      // instead of logging the meal twice. Only a definite refusal drops it.
      this.mealWriting = false;
      this.setState({
        busy: null,
        error: error instanceof NetworkError ? error.message : "Could not log that meal. Try again.",
      });
      return;
    }

    this.mealWriting = false;
    if (result.ok && result.body?.day) {
      // A committed day invalidates any read that started before it.
      this.loadSeq = (this.loadSeq ?? 0) + 1;
      this.focusNotice();
      this.setState({
        busy: null,
        day: this.mergeDay(result.body.day),
        message: result.body.replayed ? "Already logged." : "Logged.",
        extraOpen: false,
        extraAmount: "",
        extraNote: "",
        // The next action is a different one, so it gets a fresh key.
        pending: null,
      });
      return;
    }

    if (result.status === 409 && result.body?.error === "already_fed") {
      const feed = result.body.feed;
      const who = feed?.byLabel ? `${feed.byLabel}` : "The other caregiver";
      const when = feed?.at ? feedTimeText(feed.at, this.timezone()) : "earlier";
      // The 409 already carries the committed day (§7.3's shape), so show it
      // instead of a second read that could fail and leave the card stale.
      const day = result.body?.day;
      this.focusNotice();
      this.setState({
        busy: null,
        pending: null,
        message: null,
        error: `${who} already logged this meal at ${when}.`,
        ...(day ? { day: this.mergeDay(day) } : {}),
      });
      return;
    }

    if (result.status === 409 && result.body?.error === "idempotency_conflict") {
      this.setState({
        busy: null,
        error: "That save conflicted with an earlier action. Nothing was written; try again.",
        pending: null,
      });
      return;
    }

    // A 5xx or an unreadable answer may still have committed: keep the key so a
    // retry of the same body replays. A definite refusal (400/403) keeps it too;
    // the same body can only be refused again, which is harmless.
    this.setState({
      busy: null,
      error: result.body?.error ?? "Could not log that meal. Try again.",
    });
  }

  /**
   * A commit removes or disables the button the caregiver just used; move focus
   * to the message so a keyboard user is not dropped back at the document top.
   */
  focusNotice() {
    setTimeout(() => this.noticeEl?.focus?.(), 0);
  }

  /** The server-corrected instant the walk card renders and times against. */
  walkNow() {
    const walk = this.state.walk;
    if (!walk) return Date.now();
    return correctedNow(walk.serverNow, walk.receivedAt);
  }

  /**
   * One walk write, one key. The answer is the committed record; nothing is
   * painted before it. A 409 that carries the open walk (`walk_open`/
   * `walk_stale`) shows it, so a start that lost a race is not a dead end.
   */
  async writeWalk(path, body, busy) {
    if (this.walkWriting) return;
    this.walkWriting = true;
    const pending = pendingSave(this.state.walkPending, { path, ...body });
    this.setState({ walkBusy: busy, walkPending: pending, walkMessage: null, walkError: null });
    let result;
    try {
      result = await this.request(path, { method: "POST", body, idempotencyKey: pending.key });
    } catch (error) {
      this.walkWriting = false;
      this.setState({
        walkBusy: null,
        walkError: error instanceof NetworkError ? error.message : "Could not update the walk. Try again.",
      });
      return;
    }
    this.walkWriting = false;

    if (result.ok) {
      // Paint the committed record immediately (the response carries it), then
      // re-read only to refresh the clock pairing.
      const walk = result.body?.walk;
      const open = walk && walk.endedAt === undefined ? walk : null;
      this.setState({
        ...(walk ? { walk: { ...(this.state.walk ?? { serverNow: new Date().toISOString(), staleAfterMs: 0, receivedAt: Date.now() }), open } } : {}),
        walkBusy: null,
        walkPending: null,
        walkMessage: result.body?.replayed ? "Already saved." : "Saved.",
        walkFormOpen: false,
        walkDiscardOpen: false,
        walkDraft: { pee: "", poop: "", dogsMet: "", mood: "", notes: "" },
      });
      this.walkSeq = (this.walkSeq ?? 0) + 1;
      await this.loadWalks();
      return;
    }

    // Every terminal refusal clears the form so a later walk cannot inherit this
    // one's draft, and the message is set *after* any re-read (the read clears
    // the error slot).
    const resetForm = {
      walkFormOpen: false,
      walkDiscardOpen: false,
      walkDraft: { pee: "", poop: "", dogsMet: "", mood: "", notes: "" },
    };

    if (result.status === 409 && (result.body?.error === "walk_open" || result.body?.error === "walk_stale")) {
      const walk = result.body.walk;
      if (this.state.walk === null) {
        // No clock pairing to keep: the next read supplies `serverNow`.
        this.setState({ walkBusy: null, walkPending: null, walkMessage: null, ...resetForm });
        await this.loadWalks();
        this.setState({ walkError: result.body.message });
        return;
      }
      // Keep `serverNow`/`receivedAt` together: re-stamping `receivedAt` against
      // the old instant would rewind the timer.
      this.setState({
        walkBusy: null,
        walkPending: null,
        walkMessage: null,
        walkError: result.body.message,
        ...(walk ? { walk: { ...this.state.walk, open: walk } } : {}),
        ...resetForm,
      });
      return;
    }

    if (result.status === 409) {
      const walk = result.body?.walk;
      this.setState({ walkBusy: null, walkPending: null, walkMessage: null, ...resetForm });
      await this.loadWalks();
      const ended = walk?.endedAt ? walkTimeText(walk.endedAt, this.timezone()) : null;
      const sentence =
        result.body?.error === "walk_ended" && walk
          ? `${walk.endedByLabel ?? walk.startedByLabel} already ended this walk${ended ? ` at ${ended}` : ""}.`
          : (result.body?.message ?? result.body?.error ?? "That walk is no longer open.");
      this.setState({ walkError: sentence });
      return;
    }

    this.setState({
      walkBusy: null,
      walkError: result.body?.error ?? "Could not update the walk. Try again.",
    });
  }

  startWalk() {
    return this.writeWalk("/api/walks/start", {}, "start");
  }

  endWalk() {
    const walk = this.state.walk?.open;
    if (!walk) return Promise.resolve();
    const draft = this.state.walkDraft;
    const body = { walkId: walk.id };
    if (draft.pee.trim() !== "") body.pee = Number(draft.pee);
    if (draft.poop.trim() !== "") body.poop = Number(draft.poop);
    for (const field of ["dogsMet", "mood", "notes"]) {
      if (draft[field].trim() !== "") body[field] = draft[field];
    }
    return this.writeWalk("/api/walks/end", body, "end");
  }

  discardWalk() {
    const walk = this.state.walk?.open;
    if (!walk) return Promise.resolve();
    return this.writeWalk("/api/walks/discard", { walkId: walk.id }, "discard");
  }

  setWalkDraft(field, value) {
    this.setState({ walkDraft: { ...this.state.walkDraft, [field]: value } });
  }

  markFed(slotId) {
    return this.write("/api/feeding/fed", { slotId }, slotId);
  }

  logExtra() {
    const body = {};
    const amount = this.state.extraAmount.trim();
    const note = this.state.extraNote.trim();
    if (amount !== "") body.amount = amount;
    if (note !== "") body.note = note;
    return this.write("/api/feeding/extra", body, "extra");
  }

  renderMeal(row) {
    const { slot, feed, status } = row;
    const busy = this.state.busy !== null;
    return html`
      <li key=${slot.id} class=${`meal meal--${status}`}>
        <div class="meal__head">
          <span class="meal__label">${slot.label}</span>
          <span class="meal__time">${slot.timeLocal}</span>
        </div>
        <p class="meal__status">
          ${
            status === "fed"
              ? html`Fed by ${feed.byLabel} at ${feedTimeText(feed.at, this.timezone())}`
              : status === "overdue"
                ? "Overdue — not fed yet"
                : "Pending"
          }
        </p>
        ${
          status === "fed"
            ? null
            : html`
                <button
                  type="button"
                  class="button"
                  disabled=${busy}
                  aria-label=${`${this.state.busy === slot.id ? "Logging" : "Mark fed"} ${slot.label}`}
                  onClick=${() => void this.markFed(slot.id)}
                >
                  ${this.state.busy === slot.id ? "Logging…" : "Mark fed"}
                </button>
              `
        }
      </li>
    `;
  }

  renderExtras(day) {
    if (day.extras.length === 0) return null;
    return html`
      <section class="meals__extras" aria-labelledby="extras-heading">
        <h2 id="extras-heading" class="card__title">Extra feedings</h2>
        <ul class="meals">
          ${day.extras.map(
            (extra) => html`
              <li key=${extra.id} class="meal meal--fed">
                <div class="meal__head">
                  <span class="meal__label">Extra</span>
                  <span class="meal__time">${feedTimeText(extra.at, this.timezone())}</span>
                </div>
                <p class="meal__status">
                  ${extra.byLabel}${extra.amount ? ` · ${extra.amount}` : ""}${extra.note ? ` · ${extra.note}` : ""}
                </p>
              </li>
            `,
          )}
        </ul>
      </section>
    `;
  }

  renderExtraForm() {
    if (!this.state.extraOpen) {
      return html`
        <div class="form__actions">
          <button type="button" class="button button--ghost" onClick=${() => this.setState({ extraOpen: true })}>
            Extra feeding…
          </button>
        </div>
      `;
    }
    const busy = this.state.busy !== null;
    return html`
      <form
        class="meal-form"
        onSubmit=${(event) => {
          event.preventDefault();
          void this.logExtra();
        }}
      >
        <div class="field">
          <label for="extra-amount">Amount (optional)</label>
          <input
            id="extra-amount"
            name="amount"
            value=${this.state.extraAmount}
            onInput=${(event) => this.setState({ extraAmount: event.currentTarget.value })}
            placeholder="e.g. 40 g"
          />
        </div>
        <div class="field">
          <label for="extra-note">Note (optional)</label>
          <input
            id="extra-note"
            name="note"
            value=${this.state.extraNote}
            onInput=${(event) => this.setState({ extraNote: event.currentTarget.value })}
            placeholder="e.g. training treat"
          />
        </div>
        <div class="form__actions">
          <button type="submit" class="button" disabled=${busy}>
            ${this.state.busy === "extra" ? "Logging…" : "Log extra feeding"}
          </button>
          <button
            type="button"
            class="button button--ghost"
            disabled=${busy}
            onClick=${() => this.setState({ extraOpen: false })}
          >
            Cancel
          </button>
        </div>
      </form>
    `;
  }

  renderWalk() {
    const data = this.state.walk;
    const open = data?.open ?? null;
    const timezone = this.timezone();
    const nowMs = this.walkNow();
    const stale = open ? walkStale(open.startedAt, nowMs, data?.staleAfterMs) : false;
    const todayDate = localDate(new Date(nowMs), timezone);
    const startDate = open ? localDate(new Date(open.startedAt), timezone) : null;
    const busy = this.state.walkBusy !== null;
    const draft = this.state.walkDraft;
    const field = (name, label, extra = {}) => html`
      <div class="field">
        <label for=${`walk-${name}`}>${label}</label>
        <input
          id=${`walk-${name}`}
          name=${name}
          value=${draft[name]}
          onInput=${(event) => this.setWalkDraft(name, event.currentTarget.value)}
          ...${extra}
        />
      </div>
    `;
    return html`
      <section class="card" aria-labelledby="walk-heading" aria-busy=${busy}>
        <h2 id="walk-heading" class="card__title">Walk</h2>
        <div class="form__status">
          ${
            this.state.walkError
              ? html`<p class="notice notice--error" role="alert">${this.state.walkError}</p>`
              : null
          }
          ${
            !this.state.walkError && this.state.walkMessage
              ? html`<p class="notice" role="status">${this.state.walkMessage}</p>`
              : null
          }
        </div>
        ${
          data === null
            ? html`<p class="form__status">${this.state.walkLoading ? "Loading the walk…" : null}</p>`
            : open === null
              ? html`
                  <p class="form__status">No walk is open.</p>
                  <div class="form__actions">
                    <button type="button" class="button" disabled=${busy} onClick=${() => void this.startWalk()}>
                      ${this.state.walkBusy === "start" ? "Starting…" : "Start a walk"}
                    </button>
                  </div>
                `
              : html`
                  <p class="walk__who">
                    ${open.startedByLabel} is walking — <span role="timer" aria-label=${`Walk started at ${walkTimeText(open.startedAt, timezone)}`}>${stale ? `${timerText((data?.staleAfterMs ?? 0) / 1000)}+` : timerText(walkSeconds(open.startedAt, nowMs))}</span>
                  </p>
                  <p class="field__hint">
                    Started ${startDate === todayDate ? "at" : `on ${startDate} at`}
                    ${walkTimeText(open.startedAt, timezone)}${timezone ? ` (${timezone})` : ""}
                  </p>
                  ${
                    stale
                      ? html`<p class="notice notice--warn">
                          This walk has been open for over
                          ${Math.floor((data?.staleAfterMs ?? 0) / 3_600_000)} hours — end it now, or discard it if
                          nobody remembers when it finished.
                        </p>`
                      : null
                  }
                  ${
                    this.state.walkFormOpen
                      ? html`
                          <form
                            class="meal-form"
                            onSubmit=${(event) => {
                              event.preventDefault();
                              void this.endWalk();
                            }}
                          >
                            <div class="slot__row">
                              ${field("pee", "Pee", { type: "number", min: "0", max: "20", inputmode: "numeric" })}
                              ${field("poop", "Poop", { type: "number", min: "0", max: "20", inputmode: "numeric" })}
                            </div>
                            ${field("dogsMet", "Dogs met (optional)")}
                            ${field("mood", "Mood (optional)")}
                            ${field("notes", "Notes (optional)")}
                            <div class="form__actions">
                              <button type="submit" class="button" disabled=${busy}>
                                ${this.state.walkBusy === "end" ? "Ending…" : "End walk"}
                              </button>
                              <button
                                type="button"
                                class="button button--ghost"
                                disabled=${busy}
                                onClick=${() => this.setState({ walkFormOpen: false })}
                              >
                                Cancel
                              </button>
                            </div>
                          </form>
                        `
                      : html`
                          <div class="form__actions">
                            <button
                              type="button"
                              class="button"
                              disabled=${busy}
                              onClick=${() => this.setState({ walkFormOpen: true })}
                            >
                              End walk…
                            </button>
                            ${
                              stale
                                ? html`<button
                                    type="button"
                                    class="button button--ghost"
                                    disabled=${busy}
                                    onClick=${() => this.setState({ walkDiscardOpen: true })}
                                  >
                                    Discard…
                                  </button>`
                                : null
                            }
                          </div>
                        `
                  }
                  ${
                    stale && this.state.walkDiscardOpen
                      ? html`
                          <div class="notice notice--warn" role="group" aria-label="Confirm discard">
                            <p>Discard this walk? The record stays, marked as discarded; its duration is not trusted.</p>
                            <div class="form__actions">
                              <button type="button" class="button" disabled=${busy} onClick=${() => void this.discardWalk()}>
                                ${this.state.walkBusy === "discard" ? "Discarding…" : "Yes, discard"}
                              </button>
                              <button
                                type="button"
                                class="button button--ghost"
                                disabled=${busy}
                                onClick=${() => this.setState({ walkDiscardOpen: false })}
                              >
                                Keep it open
                              </button>
                            </div>
                          </div>
                        `
                      : null
                  }
                `
        }
      </section>
    `;
  }

  renderMeals() {
    const profile = getState().profile;
    const day = this.state.day;
    if (day === null) {
      return html`<p class="form__status">${this.state.loading ? "Loading today's meals…" : null}</p>`;
    }
    const clock = mealClock(day, this.timezone());
    const rows = mealRows(day, clock);
    const dateLabel = day.localDate === clock.today ? "Today" : day.localDate;
    return html`
      <section class="card" aria-labelledby="meals-heading" aria-busy=${this.state.busy !== null}>
        <h2 id="meals-heading" class="card__title">Meals · ${dateLabel}</h2>
        ${
          profile?.household?.timezone
            ? html`<p class="field__hint">Times are ${profile.household.timezone}.</p>`
            : null
        }
        ${
          rows.length === 0
            ? html`<p class="placeholder">No meal times yet — add them in Settings.</p>`
            : html`<ul class="meals">${rows.map((row) => this.renderMeal(row))}</ul>`
        }
        ${this.renderExtraForm()}
      </section>
      ${this.renderExtras(day)}
    `;
  }

  render() {
    const profile = getState().profile;
    // No profile is "not read yet": show Today rather than flashing the wizard
    // at a household that finished setup long ago (P1-14).
    if (profile?.setup?.complete === false) return h(Setup, {});

    return html`
      <section class="view" aria-labelledby="today-heading">
        <h1 id="today-heading">Today</h1>
        <div class="form__status">
          ${
            this.state.error
              ? html`<p
                  class="notice notice--error"
                  role="alert"
                  tabindex="-1"
                  ref=${(el) => {
                    this.noticeEl = el;
                  }}
                >
                  ${this.state.error}
                </p>`
              : null
          }
          ${
            !this.state.error && this.state.message
              ? html`<p
                  class="notice"
                  role="status"
                  tabindex="-1"
                  ref=${(el) => {
                    this.noticeEl = el;
                  }}
                >
                  ${this.state.message}
                </p>`
              : null
          }
        </div>
        ${this.renderWalk()}
        ${this.renderMeals()}
        <p class="placeholder">
          Weight and the agent bar arrive with their phases; meals and the walk are already shared
          between both caregivers live.
        </p>
      </section>
    `;
  }
}
