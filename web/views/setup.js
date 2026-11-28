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
import { NetworkError, newIdempotencyKey, requestJson } from "../client.js";
import { changedFields, CONFLICT_MESSAGE, draftOf, emptyDraft, isNewer, pendingSave } from "../profile-form.js";
import { bootZoneHint } from "../household.js";
import { currentModelText, probeResultLines, probeText, providerKeyBody } from "../models.js";
import { getState, setState, subscribe } from "../store.js";
import {
  MEAL_CONFLICT_MESSAGE,
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
 * The setup steps in card order (§R3): the derivation in `setup.missing` names
 * the same five, so the lead's ready count and every card's (done)/(to do) come
 * from this one list rather than from a hardcoded number.
 */
const SETUP_STEPS = ["name", "timezone", "puppy", "meals", "key"];

/** The providers one key can be stored for, in the card's order. */
const PROVIDERS = ["opencode-go", "openrouter"];

/**
 * Shown when the other caregiver's save completes setup while this screen holds
 * an unsaved meal draft. The wizard's meal form is gone from then on, so the
 * conflict banner's "saving again" promise would be false.
 */
const COMPLETED_MEAL_MESSAGE =
  "Setup is complete, so this screen no longer edits meal times. Your unsaved times were not kept; the schedule in the Meal times card above is the one stored.";

/**
 * The one sentence for the sections a frame moved, if any. It names the meals
 * only when the meals are the only thing that moved: one frame can carry
 * several revisions (a reconnect re-reads the whole view), and blaming the
 * meals for a puppy edit is the misattribution this copy exists to avoid.
 */
function conflictFor(sections) {
  if (sections.length === 0) return undefined;
  return sections.length === 1 && sections[0] === "slots" ? MEAL_CONFLICT_MESSAGE : CONFLICT_MESSAGE;
}

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
    /** The household-name card's draft. */
    name: "",
    nameDirty: false,
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
    /** `GET /api/models`: the key card's provider presence, probe and role. */
    models: null,
    role: null,
    /** The key fields' drafts, per provider; never rendered back. */
    keyDrafts: {},
    modelsBusy: null,
    modelsMessage: null,
    modelsError: null,
  };

  componentDidMount() {
    this.request = this.props?.request ?? requestJson;
    this.unsubscribe = subscribe((state) => this.onStore(state));
    const cached = getState().profile;
    if (cached) this.adopt(cached);
    else void this.load();
    void this.loadModels();
  }

  componentWillUnmount() {
    this.unsubscribe?.();
  }

  /** The HTTP half, swappable from the tests (the Today screen's pattern). */
  get http() {
    return this.request ?? requestJson;
  }

  async load() {
    try {
      const result = await this.http("/api/puppy");
      if (result.status === 401) {
        this.setState({ error: "Please sign in again." });
        return;
      }
      if (!result.ok) {
        this.setState({ error: "Could not load the household. Try again in a moment." });
        return;
      }
      // Tell the shell too, like a care write does. The key save publishes no
      // profile frame (a secrets.json write is not a commit), so this re-read
      // is the only thing that can lift Today's gate when the key was the
      // last step — without it the shell stays locked on #/setup until a
      // reload or a reconnect. The same revision guard a care write uses
      // keeps a re-read that raced a newer frame from moving the shell
      // backwards.
      if (isNewer(result.body, getState().profile)) setState({ profile: result.body });
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
      ...(this.state.nameDirty ? {} : { name: next.household.name }),
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
    // Which dirty sections this frame moved; the banner's single sentence is
    // chosen from the whole list, so a frame that moved two does not name one.
    const moved = [];
    const blame = (section) => {
      if (!mine(section)) moved.push(section);
    };
    // The name and the timezone live in the same household document, so one
    // frame can move either or both drafts; each dirty section is blamed for
    // itself, never for its neighbour.
    if (incoming.household.rev !== current.household.rev) {
      if (!this.state.nameDirty) next.name = incoming.household.name;
      else blame("name");
      if (!this.state.zoneDirty) next.zone = incoming.household.timezone;
      else blame("timezone");
    }
    if (incoming.rev !== current.rev) {
      if (!this.state.puppyDirty) next.puppy = draftOf(incoming);
      else blame("puppy");
    }
    if (incoming.meals.rev !== current.meals.rev) {
      if (!this.state.slotsDirty) {
        next.slots = scheduleDrafts(incoming.meals);
      } else {
        blame("slots");
      }
    }
    // The frame that completes setup takes the wizard's meal form away — the
    // Settings card above owns the schedule from then on — so an unsaved meal
    // draft has nowhere left to be saved. Replace it with the committed
    // schedule and say so, rather than promising a save that has no button.
    const completes = !current.setup.complete && incoming.setup.complete;
    const droppedDraft = completes && this.state.slotsDirty && !mine("slots");
    if (droppedDraft) {
      next.slots = scheduleDrafts(incoming.meals);
      next.slotsDirty = false;
      next.message = COMPLETED_MEAL_MESSAGE;
    }
    const conflict = conflictFor(droppedDraft ? moved.filter((section) => section !== "slots") : moved);
    if (conflict !== undefined) next.conflict = conflict;
    this.setState(next);
  }

  /** One care write, with the replay/stale handling every section shares. */
  async send(section, path, method, body, done) {
    if (this.state.busy) return;
    const pending = pendingSave(this.state.pending[section], body);
    this.setState({
      busy: section,
      error: null,
      message: null,
      pending: { ...this.state.pending, [section]: pending },
    });
    try {
      const result = await this.http(path, { method, body, idempotencyKey: pending.key });
      if (result.status === 401) {
        this.setState({ busy: null, error: "Please sign in again." });
        return;
      }
      if (result.status === 409 && result.body?.error === "stale") {
        // Keep the draft and show the current state; the next save is a knowing
        // replacement, and a new body gets a new key.
        const { [section]: _dropped, ...rest } = this.state.pending;
        this.adopt(result.body.profile, { busy: null, conflict: conflictFor([section]), pending: rest });
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

  /** The household name: one care write, sent even when the text is unchanged
   * — confirming the default name is the step, not a no-op (R4). */
  saveName = (event) => {
    event.preventDefault();
    const { profile, name } = this.state;
    if (!profile) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      this.setState({ error: "Give the household a name first." });
      return;
    }
    void this.send("name", "/api/household", "PATCH", { rev: profile.household.rev, name: trimmed }, (saved) => ({
      name: saved.household.name,
      nameDirty: false,
    }));
  };

  saveZone = (event) => {
    event.preventDefault();
    const { profile, zone } = this.state;
    if (!profile) return;
    const timezone = zone.trim();
    if (timezone === "") {
      this.setState({ error: "Pick the household's timezone first." });
      return;
    }
    void this.send("timezone", "/api/household", "PATCH", { rev: profile.household.rev, timezone }, (saved) => ({
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
    void this.send("puppy", "/api/puppy", "PATCH", { rev: profile.rev, ...patch }, (saved) => ({
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
    void this.send("slots", "/api/feeding/slots", "PATCH", { rev: profile.meals.rev, slots: wireSlots(slots) }, (saved) => ({
      slots: slotDraftsOf(saved.meals.slots),
      slotsDirty: false,
    }));
  };

  onNameInput = (event) => {
    this.setState({ name: event.target.value, nameDirty: true, message: null });
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

  // --- the provider-key card (the Settings model card's patterns) ----------

  get owner() {
    return this.state.role === "owner";
  }

  /** One read of the key card's facts: the role, the providers and the probe. */
  async loadModels() {
    let result;
    try {
      result = await this.http("/api/models");
    } catch (error) {
      this.setState({ modelsError: error instanceof NetworkError ? error.message : "Could not load the model settings." });
      return;
    }
    if (result.status === 401) {
      this.setState({ modelsError: "Please sign in again." });
      return;
    }
    if (!result.ok || !result.body) {
      this.setState({ modelsError: "Could not load the model settings." });
      return;
    }
    this.setState({
      models: result.body,
      role: result.body.role ?? null,
      modelsError: null,
    });
  }

  onKeyInput(provider, event) {
    this.setState({ keyDrafts: { ...this.state.keyDrafts, [provider]: event.target.value }, modelsMessage: null });
  }

  /**
   * Save one provider key (owner-only on the server). A key exists in
   * `secrets.json`, not in a Pi document, so the save publishes no profile
   * frame: the card re-reads the care view itself so the key step flips to
   * done, and re-reads the provider presence for its own display.
   */
  async saveKey(provider, key) {
    if (this.state.modelsBusy !== null) return;
    this.setState({ modelsBusy: `key:${provider}`, modelsMessage: null, modelsError: null });
    let result;
    try {
      result = await this.http("/api/models/keys", {
        method: "PUT",
        body: providerKeyBody(provider, key ?? ""),
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      this.setState({ modelsBusy: null, modelsError: error instanceof NetworkError ? error.message : "Could not save the key." });
      return;
    }
    if (!result.ok) {
      // A member's refused write (403) lands here and surfaces, without
      // taking the rest of the page down.
      this.setState({ modelsBusy: null, modelsError: result.body?.message ?? result.body?.error ?? "Could not save the key." });
      return;
    }
    this.setState({
      modelsBusy: null,
      keyDrafts: { ...this.state.keyDrafts, [provider]: "" },
      modelsMessage: key === null || key === "" ? `Key cleared for ${provider}.` : `Key saved for ${provider}.`,
    });
    void this.load();
    void this.loadModels();
  }

  /** The optional model check: visible status, never a requirement (R5). */
  async runProbe() {
    if (this.state.modelsBusy !== null) return;
    this.setState({ modelsBusy: "probe", modelsMessage: null, modelsError: null });
    let result;
    try {
      result = await this.http("/api/models/probe", {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      this.setState({ modelsBusy: null, modelsError: error instanceof NetworkError ? error.message : "The check could not run." });
      return;
    }
    if (!result.ok) {
      this.setState({ modelsBusy: null, modelsError: result.body?.message ?? result.body?.error ?? "The check could not run." });
      return;
    }
    this.setState({ modelsBusy: null, modelsMessage: "Model check finished." });
    void this.loadModels();
  }

  render() {
    const { profile, name, zone, puppy, slots, busy, error, message, conflict } = this.state;

    if (profile === null) {
      return html`
        <section class="view" aria-labelledby="setup-heading">
          <h1 id="setup-heading">First-run setup</h1>
          ${error
            ? html`<p class="notice notice--error" role="alert">${error}</p>`
            : html`<p class="placeholder">Loading the household…</p>`}
        </section>
      `;
    }

    const { setup } = profile;
    // The lead and every card's state come from the one derived step list.
    const ready = SETUP_STEPS.filter((step) => !setup.missing.includes(step)).length;
    const stepState = (step) => (setup.missing.includes(step) ? "to do" : "done");
    const nameChanged = name.trim() !== profile.household.name;
    const preview = zonePreview(zone.trim());
    const zoneChanged = zone.trim() !== profile.household.timezone;

    return html`
      <section class="view" aria-labelledby="setup-heading">
        <h1 id="setup-heading">First-run setup</h1>
        <p class="lead">
          ${setup.complete
            ? "Everything is set up."
            : html`<span>${ready} of ${SETUP_STEPS.length} ready</span>`}
        </p>
        ${setup.complete
          ? html`<p class="notice">Both caregivers can use Pupkeep from today on. You can change any of this later in Settings.</p>`
          : html`<p class="placeholder">
              Five quick things before Today: the household's name and timezone, your puppy, the meal
              times you want to keep, and one provider key for the agent.
            </p>`}

        ${conflict ? html`<p class="notice notice--warn" role="status">${conflict}</p>` : null}
        ${error ? html`<p class="notice notice--error" role="alert">${error}</p>` : null}
        ${message ? html`<p class="notice" role="status">${message}</p>` : null}

        <form class="card form" onSubmit=${this.saveName}>
          <h2 class="card__title">1. Household name (${stepState("name")})</h2>
          <p class="field__hint">
            Every feed, walk and notification belongs to this household. Save the name you want, or
            confirm the one boot chose — confirming it as it is counts.
          </p>
          <div class="field">
            <label for="setup-household-name">Household name</label>
            <input
              id="setup-household-name"
              name="name"
              type="text"
              maxlength="60"
              required
              autocomplete="off"
              value=${name}
              onInput=${this.onNameInput}
              disabled=${busy !== null}
            />
          </div>
          <div class="form__actions">
            <button class="button" type="submit" disabled=${busy !== null}>
              ${busy === "name" ? "Saving…" : nameChanged ? "Save name" : "Confirm name"}
            </button>
          </div>
        </form>

        <form class="card form" onSubmit=${this.saveZone}>
          <h2 class="card__title">2. Household timezone (${stepState("timezone")})</h2>
          <p class="field__hint">${bootZoneHint(profile.household.timezone)}</p>
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
          <h2 class="card__title">3. Your puppy (${stepState("puppy")})</h2>
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
          ? html`<p class="field__hint">Meal times are edited in the Meal times card above.</p>`
          : html`<form class="card form" onSubmit=${this.saveSlots}>
              <h2 class="card__title">4. Meal times (${stepState("meals")})</h2>
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

        <section class="card form">
          <h2 class="card__title">5. Provider key (${stepState("key")})</h2>
          ${!this.state.models
            ? html`<p class="placeholder">${this.state.modelsError ?? "Loading the model settings…"}</p>`
            : html`
                <p class="field__hint">
                  One key is enough: the agent uses it to think. Keys are stored on this phone in
                  <code>secrets.json</code> and are never shown again, logged or backed up. The step is
                  done as soon as one key is saved; the check below is optional.
                </p>
                <p class="field__hint">${currentModelText(this.state.models)}</p>
                ${PROVIDERS.map((provider) => {
                  const hasKey = Boolean(this.state.models.providers?.[provider]);
                  const drafts = this.state.keyDrafts ?? {};
                  return html`
                    <div class="field" key=${provider}>
                      <label for=${`setup-key-${provider}`}>${provider}${hasKey ? " (a key is stored)" : ""}</label>
                      <input
                        id=${`setup-key-${provider}`}
                        type="password"
                        autocomplete="off"
                        spellcheck="false"
                        disabled=${!this.owner || this.state.modelsBusy !== null}
                        value=${drafts[provider] ?? ""}
                        onInput=${(event) => this.onKeyInput(provider, event)}
                      />
                      ${this.owner
                        ? html`
                            <div class="form__actions">
                              <button
                                type="button"
                                class="button button--ghost"
                                disabled=${this.state.modelsBusy !== null}
                                onClick=${() => void this.saveKey(provider, drafts[provider] ?? "")}
                              >
                                ${this.state.modelsBusy === `key:${provider}` ? "Saving…" : "Save key"}
                              </button>
                              ${hasKey
                                ? html`<button
                                    type="button"
                                    class="button button--ghost"
                                    disabled=${this.state.modelsBusy !== null}
                                    onClick=${() => void this.saveKey(provider, null)}
                                  >
                                    Clear key
                                  </button>`
                                : null}
                            </div>
                          `
                        : null}
                    </div>
                  `;
                })}
                ${this.owner ? null : html`<p class="field__hint">Only the owner can add provider keys.</p>`}
                <h3 class="notification-subhead">Check the models</h3>
                <p class="field__hint">${probeText(this.state.models.probe)}</p>
                ${this.owner
                  ? html`<div class="form__actions">
                      <button
                        type="button"
                        class="button"
                        disabled=${this.state.modelsBusy !== null}
                        onClick=${() => void this.runProbe()}
                      >
                        ${this.state.modelsBusy === "probe" ? "Checking…" : "Check models now"}
                      </button>
                    </div>`
                  : null}
                ${probeResultLines(this.state.models.probe).length > 0
                  ? html`<ul class="model-list">
                      ${probeResultLines(this.state.models.probe).map((line) => html`<li key=${line.id}>${line.text}</li>`)}
                    </ul>`
                  : null}
                <div class="form__status">
                  ${this.state.modelsError ? html`<p class="notice notice--error" role="alert">${this.state.modelsError}</p>` : null}
                  ${!this.state.modelsError && this.state.modelsMessage
                    ? html`<p class="notice" role="status">${this.state.modelsMessage}</p>`
                    : null}
                </div>
              `}
        </section>

        ${setup.complete
          ? html`<p class="form__actions"><a class="button" href="#today">Go to Today</a></p>`
          : null}
      </section>
    `;
  }
}
