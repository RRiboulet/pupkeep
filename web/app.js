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
import { hashRoute, setState, subscribe } from "./store.js";
import { startLive } from "./live.js";
import { Today } from "./views/today.js";
import { Calendar } from "./views/calendar.js";
import { Pup } from "./views/pup.js";
import { Agent } from "./views/agent.js";
import { Settings } from "./views/settings.js";

const html = htm.bind(h);

const VIEWS = new Map([
  ["today", Today],
  ["calendar", Calendar],
  ["pup", Pup],
  ["agent", Agent],
  ["settings", Settings],
]);

const NAV_ITEMS = [
  { id: "today", label: "Today" },
  { id: "calendar", label: "Calendar" },
  { id: "pup", label: "Pup" },
  { id: "agent", label: "Agent" },
  { id: "settings", label: "Settings" },
];

function Nav({ route }) {
  return html`
    <nav class="bottom-nav" aria-label="Primary">
      ${NAV_ITEMS.map(
        (item) => html`
          <a
            key=${item.id}
            href="#${item.id}"
            class=${`bottom-nav__item${route === item.id ? " is-current" : ""}`}
            aria-current=${route === item.id ? "page" : "false"}
            aria-label=${item.label}
          >
            ${item.label}
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

function App({ route, online }) {
  const View = VIEWS.get(route) ?? Today;
  return html`
    <${Status} online=${online} />
    <main class="content" aria-label=${route}>
      <${View} />
    </main>
    <${Nav} route=${route} />
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
