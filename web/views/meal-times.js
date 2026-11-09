// Settings → Meal times: the schedule editor a caregiver reaches after setup.
//
// Why this exists: the meal schedule could previously only be changed from the
// first-run wizard, which is a first-run checklist, not a place a person goes
// to move breakfast (P1-14’s carried-out note recorded that plainly; P4-11 is
// the fix). The plan’s Settings screen (§13.1) lists a "Meal schedule" item
// of its own, and this is it.
//
// Rules it follows, the same as the wizard's:
//   * the editor itself is the shared `MealSlots` component and `wireSlots`, so
//     this card and the wizard cannot accept different shapes;
//   * one save is one care commit carrying the revision it read plus an
//     idempotency key held with its body (`pendingSave`), so a retry of the
//     same edit replays instead of conflicting with itself;
//   * a 409 `stale` keeps the draft and shows the current state — the next save
//     is a deliberate replacement, never a silent overwrite;
//   * a live frame for the other caregiver's reschedule does the same: a clean
//     draft follows it, a dirty one is kept and flagged.
//
// The class, not a hook: the shell serves no import map (PLAN §13.2).

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, requestJson } from "../client.js";
import { getState, setState, subscribe } from "../store.js";
import { isNewer, pendingSave } from "../profile-form.js";
import {
  CONFLICT_MESSAGE,
  MealSlots,
  SLOT_HINT,
  appendSlot,
  editSlot,
  removeSlotAt,
  scheduleDrafts,
  slotDraftsOf,
  toggleSlot,
  wireSlots,
} from "./meal-slots.js";

const html = htm.bind(h);

export class MealTimes extends Component {
  state = {
    profile: null,
    slots: [],
    dirty: false,
    busy: false,
    error: null,
    message: null,
    conflict: null,
    /** The key of the save on the wire with the body it belongs to. */
    pending: null,
  };

  componentDidMount() {
    this.request = this.props?.request ?? requestJson;
    this.unsubscribe = subscribe((state) => this.onStore(state));
    const cached = getState().profile;
    // Settings only renders this card once it holds a profile, so the cached
    // branch is the production path; `load` covers a standalone mount (a test,
    // or a future embed before the first frame).
    if (cached) this.adopt(cached);
    else void this.load();
  }

  componentWillUnmount() {
    this.unsubscribe?.();
  }

  async load() {
    try {
      const result = await this.request("/api/puppy");
      if (result.status === 401) {
        this.setState({ error: "Please sign in again." });
        return;
      }
      if (!result.ok) {
        this.setState({ error: "Could not load the meal times." });
        return;
      }
      this.adopt(result.body);
    } catch (error) {
      this.setState({ error: error instanceof NetworkError ? error.message : "Could not load the meal times." });
    }
  }

  /** Take a whole view as the truth; a dirty draft is never overwritten by it. */
  adopt(profile, extra = {}) {
    // Never let a response read before a frame already on screen move the card
    // backwards.
    const current = this.state.profile;
    const next = current !== null && !isNewer(profile, current) ? current : profile;
    this.setState({
      profile: next,
      ...(this.state.dirty ? {} : { slots: scheduleDrafts(next.meals) }),
      ...extra,
    });
  }

  /** A frame from `live.js`: the other caregiver saved the schedule. */
  onStore(state) {
    const incoming = state.profile;
    if (!incoming) return;
    const current = this.state.profile;
    if (current === null) {
      this.adopt(incoming);
      return;
    }
    // One frame is one whole read; if any revision went backwards the frame is
    // older than what is already on screen.
    if (!isNewer(incoming, current)) return;
    if (incoming.meals.rev !== current.meals.rev) {
      if (!this.state.dirty) {
        this.adopt(incoming);
        return;
      }
      // A frame is broadcast on the commit path, so it usually beats the save's
      // own response. While this card's save is in flight it is (almost always)
      // that save: keeping the draft is right, warning about "someone else" is
      // not. A real concurrent edit still answers 409 `stale`.
      // The revision moves forward either way, so the caregiver's next save is
      // the knowing replacement the banner promises — not a guaranteed stale.
      if (this.state.pending === null) this.setState({ profile: incoming, conflict: CONFLICT_MESSAGE });
      return;
    }
    // A newer frame that did not touch the schedule (a puppy edit, a partner
    // joining) still moves the profile forward.
    this.setState({ profile: incoming });
  }

  onInput = (index, field, value) => {
    this.setState({ slots: editSlot(this.state.slots, index, field, value), dirty: true, message: null });
  };

  onToggle = (index) => {
    this.setState({ slots: toggleSlot(this.state.slots, index), dirty: true, message: null });
  };

  addSlot = () => {
    this.setState({ slots: appendSlot(this.state.slots), dirty: true, message: null });
  };

  removeSlot = (index) => {
    this.setState({ slots: removeSlotAt(this.state.slots, index), dirty: true, message: null });
  };

  save = (event) => {
    event.preventDefault();
    const { profile, slots } = this.state;
    if (!profile || this.state.busy) return;
    if (slots.length === 0) {
      this.setState({ error: "Add at least one meal time." });
      return;
    }
    const body = { rev: profile.meals.rev, slots: wireSlots(slots) };
    const pending = pendingSave(this.state.pending, body);
    this.setState({ busy: true, error: null, message: null, pending });
    // Returned, not fired-and-forgotten: the submit handler ignores it, and a
    // test (or a future caller) can await the settle.
    return this.send(body, pending);
  };

  async send(body, pending) {
    try {
      const result = await this.request("/api/feeding/slots", {
        method: "PATCH",
        body,
        idempotencyKey: pending.key,
      });
      if (result.status === 401) {
        this.setState({ busy: false, error: "Please sign in again." });
        return;
      }
      if (result.status === 409 && result.body?.error === "stale") {
        // Keep the draft and show the current state; the next save is a knowing
        // replacement, and a new body gets a new key.
        this.adopt(result.body.profile, { busy: false, conflict: CONFLICT_MESSAGE, pending: null });
        return;
      }
      if (!result.ok) {
        // The key stays pending: another attempt at the same body replays it.
        // A hand-built refusal (`stale`, `idempotency_conflict`) carries its
        // sentence in `message` and a machine code in `error`; a thrown one
        // carries the sentence in `error` alone. Prefer the sentence.
        this.setState({
          busy: false,
          error: result.body?.message ?? result.body?.error ?? "Could not save. Try again.",
        });
        return;
      }
      // Tell the shell too, so Today and the other caregiver's screen update
      // immediately rather than on the next `profile` frame — unless the stream
      // already delivered something newer.
      if (isNewer(result.body.profile, getState().profile)) setState({ profile: result.body.profile });
      // The save is settled: the draft is no longer dirty, and the inputs take
      // the server's normalisation (trimmed label, `HH:MM`, dropped empty
      // portion) — the same `done` callback the wizard uses. Without this the
      // card would believe it still had unsaved edits and every later frame for
      // this schedule would raise a false conflict.
      this.adopt(result.body.profile, {
        busy: false,
        conflict: null,
        message: result.body.replayed ? "Already saved." : "Saved.",
        pending: null,
        dirty: false,
        slots: slotDraftsOf(result.body.profile.meals.slots),
      });
    } catch (error) {
      // A transport failure may still have committed; keeping the key makes the
      // retry a replay instead of a second revision.
      this.setState({
        busy: false,
        error: error instanceof NetworkError ? error.message : "Could not save. Try again.",
      });
    }
  }

  render() {
    const { profile, slots, busy, error, message, conflict } = this.state;
    if (profile === null) {
      return html`
        <section class="card" aria-labelledby="meal-times-heading">
          <h2 id="meal-times-heading" class="card__title">Meal times</h2>
          ${error
            ? html`<p class="notice notice--error" role="alert">${error}</p>`
            : html`<p class="placeholder">Loading the meal times…</p>`}
        </section>
      `;
    }
    return html`
      <section class="card" aria-labelledby="meal-times-heading">
        <h2 id="meal-times-heading" class="card__title">Meal times</h2>
        <p class="field__hint">${SLOT_HINT}</p>
        ${conflict ? html`<p class="notice notice--warn" role="status">${conflict}</p>` : null}
        ${error ? html`<p class="notice notice--error" role="alert">${error}</p>` : null}
        ${message ? html`<p class="notice" role="status">${message}</p>` : null}
        <form class="form" onSubmit=${this.save}>
          <${MealSlots}
            slots=${slots}
            busy=${busy}
            onInput=${this.onInput}
            onToggle=${this.onToggle}
            onAdd=${this.addSlot}
            onRemove=${this.removeSlot}
          />
          <div class="form__actions">
            <button class="button" type="submit" disabled=${busy}>
              ${busy ? "Saving…" : "Save meal times"}
            </button>
          </div>
        </form>
      </section>
    `;
  }
}
