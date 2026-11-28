// The shell entry: bottom navigation Today/Calendar/Pup/Agent/Settings, an
// online/offline status region, the live care-state stream, and the service
// worker registration.
//
// There is no build step: Preact and htm come from ./vendor (pinned in
// NOTICE.md), and every import here is relative.
//
// Security notes (PLAN §14.2):
//  - no inline scripts or styles anywhere — the CSP is `default-src 'self'`.
//  - the service worker is registered only in a secure context
//    (window.isSecureContext: HTTPS or localhost). Over plain HTTP — the
//    partner's daily Tailscale origin — the shell loads as an ordinary web app
//    and never claims PWA install, service workers or Web Push.

import { h, render } from "./vendor/preact.mjs";
import htm from "./vendor/htm.mjs";
import { gatedRoute, getState, hashRoute, reconcileHash, setState, subscribe } from "./store.js";
import { startLive } from "./live.js";
import { Setup } from "./views/setup.js";
import { Today } from "./views/today.js";
import { Calendar } from "./views/calendar.js";
import { Pup } from "./views/pup.js";
import { Agent } from "./views/agent.js";
import { Settings } from "./views/settings.js";
import { Notifications } from "./views/notifications.js";
import { badgeText } from "./notifications.js";

const html = htm.bind(h);

const VIEWS = new Map([
  ["today", Today],
  ["calendar", Calendar],
  ["pup", Pup],
  ["agent", Agent],
  ["notifications", Notifications],
  ["settings", Settings],
]);

// `label` is the screen's own title; `short` is what the narrow tab shows.
// Six tabs in a 320 px viewport leave about 52 px of text each, which
// "Notifications" cannot use: it needs 115 px, so the sixth tab was pushed off
// the screen entirely (P5-10). The shorthand is display-only — the accessible
// name keeps the full word (see `navLabel`).
const NAV_ITEMS = [
  { id: "today", label: "Today" },
  { id: "calendar", label: "Calendar" },
  { id: "pup", label: "Pup" },
  { id: "agent", label: "Agent" },
  { id: "notifications", label: "Notifications", short: "Alerts" },
  { id: "settings", label: "Settings" },
];

/**
 * The tab's accessible name. WCAG 2.5.3 (Label in Name) wants the visible text
 * inside the name, so the shorthand leads and the full word follows it: a
 * speech-input user can say "Alerts", and someone listening hears that this is
 * the notification centre.
 */
function navLabel(item, unread, badge) {
  const name = item.short === undefined ? item.label : `${item.short}, ${item.label.toLowerCase()}`;
  return item.id === "notifications" && badge !== "" ? `${name}, ${unread} unread` : name;
}

function Nav({ route }) {
  const unread = Number(getState().unreadNotifications ?? 0);
  const badge = badgeText(unread);
  return html`
    <nav class="bottom-nav" aria-label="Primary">
      ${NAV_ITEMS.map(
        (item) => html`
          <a
            key=${item.id}
            href="#${item.id}"
            class=${`bottom-nav__item${route === item.id ? " is-current" : ""}`}
            aria-current=${route === item.id ? "page" : "false"}
            aria-label=${navLabel(item, unread, badge)}
          >
            <span class="bottom-nav__label">${item.short ?? item.label}</span>${item.id === "notifications" && badge !== ""
              ? html`<span class="badge badge--nav">${badge}</span>`
              : null}
          </a>
        `,
      )}
    </nav>
  `;
}

function Status({ online }) {
  if (online) return null;
  return html`
    <div class="status-banner" role="status" aria-live="polite">
      You are offline — Pupkeep works online only. Waiting to reconnect…
    </div>
  `;
}

/**
 * The neutral first paint, before the first profile read (R1). No navigation
 * and no view: an unconfigured household must not see Today flash, and a
 * configured one must not see the nav flash. If the read answers 401 the
 * screen says so instead of spinning forever — before the gate every view
 * fetched its own 401 and had a screen to put the sentence in.
 */
function Loading({ online }) {
  const signedOut = getState().signedOut === true;
  return html`
    <${Status} online=${online} />
    <main class="content" aria-label="loading">
      <section class="view" aria-labelledby="boot-heading">
        <h1 id="boot-heading">Pupkeep</h1>
        ${signedOut
          ? html`<p class="notice notice--error" role="alert">
              Please sign in again. <a href="/login">Open your sign-in link</a>.
            </p>`
          : html`<p class="placeholder">Loading the household…</p>`}
      </section>
    </main>
  `;
}

function App({ route, online }) {
  const gated = gatedRoute(route, getState().profile);
  if (gated.screen === "loading") return html`<${Loading} online=${online} />`;
  // The whole app is the setup page: no navigation, and no other view, however
  // the URL or the history said (R1). `reconcileHash` has already aimed the
  // address here.
  if (gated.screen === "setup") {
    return html`
      <${Status} online=${online} />
      <main class="content" aria-label="setup">
        <${Setup} />
      </main>
    `;
  }
  const View = VIEWS.get(gated.screen) ?? Today;
  return html`
    <${Status} online=${online} />
    <main class="content" aria-label=${gated.screen}>
      <${View} />
    </main>
    <${Nav} route=${gated.screen} />
  `;
}

const root = document.getElementById("app");
if (root) {
  let pending = false;
  // The newest state, updated on every request. The queued frame reads this
  // object instead of closing over one `(route, online)` pair: two state
  // changes in the same frame (a hashchange and an offline event) must both
  // land, with the last one winning, not the first one freezing the view.
  const latest = { route: hashRoute(), online: navigator.onLine };

  const draw = () => {
    pending = false;
    // The gate's reconcile runs with the paint, so a deep link into a gated
    // app lands on the address the gate wants — and on the route state the
    // gate forces — before anything else reads either.
    reconcileHash(latest.route, getState().profile);
    render(html`<${App} route=${latest.route} online=${latest.online} />`, root);
  };
  const schedule = (route, online) => {
    latest.route = route;
    latest.online = online;
    if (pending) return;
    pending = true;
    requestAnimationFrame(draw);
  };

  schedule(latest.route, latest.online);
  subscribe((next) => schedule(next.route, next.online));

  window.addEventListener("hashchange", () => {
    setState({ route: hashRoute() });
  });
  const onlineChanged = () => setState({ online: navigator.onLine });
  window.addEventListener("online", onlineChanged);
  window.addEventListener("offline", onlineChanged);
}

// The service worker registration guard. Returns a string so the eventual
// Settings surface can explain why no worker is active; it never throws.
//
// This shell registers nothing and claims nothing when `window.isSecureContext`
// is false (plain HTTP such as the partner's Tailscale origin). Web Push is a
// later-phase flow, and it will live behind this same guard.
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return "unsupported";
  if (!window.isSecureContext) return "insecure-context";
  return navigator.serviceWorker
    .register("./sw.js", { scope: "./" })
    .then(() => "registered")
    .catch(() => "failed");
}

// The shell does not need the worker for anything it renders; registering is
// just the first offline-shell step. Surfaced async so a failure never delays
// the page.
if (typeof window !== "undefined") {
  // One stream for the whole app: the profile view (P1-11) and, later, the
  // shared thread. Started after load so it never competes with the first paint.
  window.addEventListener("load", () => {
    registerServiceWorker();
    startLive();
  });
}
