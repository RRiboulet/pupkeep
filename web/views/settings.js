// Settings — household, notifications, providers, backup. Placeholder until
// the settings flows land; Web Push itself is built in a later phase, and push
// notifications are attempted only over HTTPS origins.

import { h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";

const html = htm.bind(h);

export function Settings() {
  return html`
    <section class="view" aria-labelledby="settings-heading">
      <h1 id="settings-heading">Settings</h1>
      <p class="placeholder">
        Settings are on their way — household, notifications, providers and
        backup will live here.
      </p>
    </section>
  `;
}
