// Agent — the shared household thread. Placeholder until the shared
// conversation task lands its messages, composer and live updates.

import { h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";

const html = htm.bind(h);

export function Agent() {
  return html`
    <section class="view" aria-labelledby="agent-heading">
      <h1 id="agent-heading">Agent</h1>
      <p class="placeholder">
        The shared thread is on its way — messages to and from your household
        assistant will live here.
      </p>
    </section>
  `;
}
