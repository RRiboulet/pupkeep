// Pup — the puppy profile (PLAN §13.1).
//
// This build owns the profile fields: name, birthday, breed, sex and target
// weight. Growth, milestones and showers arrive with Phase 3 and will join this
// screen; the age and the household roster are already here because Today and
// the agent both need them.
//
// Two rules shape the form:
//   * the save echoes the revision it read. A 409 `stale` is not an error: the
//     other caregiver changed the same profile, their values are shown, and the
//     draft is kept so saving again is a deliberate override rather than a
//     silent one (PLAN §7.4);
//   * the form is a Preact class, not a hook. The shell serves no import map and
//     `web/vendor/preact-hooks.mjs` imports a bare `preact` specifier, so hooks
//     are unavailable here by design (PLAN §13.2).

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, newIdempotencyKey, requestJson } from "../client.js";
import { subscribe } from "../store.js";

const html = htm.bind(h);

const CONFLICT_MESSAGE =
  "Someone else changed this profile. Your edits are kept below; saving again replaces their change.";

function sameHousehold(a, b) {
  return (
    a.today === b.today &&
    a.household.timezone === b.household.timezone &&
    a.household.name === b.household.name &&
    a.household.members.length === b.household.members.length &&
    a.household.members.every((member, index) => {
      const other = b.household.members[index];
      return other !== undefined && other.id === member.id && other.name === member.name;
    })
  );
}

function emptyDraft() {
  return { name: "", birthday: "", breed: "", sex: "", targetWeightKg: "" };
}

function draftOf(profile) {
  const puppy = profile.puppy;
  return {
    name: puppy.name,
    birthday: puppy.birthday ?? "",
    breed: puppy.breed ?? "",
    sex: puppy.sex ?? "",
    targetWeightKg: puppy.targetWeightKg === null ? "" : String(puppy.targetWeightKg),
  };
}

/** The draft as wire values: empty inputs are `null` (a clear). */
function wireOf(draft) {
  return {
    name: draft.name.trim(),
    birthday: draft.birthday === "" ? null : draft.birthday,
    breed: draft.breed.trim() === "" ? null : draft.breed.trim(),
    sex: draft.sex === "" ? null : draft.sex,
    targetWeightKg: draft.targetWeightKg === "" ? null : Number(draft.targetWeightKg),
  };
}

/**
 * Only the fields that really changed. Saving the whole form unchanged would
 * otherwise bump the revision and put "updated the profile" in the household's
 * activity feed for a button press that changed nothing.
 */
function changedFields(puppy, draft) {
  const changed = {};
  for (const [key, value] of Object.entries(wireOf(draft))) {
    if (puppy[key] !== value) changed[key] = value;
  }
  return changed;
}

export class Pup extends Component {
  state = {
    profile: null,
    draft: emptyDraft(),
    dirty: false,
    busy: false,
    error: null,
    message: null,
    conflict: null,
    /**
     * The idempotency key of the save currently on the wire (or last attempted),
     * with the body it belongs to. A retry of the *same* body must reuse the
     * key — that is what turns "the response was lost" into a replay instead of
     * a 409 against the caregiver's own edit. A changed draft changes the body,
     * so it gets a fresh key.
     */
    pending: null,
  };

  componentDidMount() {
    this.unsubscribe = subscribe((state) => this.onStore(state));
    void this.load();
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
        this.setState({ error: "Could not load the profile. Try again in a moment." });
        return;
      }
      this.setState({ profile: result.body, draft: draftOf(result.body), dirty: false, error: null });
    } catch (error) {
      this.setState({ error: error instanceof NetworkError ? error.message : "Could not load the profile." });
    }
  }

  /**
   * A frame from `live.js`. The shell re-renders the tree on every store change,
   * so this only has to keep the draft in step.
   *
   * Two kinds of change arrive on this one frame: a profile edit (the revision
   * moves) and a household change (a partner joined, the timezone changed, the
   * local day rolled over — the revision does not move). Only the first may
   * touch the draft or claim a conflict; the second replaces what is displayed
   * and leaves an in-progress edit alone.
   */
  onStore(state) {
    const incoming = state.profile;
    if (!incoming) return;
    const current = this.state.profile;

    if (current === null) {
      this.setState({ profile: incoming, draft: draftOf(incoming), conflict: null, message: null });
      return;
    }
    // Never go backwards: a frame that was already in flight when a save
    // returned carries an older revision, and the newest revision wins.
    if (incoming.rev < current.rev) return;

    if (incoming.rev > current.rev) {
      if (this.state.dirty) {
        this.setState({ profile: incoming, conflict: CONFLICT_MESSAGE });
        return;
      }
      this.setState({ profile: incoming, draft: draftOf(incoming), conflict: null, message: null });
      return;
    }

    // Same revision: the roster, the timezone or the household-local day moved.
    if (sameHousehold(current, incoming)) return;
    this.setState({ profile: incoming });
  }

  async save(event) {
    event.preventDefault();
    const { draft, profile, busy } = this.state;
    if (busy) return;
    if (profile === null) return;
    if (draft.name.trim() === "") {
      this.setState({ error: "The puppy needs a name before this can be saved." });
      return;
    }

    const patch = changedFields(profile.puppy, draft);
    if (Object.keys(patch).length === 0) {
      this.setState({ dirty: false, error: null, message: "No changes to save." });
      return;
    }

    const body = { rev: profile.rev, ...patch };
    const signature = JSON.stringify(body);
    const pending =
      this.state.pending && this.state.pending.signature === signature
        ? this.state.pending
        : { key: newIdempotencyKey(), signature };

    this.setState({ busy: true, error: null, message: null, pending });
    try {
      const result = await requestJson("/api/puppy", {
        method: "PATCH",
        body,
        idempotencyKey: pending.key,
      });
      if (result.status === 401) {
        this.setState({ busy: false, error: "Please sign in again." });
        return;
      }
      if (result.status === 409 && result.body?.error === "stale") {
        // Keep the draft, adopt the other caregiver's revision and show their
        // values; the next save is then a knowing replacement (and a new body,
        // so a new key).
        this.setState({
          busy: false,
          profile: result.body.profile,
          dirty: true,
          conflict: CONFLICT_MESSAGE,
          pending: null,
        });
        return;
      }
      if (!result.ok) {
        // The key stays pending: another attempt at the same body replays it.
        this.setState({ busy: false, error: result.body?.message ?? "Could not save. Try again." });
        return;
      }
      const saved = result.body.profile;
      this.setState({
        busy: false,
        profile: saved,
        draft: draftOf(saved),
        dirty: false,
        conflict: null,
        pending: null,
        message: result.body.replayed ? "Already saved." : "Saved.",
      });
    } catch (error) {
      // A transport failure may still have committed; keeping `pending` is what
      // makes the retry a replay (the key is cleared on success).
      this.setState({
        busy: false,
        error: error instanceof NetworkError ? error.message : "Could not save. Try again.",
      });
    }
  }

  onInput = (event) => {
    const { name, value } = event.target;
    this.setState({ draft: { ...this.state.draft, [name]: value }, dirty: true, message: null });
  };

  render() {
    const { profile, draft, busy, error, message, conflict } = this.state;

    if (profile === null) {
      return html`
        <section class="view" aria-labelledby="pup-heading">
          <h1 id="pup-heading">Pup</h1>
          ${error
            ? html`<p class="notice notice--error" role="alert">${error}</p>`
            : html`<p class="placeholder">Loading the puppy profile…</p>`}
        </section>
      `;
    }

    const age = profile.age ? profile.age.label : "no birthday yet";
    const caregivers = profile.household.members.map((member) => member.name).join(" and ");

    return html`
      <section class="view" aria-labelledby="pup-heading">
        <h1 id="pup-heading">${profile.puppy.name || "Your pup"}</h1>
        <p class="lead">
          <span>${age}</span>
          ${caregivers ? html`<span class="lead__meta"> · ${caregivers}</span>` : null}
        </p>

        <form class="card form" onSubmit=${(event) => this.save(event)}>
          <h2 class="card__title">Profile</h2>

          <div class="field">
            <label for="pup-name">Name</label>
            <input
              id="pup-name"
              name="name"
              type="text"
              maxlength="60"
              required
              autocomplete="off"
              value=${draft.name}
              onInput=${this.onInput}
              disabled=${busy}
            />
          </div>

          <div class="field">
            <label for="pup-birthday">Birthday</label>
            <input
              id="pup-birthday"
              name="birthday"
              type="date"
              value=${draft.birthday}
              onInput=${this.onInput}
              disabled=${busy}
            />
            <p class="field__hint">The household date (${profile.household.timezone}); age is worked out from it.</p>
          </div>

          <div class="field">
            <label for="pup-breed">Breed</label>
            <input
              id="pup-breed"
              name="breed"
              type="text"
              maxlength="60"
              autocomplete="off"
              value=${draft.breed}
              onInput=${this.onInput}
              disabled=${busy}
            />
          </div>

          <div class="field">
            <label for="pup-sex">Sex</label>
            <select id="pup-sex" name="sex" value=${draft.sex} onChange=${this.onInput} disabled=${busy}>
              <option value="">Not set</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </div>

          <div class="field">
            <label for="pup-weight">Target weight (kg)</label>
            <input
              id="pup-weight"
              name="targetWeightKg"
              type="number"
              min="0.1"
              max="200"
              step="0.01"
              inputmode="decimal"
              value=${draft.targetWeightKg}
              onInput=${this.onInput}
              disabled=${busy}
            />
          </div>

          ${conflict ? html`<p class="notice notice--warn" role="status">${conflict}</p>` : null}
          ${error ? html`<p class="notice notice--error" role="alert">${error}</p>` : null}

          <div class="form__actions">
            <button class="button" type="submit" disabled=${busy}>
              ${busy ? "Saving…" : "Save profile"}
            </button>
            <span class="form__status" role="status" aria-live="polite">${message ?? ""}</span>
          </div>
        </form>
      </section>
    `;
  }
}
