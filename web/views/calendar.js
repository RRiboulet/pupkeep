// Calendar — reminders, vet visits and meal schedules. Placeholder until the
// calendar views land with the puppy/reminder phases.

import { h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";

const html = htm.bind(h);

export function Calendar() {
  return html`
    <section class="view" aria-labelledby="calendar-heading">
      <h1 id="calendar-heading">Calendar</h1>
      <p class="placeholder">
        The calendar is on its way — reminders, vet visits and meal times will
        live here.
      </p>
    </section>
  `;
}
