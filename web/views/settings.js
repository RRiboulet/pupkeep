// Settings — household, notifications, providers, backup (PLAN §13.1).
//
// Only the household card is real in this build; notifications, models and
// backup arrive with their phases (P4), and Web Push stays HTTPS-only when it
// does. What P1-14 adds here is the way back to first-run setup: §13.1 lists
// the wizard under Settings, and the household timezone and meal times live
// nowhere else until Phase 2's Today card and Phase 4's settings flows land.

import { h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { getState } from "../store.js";
import { Setup } from "./setup.js";

const html = htm.bind(h);

export function Settings() {
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
      <p class="placeholder">
        Notifications, models and backup are on their way. The household timezone
        and the meal times are below.
      </p>
      <${Setup} embedded=${true} />
    </section>
  `;
}
