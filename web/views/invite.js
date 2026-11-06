// The one-time partner invite (PLAN §13.1 "Household … invite", §14.1, P4-09).
//
// The route has existed since P1-06 (`POST /api/invites`, owner-only, returns
// `{code, link}`); this is the screen that makes the access guide's day-one step
// real instead of a curl command. Two properties matter and both come from the
// server:
//
//   * **the link is shown once.** Only a hash of the code is stored, so a
//     lost link means minting another; the card never re-reads it;
//   * **it is a credential.** It is displayed for the owner to share over a
//     private channel, is single-use, and expires — never copied into a log, a
//     chat with a third party, or a screenshot the household would not want read.
//
// The link points at the origin the owner is browsing (the route builds it from
// the request), so an invite made on the daily Tailscale origin opens there.
//
// The card takes its `role` and `full` from Settings rather than reading the
// session itself: the settings screen already has one authoritative role read
// (`GET /api/models`), and a second source for the same screen is how two
// answers start disagreeing. The card therefore shares that read's failure mode
// (it renders nothing when the role is unknown), like the other cards there.

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, requestJson } from "../client.js";
import { INVITE_TTL_MINUTES, inviteBody, inviteLinkOf } from "../household.js";

const html = htm.bind(h);

/**
 * Long-press/copy is the only route to the clipboard: `navigator.clipboard`
 * needs a secure context, and the daily origin is plain HTTP on the tailnet. A
 * readonly input is therefore the copy surface, not a "copy" button that would
 * quietly fail there.
 */
export class Invite extends Component {
  state = {
    name: "",
    busy: false,
    /** The minted link, shown once; `null` before the first invite. */
    link: null,
    error: null,
    message: null,
  };

  componentDidMount() {
    this.request = this.props?.request ?? requestJson;
  }

  onName(event) {
    this.setState({ name: event.target.value, message: null, error: null });
  }

  async createInvite() {
    const name = this.state.name.trim();
    if (this.state.busy) return;
    if (name === "") {
      this.setState({ error: "Enter your partner's name first — it labels their activity." });
      return;
    }
    this.setState({ busy: true, error: null, message: null, link: null });
    let result;
    try {
      // No `Idempotency-Key`: the invite route does not dedupe one, and sending a
      // key would advertise a guarantee it does not make. The `busy` flag is what
      // stops a double tap from minting a second code.
      result = await this.request("/api/invites", {
        method: "POST",
        body: inviteBody(name),
      });
    } catch (error) {
      this.setState({ busy: false, error: error instanceof NetworkError ? error.message : "Could not create the invite." });
      return;
    }
    if (!result.ok) {
      this.setState({ busy: false, error: result.body?.error ?? "Could not create the invite." });
      return;
    }
    const link = inviteLinkOf(result.body);
    if (link === null) {
      // The server minted a code but sent no link: both are credentials, and a
      // minted one cannot be shown again, so say so instead of telling the owner
      // to send something that is not on screen.
      this.setState({
        busy: false,
        error: "The invite was created but its link was not returned; create another one.",
      });
      return;
    }
    this.setState({
      busy: false,
      link,
      name: "",
      message:
        `Send this link to ${name} over a private channel. It works once and expires in ${INVITE_TTL_MINUTES} minutes.`,
    });
  }

  render() {
    if (this.props?.role !== "owner") {
      // A partner needs no invite controls; saying so is friendlier than an
      // empty card, and the server refuses the route regardless.
      return null;
    }
    if (this.props?.full === true) {
      // Both household slots are filled; a further invite could only fail with
      // the server's "household is full".
      return html`
        <section class="card" aria-labelledby="invite-settings">
          <h2 id="invite-settings" class="card__title">Your partner has joined</h2>
          <p class="field__hint">
            The household has two caregivers. The daily address is the one the host phone prints; keep each phone's
            sign-in secure.
          </p>
        </section>
      `;
    }
    return html`
      <section class="card" aria-labelledby="invite-settings">
        <h2 id="invite-settings" class="card__title">Invite your partner</h2>
        <p class="field__hint">
          The household has room for two caregivers. The invite is a one-time link: it signs your partner in on the
          origin you are using now, works once, and expires, so share it privately and not in a group.
        </p>
        <div class="field">
          <label for="invite-name">Your partner's name</label>
          <input
            id="invite-name"
            type="text"
            autocomplete="off"
            maxLength="64"
            value=${this.state.name}
            onInput=${(event) => this.onName(event)}
          />
        </div>
        <div class="form__actions">
          <button type="button" class="button" disabled=${this.state.busy} onClick=${() => void this.createInvite()}>
            ${this.state.busy ? "Creating…" : "Create a one-time invite"}
          </button>
        </div>
        ${
          this.state.link
            ? html`
                <div class="field">
                  <label for="invite-link">The link (shown once — long-press to copy)</label>
                  <input id="invite-link" type="text" readonly value=${this.state.link} />
                </div>
              `
            : null
        }
        <div class="form__status">
          ${this.state.error ? html`<p class="notice notice--error" role="alert">${this.state.error}</p>` : null}
          ${!this.state.error && this.state.message ? html`<p class="notice" role="status">${this.state.message}</p>` : null}
        </div>
      </section>
    `;
  }
}
