// Your name — the Settings card where a caregiver renames themselves.
//
// Self-service by design: the route carries no member id, so the write is
// always the signed-in member's own row and nobody renames their partner
// here. The card reads `GET /api/session` (whose label comes from the
// household profiles, not auth) for who is signed in, drafts the new name,
// and sends one rev-guarded, idempotency-keyed `PATCH /api/me` — the same
// §7.4 write shape as the timezone and the budget.
//
// The server answers with the whole care view, and the existing `profile`
// frame on the one live stream carries the rename to the other caregiver's
// client without a reload; this card shows feedback only. The household
// document stays the display authority, so a server restart keeps the chosen
// name and boot reconciliation reports config drift instead of overwriting.

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, newIdempotencyKey, requestJson } from "../client.js";
import { getState } from "../store.js";

const html = htm.bind(h);

export class MyName extends Component {
  state = {
    /** `{memberId, role, label, authorId}` from `GET /api/session`, or null. */
    me: null,
    /** The name field's draft. */
    draft: "",
    busy: false,
    message: null,
    error: null,
  };

  componentDidMount() {
    this.request = this.props?.request ?? requestJson;
    void this.load();
  }

  async load() {
    let result;
    try {
      result = await this.request("/api/session");
    } catch (error) {
      this.setState({ error: error instanceof NetworkError ? error.message : "Could not load your name." });
      return;
    }
    if (!result.ok || !result.body?.memberId) {
      this.setState({ error: "Could not load your name; try signing in again." });
      return;
    }
    this.setState({ me: result.body, draft: result.body.label ?? "", error: null });
  }

  onInput(event) {
    this.setState({ draft: event.target.value, message: null });
  }

  async save() {
    if (this.state.busy) return;
    const me = this.state.me;
    const rev = getState().profile?.household?.rev;
    if (me === null || typeof rev !== "number") {
      this.setState({ error: "Still loading; try again in a moment." });
      return;
    }
    const name = this.state.draft.trim();
    if (name === "") {
      this.setState({ error: "Your name cannot be empty." });
      return;
    }
    this.setState({ busy: true, message: null, error: null });
    let result;
    try {
      result = await this.request("/api/me", {
        method: "PATCH",
        body: { rev, name },
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      this.setState({ busy: false, error: error instanceof NetworkError ? error.message : "Could not save your name." });
      return;
    }
    if (!result.ok) {
      // A stale revision or a duplicate of the other caregiver's name is a 409
      // whose message is written to be shown: re-read and try again, the
      // server's wording carries the cause.
      this.setState({ busy: false, error: result.body?.error ?? "Could not save your name." });
      return;
    }
    const members = result.body?.profile?.household?.members ?? [];
    const saved = members.find((member) => member.id === me.memberId)?.name ?? name;
    this.setState({ busy: false, draft: saved, message: `Saved — your name is now ${saved}.` });
  }

  render() {
    if (this.state.me === null) {
      return html`
        <section class="card" aria-labelledby="my-name-settings">
          <h2 id="my-name-settings" class="card__title">Your name</h2>
          <p class="field__hint">${this.state.error ?? "Loading…"}</p>
        </section>
      `;
    }
    return html`
      <section class="card" aria-labelledby="my-name-settings">
        <h2 id="my-name-settings" class="card__title">Your name</h2>
        <p class="field__hint">
          This is the name the other caregiver and the activity feed see. You can change only your own.
        </p>
        <div class="field">
          <label for="my-name">Your display name</label>
          <input
            id="my-name"
            type="text"
            autocomplete="off"
            maxLength="64"
            value=${this.state.draft}
            onInput=${(event) => this.onInput(event)}
          />
        </div>
        <div class="form__actions">
          <button type="button" class="button" disabled=${this.state.busy} onClick=${() => void this.save()}>
            ${this.state.busy ? "Saving…" : "Save name"}
          </button>
        </div>
        <div class="form__status">
          ${this.state.error ? html`<p class="notice notice--error" role="alert">${this.state.error}</p>` : null}
          ${!this.state.error && this.state.message ? html`<p class="notice" role="status">${this.state.message}</p>` : null}
        </div>
      </section>
    `;
  }
}
