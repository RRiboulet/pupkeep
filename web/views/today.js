// Today — the care surface the two caregivers live on. In this shell it is a
// placeholder: P1-09 lands the shared thread and live state, feeding/walking
// arrive in Phase 2. Keeping the view behind its own module so P1-09 swaps the
// body without touching the shell.

import { h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";

const html = htm.bind(h);

export function Today() {
  return html`
    <section class="view" aria-labelledby="today-heading">
      <h1 id="today-heading">Today</h1>
      <p class="placeholder">
        Today is a placeholder in this shell. Your pup's day — meals, walks and
        the shared thread — arrives with the server integration.
      </p>
      <ul class="placeholder-list" aria-label="Planned Today surface">
        <li>Meal times and a one-tap fed button</li>
        <li>Walks with an open-walk timer</li>
        <li>The agent feed, live between both caregivers</li>
      </ul>
    </section>
  `;
}
