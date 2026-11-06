// The notification centre (PLAN §12.3, §13.1, §16 P4-06).
//
// The in-app centre is the source of truth: every intent a care action or a
// reminder commits is here for its member, read or unread, whether or not a push
// or ntfy reached the phone. "Mark read" is the caregiver's own state, never a
// delivery acknowledgement.
//
// The list re-reads on the care signal (the profile frame is a signal, not
// data), and every read publishes the unread count to the store so the nav badge
// stays honest without a second request. The class, not a hook: the shell serves
// no import map (PLAN §13.2).

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, newIdempotencyKey, requestJson } from "../client.js";
import { getState, setState, subscribe } from "../store.js";
import { badgeText, intentWhenText, unreadOf } from "../notifications.js";

const html = htm.bind(h);

const SIGNED_OUT = "Please sign in again.";
const LOAD_FAILED = "Could not load the notifications. Try again in a moment.";

export class Notifications extends Component {
  state = {
    items: [],
    unread: 0,
    loading: true,
    error: null,
    busy: null,
    seenCare: -1,
  };

  componentDidMount() {
    this.request = this.props?.request ?? requestJson;
    this.unsubscribe = subscribe((state) => this.onStore(state));
    this.setState({ seenCare: getState().careSeq ?? 0 });
    void this.load();
  }

  componentWillUnmount() {
    this.unsubscribe?.();
  }

  onStore(state) {
    const seq = state?.careSeq ?? 0;
    if (seq === this.state.seenCare || seq === 0) return;
    this.setState({ seenCare: seq });
    void this.load();
  }

  async load() {
    const seq = (this.loadSeq = (this.loadSeq ?? 0) + 1);
    let result;
    try {
      result = await this.request("/api/notifications");
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.setState({ loading: false, error: error instanceof NetworkError ? error.message : LOAD_FAILED });
      return;
    }
    if (seq !== this.loadSeq) return;
    if (result.status === 401) {
      this.setState({ loading: false, error: SIGNED_OUT });
      return;
    }
    if (!result.ok || !result.body) {
      this.setState({ loading: false, error: LOAD_FAILED });
      return;
    }
    this.setState({
      items: result.body.items ?? [],
      unread: result.body.unread ?? unreadOf(result.body.items),
      loading: false,
      error: null,
    });
    setState({ unreadNotifications: result.body.unread ?? 0 });
  }

  /** Mark one item (or all) read; the server answers the new unread count. */
  async markRead(id, all = false) {
    if (this.state.busy !== null) return;
    this.setState({ busy: all ? "all" : id, error: null });
    let result;
    try {
      result = await this.request("/api/notifications/read", {
        method: "POST",
        body: all ? { all: true } : { id },
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      this.setState({ busy: null, error: error instanceof NetworkError ? error.message : "Could not mark it read." });
      return;
    }
    if (result.status === 401) {
      this.setState({ busy: null, error: SIGNED_OUT });
      return;
    }
    if (!result.ok) {
      this.setState({ busy: null, error: "Could not mark it read." });
      return;
    }
    // Read state is the member's own; refresh locally rather than trusting the
    // count to describe which rows changed.
    this.setState({ busy: null });
    setState({ unreadNotifications: result.body?.unread ?? 0 });
    void this.load();
  }

  renderItem(item) {
    const when = intentWhenText(item.createdAt, getState().profile?.household?.timezone);
    const unread = item.readAt === null;
    return html`
      <li key=${item.id} class=${`notification${unread ? " notification--unread" : ""}`}>
        <div class="notification__head">
          <span class="notification__title">${item.title}</span>
          ${unread ? html`<span class="notification__dot" aria-label="Unread"></span>` : null}
        </div>
        <p class="notification__body">${item.body}</p>
        <p class="field__hint">
          ${when}
          ${unread
            ? html` · <button
                type="button"
                class="link-button"
                disabled=${this.state.busy !== null}
                onClick=${() => void this.markRead(item.id)}
              >
                Mark read
              </button>`
            : ""}
        </p>
      </li>
    `;
  }

  render() {
    return html`
      <section class="view" aria-labelledby="notifications-heading">
        <h1 id="notifications-heading">
          Notifications
          ${this.state.unread > 0
            ? html`<span class="badge" aria-label=${`${this.state.unread} unread`}>${badgeText(this.state.unread)}</span>`
            : null}
        </h1>
        <p class="field__hint">
          Everything the household's actions and reminders recorded, whether or not a phone showed it.
        </p>
        <div class="form__status">
          ${this.state.error ? html`<p class="notice notice--error" role="alert">${this.state.error}</p>` : null}
        </div>
        <div class="form__actions">
          <button
            type="button"
            class="button button--ghost"
            disabled=${this.state.busy !== null || this.state.unread === 0}
            onClick=${() => void this.markRead(null, true)}
          >
            ${this.state.busy === "all" ? "Marking…" : "Mark all read"}
          </button>
        </div>
        ${
          this.state.loading && this.state.items.length === 0
            ? html`<p class="placeholder">Loading…</p>`
            : this.state.items.length === 0
              ? html`<p class="placeholder">Nothing yet. Feeds, reminders and appointments will show up here.</p>`
              : html`<ul class="notification-list">${this.state.items.map((item) => this.renderItem(item))}</ul>`
        }
      </section>
    `;
  }
}
