// First-run setup — the puppy, the household timezone and the meal schedule
// (PLAN §13.1, §16 P1-14).
//
// Why it exists: a fresh household boots with an empty puppy and no meals, and
// a timezone nobody has checked. A wrong zone corrupts every future `localDate`
// (feeding slots, walks, growth, the activity feed's day), so the wizard treats
// the confirmation as a real action, not a formality.
//
// Rules the component follows:
//   * every save is **one** care commit carrying the revision it read plus an
//     idempotency key (§7.4). The key is held with the body it belongs to, so a
//     retried save replays instead of conflicting with itself (P1-11's fix, now
//     shared through `../profile-form.js`);
//   * a 409 `stale` is not an error: the other caregiver's change is shown, the
//     draft is kept, and saving again is a deliberate replacement;
//   * there is no advice anywhere — the wizard collects and confirms;
//   * it is a Preact class, not a hook: the shell serves no import map and the
//     vendored hooks module needs a bare `preact` specifier (PLAN §13.2).

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, requestJson } from "../client.js";
import { changedFields, draftOf, emptyDraft, isNewer, pendingSave } from "../profile-form.js";
import { getState, setState, subscribe } from "../store.js";
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

/**
 * A short list for the datalist, not the whole IANA catalog: the field accepts
 * any zone the server can validate, and a 600-entry dropdown is heavy on a
 * phone. `Intl` (the button beside it) knows the device's own zone.
 */
const COMMON_ZONES = [
  "UTC",
  "Europe/Paris",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Lisbon",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Asia/Tokyo",
  "Australia/Sydney",
];

function deviceZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" ? zone : "";
  } catch {
    return "";
  }
}

/**
 * "It is now … in this zone", from the device's clock. The caregiver compares
 * it with the clock in front of them — that is the whole confirmation.
 */
function zonePreview(zone) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    }).format(new Date());
  } catch {
    return null;
  }
}

export class Setup extends Component {
  state = {
    profile: null,
    zone: "",
    zoneDirty: false,
    puppy: emptyDraft(),
    puppyDirty: false,
    slots: [],
    slotsDirty: false,
    busy: null,
    error: null,
    message: null,
    conflict: null,
    /** Per section: the key of the save on the wire with the body it belongs to. */
    pending: {},
  };

  componentDidMount() {
    this.unsubscribe = subscribe((state) => this.onStore(state));
    const cached = getState().profile;
    if (cached) this.adopt(cached);
    else void this.load();
  }

  componentWillUnmount() {
    this.unsubscribe?.();
  }

  async load() {
    try {
      const result = await requestJson("/api/puppy");
      if (result.status === 401) {
        this.setState({ error: "Please sign in again." });
        return;
      }
      if (!result.ok) {
        this.setState({ error: "Could not load the household. Try again in a moment." });
        return;
      }
      this.adopt(result.body);
    } catch (error) {
      this.setState({ error: error instanceof NetworkError ? error.message : "Could not load the household." });
    }
  }

  /** Take a whole view as the truth; untouched sections follow it, dirty ones do not. */
  adopt(profile, extra = {}) {
    // Never let a response that was read before a frame already on screen move
    // the wizard (or the shell) backwards.
    const current = this.state.profile;
    const next = current !== null && !isNewer(profile, current) ? current : profile;
    this.setState({
      profile: next,
      ...(this.state.zoneDirty ? {} : { zone: next.household.timezone }),
      ...(this.state.puppyDirty ? {} : { puppy: draftOf(next) }),
      ...(this.state.slotsDirty ? {} : { slots: scheduleDrafts(next.meals) }),
      ...extra,
    });
  }

  /**
   * A frame from `live.js`: the other caregiver saved something. A section the
   * caregiver is editing keeps its draft and says so; the rest follows.
   */
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
    // A frame is broadcast on the commit path, so it usually beats the save's
    // own response. While a section's save is in flight its frame is (almost
    // always) that save: keeping the draft is right, warning about "someone
    // else" is not. A real concurrent edit still answers 409 `stale`.
    const next = { profile: incoming };
    const mine = (section) => this.state.pending[section] !== undefined;
    if (incoming.household.rev !== current.household.rev) {
      if (!this.state.zoneDirty) next.zone = incoming.household.timezone;
      else if (!mine("timezone")) next.conflict = CONFLICT_MESSAGE;
    }
    if (incoming.rev !== current.rev) {
      if (!this.state.puppyDirty) next.puppy = draftOf(incoming);
      else if (!mine("puppy")) next.conflict = CONFLICT_MESSAGE;
    }
    if (incoming.meals.rev !== current.meals.rev) {
      if (!this.state.slotsDirty) {
        next.slots = scheduleDrafts(incoming.meals);
      } else if (!mine("slots")) {
        next.conflict = CONFLICT_MESSAGE;
      }
    }
    this.setState(next);
  }

  /** One care write, with the replay/stale handling every section shares. */
  async send(section, path, body, done) {
    if (this.state.busy) return;
    const pending = pendingSave(this.state.pending[section], body);
    this.setState({
      busy: section,
      error: null,
      message: null,
      pending: { ...this.state.pending, [section]: pending },
    });
    try {
      const result = await requestJson(path, { method: "PATCH", body, idempotencyKey: pending.key });
      if (result.status === 401) {
        this.setState({ busy: null, error: "Please sign in again." });
        return;
      }
      if (result.status === 409 && result.body?.error === "stale") {
        // Keep the draft and show the current state; the next save is a knowing
        // replacement, and a new body gets a new key.
        const { [section]: _dropped, ...rest } = this.state.pending;
        this.adopt(result.body.profile, { busy: null, conflict: CONFLICT_MESSAGE, pending: rest });
        return;
      }
      if (!result.ok) {
        // The key stays pending: another attempt at the same body replays it.
        // A hand-built refusal (`stale`, `idempotency_conflict`) carries its
        // sentence in `message`; a thrown one carries it in `error`.
        this.setState({
          busy: null,
          error: result.body?.message ?? result.body?.error ?? "Could not save. Try again.",
        });
        return;
      }
      const { [section]: _used, ...rest } = this.state.pending;
      // Tell the shell too, so Today's gate lifts on this screen immediately
      // rather than on the next `profile` frame — unless the stream already
      // delivered something newer.
      if (isNewer(result.body.profile, getState().profile)) setState({ profile: result.body.profile });
      this.adopt(result.body.profile, {
        busy: null,
        conflict: null,
        message: result.body.replayed ? "Already saved." : "Saved.",
        pending: rest,
        ...done(result.body.profile),
      });
    } catch (error) {
      // A transport failure may still have committed; keeping the key makes the
      // retry a replay instead of a second revision.
      this.setState({
        busy: null,
        error: error instanceof NetworkError ? error.message : "Could not save. Try again.",
      });
    }
  }

  saveZone = (event) => {
    event.preventDefault();
    const { profile, zone } = this.state;
    if (!profile) return;
    const timezone = zone.trim();
    if (timezone === "") {
      this.setState({ error: "Pick the household's timezone first." });
      return;
    }
    void this.send("timezone", "/api/household", { rev: profile.household.rev, timezone }, (saved) => ({
      zone: saved.household.timezone,
      zoneDirty: false,
    }));
  };

  savePuppy = (event) => {
    event.preventDefault();
    const { profile, puppy } = this.state;
    if (!profile) return;
    if (puppy.name.trim() === "") {
      this.setState({ error: "The puppy needs a name before this can be saved." });
      return;
    }
    const patch = changedFields(profile.puppy, puppy);
    if (Object.keys(patch).length === 0) {
      this.setState({ message: "No changes to save.", error: null });
      return;
    }
    void this.send("puppy", "/api/puppy", { rev: profile.rev, ...patch }, (saved) => ({
      puppy: draftOf(saved),
      puppyDirty: false,
    }));
  };

  saveSlots = (event) => {
    event.preventDefault();
    const { profile, slots } = this.state;
    if (!profile) return;
    if (slots.length === 0) {
      this.setState({ error: "Add at least one meal time." });
      return;
    }
    void this.send("slots", "/api/feeding/slots", { rev: profile.meals.rev, slots: wireSlots(slots) }, (saved) => ({
      slots: slotDraftsOf(saved.meals.slots),
      slotsDirty: false,
    }));
  };

  onZoneInput = (event) => {
    this.setState({ zone: event.target.value, zoneDirty: true, message: null });
  };

  useDeviceZone = () => {
    const zone = deviceZone();
    if (zone !== "") this.setState({ zone, zoneDirty: true, message: null });
  };

  onPuppyInput = (event) => {
    const { name, value } = event.target;
    this.setState({ puppy: { ...this.state.puppy, [name]: value }, puppyDirty: true, message: null });
  };

  onSlotInput = (index, field, value) => {
    this.setState({ slots: editSlot(this.state.slots, index, field, value), slotsDirty: true, message: null });
  };

  onSlotToggle = (index) => {
    this.setState({ slots: toggleSlot(this.state.slots, index), slotsDirty: true, message: null });
  };

  addSlot = () => {
    this.setState({ slots: appendSlot(this.state.slots), slotsDirty: true, message: null });
  };

  removeSlot = (index) => {
    this.setState({ slots: removeSlotAt(this.state.slots, index), slotsDirty: true, message: null });
  };

  render() {
    const { profile, zone, puppy, slots, busy, error, message, conflict } = this.state;

    // Embedded in Settings the wizard sits under the page's own heading; on
    // Today it *is* the page.
    const heading = this.props.embedded ? "h2" : "h1";

    if (profile === null) {
      return html`
        <section class=${this.props.embedded ? "setup" : "view"} aria-labelledby="setup-heading">
          <${heading} id="setup-heading">First-run setup</${heading}>
          ${error
            ? html`<p class="notice notice--error" role="alert">${error}</p>`
            : html`<p class="placeholder">Loading the household…</p>`}
        </section>
      `;
    }

    const { setup } = profile;
    const preview = zonePreview(zone.trim());
    const zoneChanged = zone.trim() !== profile.household.timezone;
    const stepState = (step) => (setup.missing.includes(step) ? "to do" : "done");

    return html`
      <section class=${this.props.embedded ? "setup" : "view"} aria-labelledby="setup-heading">
        <${heading} id="setup-heading">First-run setup</${heading}>
        <p class="lead">
          ${setup.complete
            ? "Everything is set up."
            : html`<span>${3 - setup.missing.length} of 3 ready</span>`}
        </p>
        ${setup.complete
          ? html`<p class="notice">Both caregivers can use Pupkeep from today on. You can change any of this later in Settings.</p>`
          : html`<p class="placeholder">
              Three quick things before Today: the household timezone, your puppy, and the meal
              times you want to keep.
            </p>`}

        ${conflict ? html`<p class="notice notice--warn" role="status">${conflict}</p>` : null}
        ${error ? html`<p class="notice notice--error" role="alert">${error}</p>` : null}
        ${message ? html`<p class="notice" role="status">${message}</p>` : null}

        <form class="card form" onSubmit=${this.saveZone}>
          <h2 class="card__title">1. Household timezone (${stepState("timezone")})</h2>
          <p class="field__hint">
            Every date in Pupkeep — meals, walks, growth — is worked out in this zone. Boot captured
            ${profile.household.timezone}; please check it.
          </p>
          <div class="field">
            <label for="setup-zone">Timezone</label>
            <input
              id="setup-zone"
              name="timezone"
              type="text"
              list="pupkeep-zones"
              autocomplete="off"
              spellcheck="false"
              value=${zone}
              onInput=${this.onZoneInput}
              disabled=${busy !== null}
            />
            <datalist id="pupkeep-zones">
              ${COMMON_ZONES.map((name) => html`<option key=${name} value=${name}></option>`)}
            </datalist>
            <p class="field__hint">
              ${preview === null
                ? "Use an IANA name such as Europe/Paris."
                : `In ${zone.trim() || "this zone"} it is ${preview} right now.`}
            </p>
          </div>
          <div class="form__actions">
            <button class="button" type="submit" disabled=${busy !== null}>
              ${busy === "timezone" ? "Saving…" : zoneChanged ? "Save timezone" : "Confirm timezone"}
            </button>
            <button class="button button--ghost" type="button" onClick=${this.useDeviceZone} disabled=${busy !== null}>
              Use this device's zone
            </button>
          </div>
        </form>

        <form class="card form" onSubmit=${this.savePuppy}>
          <h2 class="card__title">2. Your puppy (${stepState("puppy")})</h2>
          <div class="field">
            <label for="setup-name">Name</label>
            <input
              id="setup-name"
              name="name"
              type="text"
              maxlength="60"
              required
              autocomplete="off"
              value=${puppy.name}
              onInput=${this.onPuppyInput}
              disabled=${busy !== null}
            />
          </div>
          <div class="field">
            <label for="setup-birthday">Birthday</label>
            <input
              id="setup-birthday"
              name="birthday"
              type="date"
              value=${puppy.birthday}
              onInput=${this.onPuppyInput}
              disabled=${busy !== null}
            />
            <p class="field__hint">A household date; the age is worked out from it.</p>
          </div>
          <div class="field">
            <label for="setup-breed">Breed</label>
            <input
              id="setup-breed"
              name="breed"
              type="text"
              maxlength="60"
              autocomplete="off"
              value=${puppy.breed}
              onInput=${this.onPuppyInput}
              disabled=${busy !== null}
            />
          </div>
          <div class="field">
            <label for="setup-sex">Sex</label>
            <select
              id="setup-sex"
              name="sex"
              value=${puppy.sex}
              onChange=${this.onPuppyInput}
              disabled=${busy !== null}
            >
              <option value="">Not set</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </div>
          <div class="field">
            <label for="setup-weight">Target weight (kg)</label>
            <input
              id="setup-weight"
              name="targetWeightKg"
              type="number"
              min="0.1"
              max="200"
              step="0.01"
              inputmode="decimal"
              value=${puppy.targetWeightKg}
              onInput=${this.onPuppyInput}
              disabled=${busy !== null}
            />
          </div>
          <div class="form__actions">
            <button class="button" type="submit" disabled=${busy !== null}>
              ${busy === "puppy" ? "Saving…" : "Save puppy"}
            </button>
          </div>
        </form>

        ${setup.complete
          ? html`<p class="field__hint">
              Meal times are edited in the <a href="#settings">Meal times card</a> above.
            </p>`
          : html`<form class="card form" onSubmit=${this.saveSlots}>
              <h2 class="card__title">3. Meal times (${stepState("meals")})</h2>
              <p class="field__hint">${SLOT_HINT}</p>
              <${MealSlots}
                slots=${slots}
                busy=${busy !== null}
                onInput=${this.onSlotInput}
                onToggle=${this.onSlotToggle}
                onAdd=${this.addSlot}
                onRemove=${this.removeSlot}
              />
              <div class="form__actions">
                <button class="button" type="submit" disabled=${busy !== null}>
                  ${busy === "slots" ? "Saving…" : "Save meal times"}
                </button>
              </div>
            </form>`}

        ${setup.complete
          ? html`<p class="form__actions"><a class="button" href="#today">Go to Today</a></p>`
          : null}
      </section>
    `;
  }
}
