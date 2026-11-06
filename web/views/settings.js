// Settings — household, notifications, providers, backup (PLAN §13.1).
//
// This build owns the household card (through the embedded wizard) and the
// notification card (P4-06): this device's Web Push switch, the per-category
// preferences, the ntfy topic for a phone without Web Push, and a test button.
// Models and backup arrive with their phases.
//
// The partner-delivery copy is deliberately unproven: ntfy is the recommended
// daily path for the iPhone, but whether it actually reaches the partner is
// gated on the device check (P0-10/§2.3), so this screen shows how to set it up
// and makes no delivery claim.
//
// The class, not a hook: the shell serves no import map (PLAN §13.2).

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, newIdempotencyKey, requestJson } from "../client.js";
import { getState } from "../store.js";
import { categoryOptions, ntfyBody, prefsBody } from "../notifications.js";
import { disablePush, enablePush, pushSupported } from "../push.js";
import { Setup } from "./setup.js";

const html = htm.bind(h);

/** The push helper's reason codes, as a caregiver reads them. */
const PUSH_REASONS = {
  push_unsupported: "This page cannot receive Web Push (it needs HTTPS).",
  permission_denied: "The browser did not grant notification permission.",
  signed_out: "Please sign in again.",
  key_unavailable: "The server has no Web Push key yet; try again after a restart.",
  subscribe_failed: "The browser could not subscribe this device.",
  save_failed: "The subscription could not be saved.",
};

export class Settings extends Component {
  state = {
    /** The member's prefs from the server, or null before the read. */
    prefs: null,
    /** The stored ntfy topic, or null. */
    ntfy: null,
    /** The topic field's draft. */
    ntfyDraft: "",
    supported: false,
    pushBusy: false,
    pushMessage: null,
    busy: null,
    message: null,
    error: null,
  };

  componentDidMount() {
    this.request = this.props?.request ?? requestJson;
    this.setState({ supported: pushSupported() });
    void this.load();
  }

  async load() {
    let result;
    try {
      result = await this.request("/api/notifications/prefs");
    } catch (error) {
      this.setState({ error: error instanceof NetworkError ? error.message : "Could not load your notification settings." });
      return;
    }
    if (result.status === 401) {
      this.setState({ error: "Please sign in again." });
      return;
    }
    if (!result.ok || !result.body) {
      this.setState({ error: "Could not load your notification settings." });
      return;
    }
    this.setState({
      prefs: result.body.prefs ?? { enabled: true, categories: [] },
      ntfy: result.body.ntfy ?? null,
      ntfyDraft: result.body.ntfy ?? "",
      error: null,
    });
  }

  toggleCategory(category) {
    const prefs = this.state.prefs;
    if (!prefs) return;
    const categories = prefs.categories.includes(category)
      ? prefs.categories.filter((value) => value !== category)
      : [...prefs.categories, category];
    this.setState({ prefs: { ...prefs, categories }, message: null });
  }

  toggleEnabled() {
    const prefs = this.state.prefs;
    if (!prefs) return;
    this.setState({ prefs: { ...prefs, enabled: !prefs.enabled }, message: null });
  }

  async savePrefs() {
    const prefs = this.state.prefs;
    if (!prefs || this.state.busy !== null) return;
    this.setState({ busy: "prefs", message: null, error: null });
    let result;
    try {
      result = await this.request("/api/notifications/prefs", {
        method: "PATCH",
        body: prefsBody(prefs.enabled, prefs.categories),
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      this.setState({ busy: null, error: error instanceof NetworkError ? error.message : "Could not save your preferences." });
      return;
    }
    if (!result.ok) {
      this.setState({ busy: null, error: "Could not save your preferences." });
      return;
    }
    this.setState({ busy: null, prefs: result.body.prefs, message: "Preferences saved." });
  }

  onNtfyInput(event) {
    this.setState({ ntfyDraft: event.target.value, message: null });
  }

  async saveNtfy(topic) {
    if (this.state.busy !== null) return;
    this.setState({ busy: "ntfy", message: null, error: null });
    let result;
    try {
      result = await this.request("/api/notifications/ntfy", {
        method: "PUT",
        body: ntfyBody(topic),
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      this.setState({ busy: null, error: error instanceof NetworkError ? error.message : "Could not save the topic." });
      return;
    }
    if (!result.ok) {
      this.setState({
        busy: null,
        error: result.body?.error ?? "Could not save the topic; it is 22 or more letters, digits, dashes or underscores.",
      });
      return;
    }
    const saved = result.body.topic ?? null;
    this.setState({
      busy: null,
      ntfy: saved,
      ntfyDraft: saved ?? "",
      message: saved === null ? "ntfy topic cleared." : "ntfy topic saved.",
    });
  }

  async test() {
    if (this.state.busy !== null) return;
    this.setState({ busy: "test", message: null, error: null });
    let result;
    try {
      result = await this.request("/api/notifications/test", {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      this.setState({ busy: null, error: error instanceof NetworkError ? error.message : "Could not queue the test." });
      return;
    }
    if (!result.ok) {
      this.setState({ busy: null, error: "Could not queue the test." });
      return;
    }
    this.setState({ busy: null, message: "Test queued — it is in the centre; a configured phone should show it." });
  }

  async togglePush() {
    if (this.state.pushBusy) return;
    this.setState({ pushBusy: true, pushMessage: null });
    const result = this.props?.push
      ? await this.props.push({ request: this.request })
      : await enablePush({ request: this.request });
    this.setState({
      pushBusy: false,
      pushMessage: result.reason
        ? PUSH_REASONS[result.reason] ?? "Notifications could not be enabled."
        : "This device is subscribed.",
    });
  }

  renderPush() {
    if (!this.state.supported) {
      return html`<p class="field__hint">
        This page cannot receive Web Push. That is expected on plain HTTP (the daily Tailscale path); use the
        in-app centre, the host's local notification, or the ntfy topic below.
      </p>`;
    }
    return html`
      <p class="field__hint">Web Push reaches this device only over HTTPS (the quick tunnel or localhost).</p>
      <div class="form__actions">
        <button type="button" class="button" disabled=${this.state.pushBusy} onClick=${() => void this.togglePush()}>
          ${this.state.pushBusy ? "Working…" : "Enable notifications on this device"}
        </button>
        <button
          type="button"
          class="button button--ghost"
          disabled=${this.state.pushBusy}
          onClick=${async () => {
            this.setState({ pushBusy: true });
            const result = await disablePush({ request: this.request });
            this.setState({ pushBusy: false, pushMessage: result.removed ? "This device is unsubscribed." : "This device was not subscribed." });
          }}
        >
          Turn off on this device
        </button>
      </div>
      ${this.state.pushMessage ? html`<p class="field__hint" role="status">${this.state.pushMessage}</p>` : null}
    `;
  }

  renderPrefs() {
    const prefs = this.state.prefs;
    if (!prefs) return html`<p class="placeholder">Loading…</p>`;
    return html`
      <fieldset class="calendar__reminders notification-prefs">
        <legend>Which notifications</legend>
        <label class="calendar__check">
          <input type="checkbox" checked=${prefs.enabled} onChange=${() => this.toggleEnabled()} />
          Notifications enabled
        </label>
        ${categoryOptions(prefs.categories).map(
          (option) => html`
            <label key=${option.category} class="calendar__check">
              <input
                type="checkbox"
                checked=${option.checked}
                disabled=${!prefs.enabled}
                onChange=${() => this.toggleCategory(option.category)}
              />
              ${option.label}
            </label>
          `,
        )}
      </fieldset>
      <div class="form__actions">
        <button type="button" class="button" disabled=${this.state.busy !== null} onClick=${() => void this.savePrefs()}>
          ${this.state.busy === "prefs" ? "Saving…" : "Save preferences"}
        </button>
      </div>
    `;
  }

  renderNtfy() {
    return html`
      <h3 class="notification-subhead">ntfy (a phone without Web Push)</h3>
      <p class="field__hint">
        Recommended for the partner's iPhone on the daily Tailscale path, where Web Push is unavailable. Install the
        ntfy app, subscribe to this topic, and keep it private — anyone with the topic can read it. Delivery to the
        partner's device is verified separately (P0-10); this screen makes no delivery claim.
      </p>
      <div class="field">
        <label for="ntfy-topic">Topic</label>
        <input
          id="ntfy-topic"
          type="text"
          autocomplete="off"
          spellcheck="false"
          minLength="22"
          value=${this.state.ntfyDraft}
          onInput=${(event) => this.onNtfyInput(event)}
        />
      </div>
      <div class="form__actions">
        <button
          type="button"
          class="button button--ghost"
          disabled=${this.state.busy !== null}
          onClick=${() => void this.saveNtfy(this.state.ntfyDraft)}
        >
          ${this.state.busy === "ntfy" ? "Saving…" : "Save topic"}
        </button>
        ${
          this.state.ntfy
            ? html`<button
                type="button"
                class="button button--ghost"
                disabled=${this.state.busy !== null}
                onClick=${() => void this.saveNtfy("")}
              >
                Clear topic
              </button>`
            : null
        }
      </div>
    `;
  }

  renderNotifications() {
    return html`
      <section class="card" aria-labelledby="notification-settings">
        <h2 id="notification-settings" class="card__title">Notifications</h2>
        <p class="field__hint">
          The <a href="#notifications">notification centre</a> keeps every item, read or not, whether or not a phone
          showed it.
        </p>
        ${this.renderPush()}
        ${this.renderPrefs()}
        ${this.renderNtfy()}
        <h3 class="notification-subhead">Test</h3>
        <p class="field__hint">Queues a test notification for you through whatever path this household has configured.</p>
        <div class="form__actions">
          <button type="button" class="button" disabled=${this.state.busy !== null} onClick=${() => void this.test()}>
            ${this.state.busy === "test" ? "Queueing…" : "Send a test notification"}
          </button>
        </div>
        <div class="form__status">
          ${this.state.error ? html`<p class="notice notice--error" role="alert">${this.state.error}</p>` : null}
          ${!this.state.error && this.state.message
            ? html`<p class="notice" role="status">${this.state.message}</p>`
            : null}
        </div>
      </section>
    `;
  }

  render() {
    const profile = getState().profile;
    const household = profile?.household;
    return html`
      <section class="view" aria-labelledby="settings-heading">
        <h1 id="settings-heading">Settings</h1>
        ${household
          ? html`
              <p class="lead">
                ${household.name}
                <span class="lead__meta">
                  · ${household.timezone} ·
                  ${household.members.map((member) => member.name).join(" and ")}
                </span>
              </p>
            `
          : null}
        ${this.renderNotifications()}
        <p class="field__hint">Models, provider keys and backup are on their way.</p>
        <${Setup} embedded=${true} />
      </section>
    `;
  }
}
