// Settings → Household: the household's name and timezone (ticket 03, the
// Settings half of the first-run setup spec's R7).
//
// Why it exists: the two human-checked facts lived only in the first-run
// wizard, so a household that wanted to rename itself (or move) had to reopen
// a first-launch checklist. This card is the post-completion home for them,
// editable at any time by either caregiver — nothing here is owner-only.
//
// Rules it follows, the same as the wizard's and the meal-times card's:
//   * one save is **one** care commit through `PATCH /api/household`, carrying
//     the household revision it read plus an idempotency key held with the
//     body it belongs to (`pendingSave`), so a retry of the same edit replays
//     instead of conflicting with itself;
//   * confirming an unchanged name or timezone is still a real action — the
//     server stamps the confirmation, and the button says "Confirm" rather
//     than "Save" when nothing changed;
//   * a 409 `stale` is not an error: the other caregiver's change is shown in
//     *that section only*, the draft is kept, and saving again is a deliberate
//     replacement;
//   * a successful save hands the returned profile to the shared store, so the
//     shell and the other views move now rather than on the next frame.
//
// The timezone helpers (the common-zones datalist, the device zone, the "it is
// … right now" preview) are copied from `views/setup.js` on purpose: the wizard
// is scheduled for removal, and this card must not keep it alive. They are the
// same small, pure logic; when the wizard goes, this file is what remains.
//
// The class, not a hook: the shell serves no import map (PLAN §13.2).

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, requestJson } from "../client.js";
import { CONFLICT_MESSAGE, isNewer, pendingSave } from "../profile-form.js";
import { getState, setState, subscribe } from "../store.js";

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

export class HouseholdSection extends Component {
  state = {
    profile: null,
    /** Set only when the household read itself fails, before any section. */
    error: null,
    /** The name field's draft. */
    name: "",
    nameDirty: false,
    /** The timezone field's draft. */
    zone: "",
    zoneDirty: false,
    /** The save on the wire, if any: `"name"` or `"timezone"`. */
    busy: null,
    nameError: null,
    nameMessage: null,
    nameConflict: null,
    timezoneError: null,
    timezoneMessage: null,
    timezoneConflict: null,
    /** Per section: the key of the save on the wire with the body it belongs to. */
    pending: {},
  };

  componentDidMount() {
    this.request = this.props?.request ?? requestJson;
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
      const result = await this.request("/api/puppy");
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
      this.setState({
        error: error instanceof NetworkError ? error.message : "Could not load the household.",
      });
    }
  }

  /** Take a whole view as the truth; untouched sections follow it, dirty ones do not. */
  adopt(profile, extra = {}) {
    // Never let a response that was read before a frame already on screen move
    // the card backwards.
    const current = this.state.profile;
    const next = current !== null && !isNewer(profile, current) ? current : profile;
    this.setState({
      profile: next,
      ...(this.state.nameDirty ? {} : { name: next.household.name }),
      ...(this.state.zoneDirty ? {} : { zone: next.household.timezone }),
      ...extra,
    });
  }

  /**
   * A frame from `live.js`: the other caregiver saved the name or the zone. A
   * section the caregiver is editing keeps its draft and says so — but only
   * when none of this card's own household writes is outstanding: a frame
   * that arrives while one is — on the wire (`busy`), or committed with its
   * response still lost (`pending`) — is almost always that write's own echo,
   * and warning a dirty sibling section about "someone else" would be wrong,
   * and would then persist, because the save settles only its own section's
   * conflict. A real concurrent edit still answers 409 `stale`, whose handler
   * blames every dirty section the other caregiver's write displaced.
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
    const next = { profile: incoming };
    if (incoming.household.rev !== current.household.rev) {
      // A revision bump while one of this card's own household writes is
      // outstanding is almost always that write's own echo: `send` hands the
      // same profile to the store while the write is still busy, and the
      // stream repeats the frame afterwards. Blaming a dirty section for it
      // has the caregiver racing themselves. The frame that *is* a conflict —
      // the other caregiver's write, with no write of ours outstanding —
      // still blames a dirty section below, and a frame that really did
      // displace one of our writes ends in a 409, whose handler blames the
      // dirty sections it displaced.
      const ownWriteOutstanding =
        this.state.busy !== null ||
        this.state.pending.name !== undefined ||
        this.state.pending.timezone !== undefined;
      if (!this.state.nameDirty) next.name = incoming.household.name;
      else if (!ownWriteOutstanding) next.nameConflict = CONFLICT_MESSAGE;
      if (!this.state.zoneDirty) next.zone = incoming.household.timezone;
      else if (!ownWriteOutstanding) next.timezoneConflict = CONFLICT_MESSAGE;
    }
    this.setState(next);
  }

  /**
   * One care write, with the replay/stale handling both sections share. The
   * failure and the conflict land in `section`'s own fields, so a name
   * refusal never reads as if the timezone were the problem.
   */
  async send(section, body, pending) {
    try {
      const result = await this.request("/api/household", {
        method: "PATCH",
        body,
        idempotencyKey: pending.key,
      });
      if (result.status === 401) {
        this.setState({ busy: null, [`${section}Error`]: "Please sign in again." });
        return;
      }
      if (result.status === 409 && result.body?.error === "stale") {
        // Keep the draft and show the current state; the next save is a knowing
        // replacement, and a new body gets a new key. The stale answer proves
        // the displaced revision was another household write, so a dirty
        // sibling section with no save of its own is blamed here too: the live
        // frame for that write may have arrived while this save was on the
        // wire, where `onStore` rightly holds its tongue.
        const { [section]: _dropped, ...rest } = this.state.pending;
        const sibling = section === "name" ? "timezone" : "name";
        const siblingDirty = section === "name" ? this.state.zoneDirty : this.state.nameDirty;
        this.adopt(result.body.profile, {
          busy: null,
          [`${section}Conflict`]: CONFLICT_MESSAGE,
          ...(siblingDirty && rest[sibling] === undefined
            ? { [`${sibling}Conflict`]: CONFLICT_MESSAGE }
            : {}),
          pending: rest,
        });
        return;
      }
      if (!result.ok) {
        // The key stays pending: another attempt at the same body replays it.
        // A hand-built refusal carries its sentence in `message`; a thrown one
        // carries it in `error`. Prefer the sentence.
        this.setState({
          busy: null,
          [`${section}Error`]: result.body?.message ?? result.body?.error ?? "Could not save. Try again.",
        });
        return;
      }
      // Tell the shell too, so the other views update immediately rather than
      // on the next `profile` frame — unless the stream already delivered
      // something newer.
      if (isNewer(result.body.profile, getState().profile)) setState({ profile: result.body.profile });
      const { [section]: _used, ...rest } = this.state.pending;
      // The save is settled: the section's draft is no longer dirty, and the
      // inputs take the server's normalisation (trimmed name, the zone as
      // stored) — without this every later frame for the household would raise
      // a false conflict.
      this.adopt(result.body.profile, {
        busy: null,
        [`${section}Conflict`]: null,
        [`${section}Error`]: null,
        [`${section}Message`]: result.body.replayed ? "Already saved." : "Saved.",
        pending: rest,
        ...(section === "name"
          ? { nameDirty: false, name: result.body.profile.household.name }
          : { zoneDirty: false, zone: result.body.profile.household.timezone }),
      });
    } catch (error) {
      // A transport failure may still have committed; keeping the key makes the
      // retry a replay instead of a second revision.
      this.setState({
        busy: null,
        [`${section}Error`]: error instanceof NetworkError ? error.message : "Could not save. Try again.",
      });
    }
  }

  saveName = (event) => {
    event.preventDefault();
    const { profile, name } = this.state;
    if (!profile || this.state.busy) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      this.setState({ nameError: "The household needs a name." });
      return;
    }
    const body = { rev: profile.household.rev, name: trimmed };
    const pending = pendingSave(this.state.pending.name, body);
    this.setState({
      busy: "name",
      nameError: null,
      nameMessage: null,
      pending: { ...this.state.pending, name: pending },
    });
    return this.send("name", body, pending);
  };

  saveZone = (event) => {
    event.preventDefault();
    const { profile, zone } = this.state;
    if (!profile || this.state.busy) return;
    const timezone = zone.trim();
    if (timezone === "") {
      this.setState({ timezoneError: "Pick the household's timezone first." });
      return;
    }
    const body = { rev: profile.household.rev, timezone };
    const pending = pendingSave(this.state.pending.timezone, body);
    this.setState({
      busy: "timezone",
      timezoneError: null,
      timezoneMessage: null,
      pending: { ...this.state.pending, timezone: pending },
    });
    return this.send("timezone", body, pending);
  };

  onNameInput = (event) => {
    this.setState({ name: event.target.value, nameDirty: true, nameMessage: null });
  };

  onZoneInput = (event) => {
    this.setState({ zone: event.target.value, zoneDirty: true, timezoneMessage: null });
  };

  useDeviceZone = () => {
    const zone = deviceZone();
    if (zone !== "") this.setState({ zone, zoneDirty: true, timezoneMessage: null });
  };

  render() {
    const { profile, name, zone, busy } = this.state;
    if (profile === null) {
      return html`
        <section class="card" aria-labelledby="household-settings">
          <h2 id="household-settings" class="card__title">Household</h2>
          ${this.state.error
            ? html`<p class="notice notice--error" role="alert">${this.state.error}</p>`
            : html`<p class="placeholder">Loading the household…</p>`}
        </section>
      `;
    }
    const preview = zonePreview(zone.trim());
    const zoneChanged = zone.trim() !== profile.household.timezone;
    const nameChanged = name.trim() !== profile.household.name;
    return html`
      <section class="card" aria-labelledby="household-settings">
        <h2 id="household-settings" class="card__title">Household</h2>
        <p class="field__hint">
          Either caregiver can change these at any time. Saving an unchanged value confirms it.
        </p>

        <form class="form" onSubmit=${this.saveName}>
          <div class="field">
            <label for="household-name">Household name</label>
            <input
              id="household-name"
              type="text"
              maxlength="60"
              autocomplete="off"
              value=${name}
              onInput=${this.onNameInput}
              disabled=${busy !== null}
            />
          </div>
          <div class="form__actions">
            <button type="submit" class="button" disabled=${busy !== null}>
              ${busy === "name" ? "Saving…" : nameChanged ? "Save name" : "Confirm name"}
            </button>
          </div>
          <div class="form__status">
            ${this.state.nameConflict
              ? html`<p class="notice notice--warn" role="status">${this.state.nameConflict}</p>`
              : null}
            ${this.state.nameError
              ? html`<p class="notice notice--error" role="alert">${this.state.nameError}</p>`
              : null}
            ${!this.state.nameError && this.state.nameMessage
              ? html`<p class="notice" role="status">${this.state.nameMessage}</p>`
              : null}
          </div>
        </form>

        <form class="form" onSubmit=${this.saveZone}>
          <div class="field">
            <label for="household-zone">Timezone</label>
            <input
              id="household-zone"
              type="text"
              list="household-zones"
              autocomplete="off"
              spellcheck="false"
              value=${zone}
              onInput=${this.onZoneInput}
              disabled=${busy !== null}
            />
            <datalist id="household-zones">
              ${COMMON_ZONES.map((zoneName) => html`<option key=${zoneName} value=${zoneName}></option>`)}
            </datalist>
            <p class="field__hint">
              Every date in Pupkeep — meals, walks, growth — is worked out in this zone.
              ${preview === null
                ? "Use an IANA name such as Europe/Paris."
                : `In ${zone.trim() || "this zone"} it is ${preview} right now.`}
            </p>
          </div>
          <div class="form__actions">
            <button type="submit" class="button" disabled=${busy !== null}>
              ${busy === "timezone" ? "Saving…" : zoneChanged ? "Save timezone" : "Confirm timezone"}
            </button>
            <button type="button" class="button button--ghost" onClick=${this.useDeviceZone} disabled=${busy !== null}>
              Use this device's zone
            </button>
          </div>
          <div class="form__status">
            ${this.state.timezoneConflict
              ? html`<p class="notice notice--warn" role="status">${this.state.timezoneConflict}</p>`
              : null}
            ${this.state.timezoneError
              ? html`<p class="notice notice--error" role="alert">${this.state.timezoneError}</p>`
              : null}
            ${!this.state.timezoneError && this.state.timezoneMessage
              ? html`<p class="notice" role="status">${this.state.timezoneMessage}</p>`
              : null}
          </div>
        </form>
      </section>
    `;
  }
}
