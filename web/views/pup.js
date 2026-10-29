// Pup profile — name, weight, trends, showers. Placeholder until the puppy
// profile task lands its domain service and UI.

import { h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";

const html = htm.bind(h);

export function Pup() {
  return html`
    <section class="view" aria-labelledby="pup-heading">
      <h1 id="pup-heading">Pup</h1>
      <p class="placeholder">
        The puppy profile is on its way — details, weight trend and shower
        schedule will live here.
      </p>
    </section>
  `;
}
