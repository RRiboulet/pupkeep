// Today — the care surface the two caregivers live on. In this shell it is a
// placeholder: feeding and walking arrive in Phase 2. What P1-14 owns here is
// the gate: a household that has not finished first-run setup never lands on
// Today, because an empty puppy and an unchecked timezone would be the first
// thing both caregivers see.
//
// The gate reads the store, not a local fetch: the shell re-renders the tree on
// every `profile` frame, so the wizard disappears (and Today appears) the
// moment the last setup save commits — on both caregivers' screens.

import { h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { getState } from "../store.js";
import { Setup } from "./setup.js";

const html = htm.bind(h);

export function Today() {
  const profile = getState().profile;
  // No profile is "not read yet": show Today rather than flashing the wizard
  // at a household that finished setup long ago.
  if (profile?.setup?.complete === false) {
    return h(Setup, {});
  }
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
