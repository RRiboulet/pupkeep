// Settings — household, notifications, models and budget (PLAN §13.1).
//
// This build owns the household card (through the embedded wizard), the
// notification card (P4-06): this device's Web Push switch, the per-category
// preferences, the ntfy topic for a phone without Web Push, and a test button,
// and the model card (P4-08): the current model, this month's spend against the
// cap, the provider keys, the live allowlist probe and the picker.
//
// The model card reads one route (`GET /api/models`) and the session role: the
// server refuses a partner's writes (§14.1), and the card hides what that role
// cannot do rather than offering a button that always fails. Backup arrives with
// its phase.
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
import {
  allowlistLines,
  budgetBody,
  budgetPercent,
  budgetStateText,
  currentModelText,
  modelChoiceBody,
  modelOptionText,
  parseCapInput,
  probeResultLines,
  probeText,
  providerKeyBody,
  spendText,
} from "../models.js";
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
    /** `GET /api/models`: current model, allowlist, last probe, keys, budget. */
    models: null,
    /** Role from the session read; the model card's writes are owner-only. */
    role: null,
    /** The cap field's draft, as text. */
    capDraft: "",
    /** The key fields' drafts, per provider; never rendered back. */
    keyDrafts: {},
    modelsMessage: null,
    modelsError: null,
    modelsBusy: null,
  };

  componentDidMount() {
    this.request = this.props?.request ?? requestJson;
    this.setState({ supported: pushSupported() });
    void this.load();
    void this.loadModels();
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

  async loadModels() {
    let result;
    try {
      // One read: the route carries the caller's role, so the card needs no
      // separate session request to know which controls to hide.
      result = await this.request("/api/models");
    } catch (error) {
      this.setState({ modelsError: error instanceof NetworkError ? error.message : "Could not load the model settings." });
      return;
    }
    if (!result.ok || !result.body) {
      this.setState({ modelsError: "Could not load the model settings." });
      return;
    }
    const budget = result.body.budget ?? null;
    this.setState({
      models: result.body,
      role: result.body.role ?? null,
      capDraft: budget ? String(budget.capUsd) : "",
      modelsError: null,
    });
  }

  get owner() {
    return this.state.role === "owner";
  }

  onCapInput(event) {
    this.setState({ capDraft: event.target.value, modelsMessage: null });
  }

  async saveCap() {
    const models = this.state.models;
    const capUsd = parseCapInput(this.state.capDraft);
    if (!models || capUsd === undefined || this.state.modelsBusy !== null) {
      this.setState({ modelsError: "A budget is whole dollars and cents, like 10 or 7.50." });
      return;
    }
    this.setState({ modelsBusy: "cap", modelsMessage: null, modelsError: null });
    let result;
    try {
      result = await this.request("/api/budget", {
        method: "PATCH",
        body: budgetBody(models.householdRev ?? 0, capUsd),
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      this.setState({ modelsBusy: null, modelsError: error instanceof NetworkError ? error.message : "Could not save the cap." });
      return;
    }
    if (!result.ok) {
      // A stale household (the timezone or the other caregiver's cap moved) is
      // terminal for this draft: re-read and let the caregiver try again.
      this.setState({ modelsBusy: null, modelsError: result.body?.message ?? "Could not save the cap." });
      void this.loadModels();
      return;
    }
    this.setState({
      modelsBusy: null,
      models: { ...models, budget: result.body.budget },
      capDraft: String(result.body.budget.capUsd),
      modelsMessage: "Monthly cap saved.",
    });
    void this.loadModels();
  }

  onKeyInput(provider, event) {
    this.setState({ keyDrafts: { ...this.state.keyDrafts, [provider]: event.target.value }, modelsMessage: null });
  }

  async saveKey(provider, key) {
    if (this.state.modelsBusy !== null) return;
    this.setState({ modelsBusy: `key:${provider}`, modelsMessage: null, modelsError: null });
    let result;
    try {
      result = await this.request("/api/models/keys", {
        method: "PUT",
        body: providerKeyBody(provider, key ?? ""),
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      this.setState({ modelsBusy: null, modelsError: error instanceof NetworkError ? error.message : "Could not save the key." });
      return;
    }
    if (!result.ok) {
      this.setState({ modelsBusy: null, modelsError: result.body?.error ?? "Could not save the key." });
      return;
    }
    this.setState({
      modelsBusy: null,
      keyDrafts: { ...this.state.keyDrafts, [provider]: "" },
      modelsMessage: key === null || key === "" ? `Key cleared for ${provider}.` : `Key saved for ${provider}.`,
    });
    void this.loadModels();
  }

  async runProbe() {
    if (this.state.modelsBusy !== null) return;
    this.setState({ modelsBusy: "probe", modelsMessage: null, modelsError: null });
    let result;
    try {
      result = await this.request("/api/models/probe", {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      this.setState({ modelsBusy: null, modelsError: error instanceof NetworkError ? error.message : "The check could not run." });
      return;
    }
    if (!result.ok) {
      this.setState({ modelsBusy: null, modelsError: result.body?.error ?? "The check could not run." });
      return;
    }
    this.setState({ modelsBusy: null, modelsMessage: "Model check finished." });
    void this.loadModels();
  }

  async pickModel(id) {
    if (this.state.modelsBusy !== null) return;
    this.setState({ modelsBusy: `pick:${id}`, modelsMessage: null, modelsError: null });
    let result;
    try {
      result = await this.request("/api/models/current", {
        method: "PATCH",
        body: modelChoiceBody(id),
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      this.setState({ modelsBusy: null, modelsError: error instanceof NetworkError ? error.message : "Could not switch the model." });
      return;
    }
    if (!result.ok) {
      this.setState({ modelsBusy: null, modelsError: result.body?.error ?? "Could not switch the model." });
      return;
    }
    this.setState({ modelsBusy: null, modelsMessage: `The agent now uses ${id}.` });
    void this.loadModels();
  }

  renderModels() {
    const models = this.state.models;
    if (!models) {
      return html`<p class="placeholder">${this.state.modelsError ?? "Loading…"}</p>`;
    }
    const budget = models.budget;
    const allowed = new Set((models.allowlist?.allowed ?? []).map((entry) => entry.id));
    const picked = models.current?.id ?? null;
    return html`
      <section class="card" aria-labelledby="model-settings">
        <h2 id="model-settings" class="card__title">Model and budget</h2>
        <p class="field__hint">${currentModelText(models)}</p>

        <h3 class="notification-subhead">This month</h3>
        <p class="field__hint">${spendText(budget)}</p>
        <progress
          class="budget-bar"
          max="100"
          value=${budgetPercent(budget)}
          aria-label="Monthly agent budget used"
        ></progress>
        <p class=${budget?.state === "blocked" ? "notice notice--error" : "field__hint"} role="status">
          ${budgetStateText(budget?.state)}
        </p>
        ${
          this.owner
            ? html`
                <div class="field">
                  <label for="budget-cap">Monthly cap (USD)</label>
                  <input
                    id="budget-cap"
                    type="text"
                    inputmode="decimal"
                    value=${this.state.capDraft}
                    onInput=${(event) => this.onCapInput(event)}
                  />
                </div>
                <div class="form__actions">
                  <button
                    type="button"
                    class="button"
                    disabled=${this.state.modelsBusy !== null}
                    onClick=${() => void this.saveCap()}
                  >
                    ${this.state.modelsBusy === "cap" ? "Saving…" : "Save cap"}
                  </button>
                </div>
              `
            : html`<p class="field__hint">Only the owner can change the cap or the model.</p>`
        }

        <h3 class="notification-subhead">Provider keys</h3>
        <p class="field__hint">
          Keys are stored on this phone in <code>secrets.json</code> and are never shown again, logged or backed up.
          A saved key takes effect on the next request.
        </p>
        ${["opencode-go", "openrouter"].map((provider) => {
          const hasKey = Boolean(models.providers?.[provider]);
          return html`
            <div class="field" key=${provider}>
              <label for=${`key-${provider}`}>${provider}${hasKey ? " (a key is stored)" : ""}</label>
              <input
                id=${`key-${provider}`}
                type="password"
                autocomplete="off"
                spellcheck="false"
                disabled=${!this.owner || this.state.modelsBusy !== null}
                value=${this.state.keyDrafts[provider] ?? ""}
                onInput=${(event) => this.onKeyInput(provider, event)}
              />
              ${
                this.owner
                  ? html`
                      <div class="form__actions">
                        <button
                          type="button"
                          class="button button--ghost"
                          disabled=${this.state.modelsBusy !== null}
                          onClick=${() => void this.saveKey(provider, this.state.keyDrafts[provider] ?? "")}
                        >
                          ${this.state.modelsBusy === `key:${provider}` ? "Saving…" : "Save key"}
                        </button>
                        ${
                          hasKey
                            ? html`<button
                                type="button"
                                class="button button--ghost"
                                disabled=${this.state.modelsBusy !== null}
                                onClick=${() => void this.saveKey(provider, null)}
                              >
                                Clear key
                              </button>`
                            : null
                        }
                      </div>
                    `
                  : null
              }
            </div>
          `;
        })}

        <h3 class="notification-subhead">Check the models</h3>
        <p class="field__hint">${probeText(models.probe)}</p>
        ${
          this.owner
            ? html`
                <div class="form__actions">
                  <button
                    type="button"
                    class="button"
                    disabled=${this.state.modelsBusy !== null}
                    onClick=${() => void this.runProbe()}
                  >
                    ${this.state.modelsBusy === "probe" ? "Checking…" : "Check models now"}
                  </button>
                </div>
              `
            : null
        }
        ${probeResultLines(models.probe).length > 0
          ? html`<ul class="model-list">
              ${probeResultLines(models.probe).map((line) => html`<li key=${line.id}>${line.text}</li>`)}
            </ul>`
          : null}

        <h3 class="notification-subhead">Choose the model</h3>
        <p class="field__hint">
          A model appears here only after the check confirms it can call tools. Switching is the owner's decision.
        </p>
        <ul class="model-list">
          ${(models.candidates ?? []).map((candidate) => {
            const usable = allowed.has(candidate.id);
            const isCurrent = picked === candidate.id;
            // A model whose provider has no key cannot authenticate even when the
            // cache still allows it: say so instead of offering a doomed button.
            const keyed = Boolean(models.providers?.[candidate.provider]);
            return html`
              <li key=${candidate.id}>
                <span>${modelOptionText(candidate)}</span>
                ${
                  this.owner
                    ? html`<button
                        type="button"
                        class="button button--ghost"
                        disabled=${!usable || isCurrent || !keyed || this.state.modelsBusy !== null}
                        onClick=${() => void this.pickModel(candidate.id)}
                      >
                        ${isCurrent ? "In use" : !keyed ? "Add a key first" : usable ? "Use this" : "Not checked"}
                      </button>`
                    : isCurrent
                      ? html`<span class="field__hint">In use</span>`
                      : null
                }
              </li>
            `;
          })}
        </ul>
        ${allowlistLines(models).length > 0
          ? html`<ul class="model-list model-list--notes">
              ${allowlistLines(models).map((line) => html`<li key=${line.text}>${line.text}</li>`)}
            </ul>`
          : null}

        <div class="form__status">
          ${this.state.modelsError ? html`<p class="notice notice--error" role="alert">${this.state.modelsError}</p>` : null}
          ${!this.state.modelsError && this.state.modelsMessage
            ? html`<p class="notice" role="status">${this.state.modelsMessage}</p>`
            : null}
        </div>
      </section>
    `;
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
        ${this.renderModels()}
        <p class="field__hint">Backup is on its way.</p>
        <${Setup} embedded=${true} />
      </section>
    `;
  }
}
