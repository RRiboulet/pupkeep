// The Pupkeep service worker: a static-shell cache and nothing else.
//
// Rules (PLAN §14.2 / §3.5):
//  - it caches only the static shell listed in PRECACHE (the "versioned,
//    static-only cache");
//  - it never touches API, SSE or any non-GET request: no offline writes, no
//    replayed mutations, no cached dynamic responses;
//  - anything it does not know is passed straight to the network, and if the
//    network answer is not a static shell asset it is never stored;
//  - bump VERSION when the shell changes; the old cache is deleted on activate.
//
// Web Push event handlers (push, notificationclick) arrive with the push
// phase; the worker stays quiet about notifications until then.

const VERSION = "pupkeep-shell-v1";
const CACHE = `pupkeep-static-${VERSION}`;

// Relative to the worker's scope. Only minimum shell assets: the document,
// the style, the app modules, the manifest and the icons.
const PRECACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./store.js",
  "./views/today.js",
  "./views/calendar.js",
  "./views/pup.js",
  "./views/agent.js",
  "./views/settings.js",
  // Only what the shell imports. `preact-hooks.mjs` and `htm-preact.mjs` are
  // vendored and pinned (NOTICE.md) but not precached: they contain bare
  // preact/htm specifiers that resolve only through an import map, which this
  // shell does not serve (PLAN §13.2). The fetch handler still caches whatever
  // the page really loads.
  "./vendor/preact.mjs",
  "./vendor/htm.mjs",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// The dynamic surface: API routes and the SSE stream. The worker never
// intercepts, caches or reorders these — they are always live network calls,
// and only the HTTP layer's `Cache-Control: no-store` plus this guard keep
// them out of any cache.
const RESERVED = [/^\/api(\/|$)/, /^\/sse(\?|$|\/)/];

function isReserved(pathname) {
  return RESERVED.some((pattern) => pattern.test(pathname));
}

// The runtime-cache allowlist: exactly the static shell, derived from the same
// PRECACHE list the install step fills the cache with. The two can never drift
// apart. Anything not on this list — `/healthz`, a future `/login` or
// `/invite` page, or any other dynamic response — is never read from, written
// to, or replayed from the cache in either direction: a dynamic response can
// carry session state (e.g. a login page that sets a token), so caching one
// would leak it into a shared storage that outlives the request.
const SHELL_PATHS = new Set(
  PRECACHE.map((entry) => new URL(entry, self.location).pathname),
);

function isShellAsset(pathname) {
  return SHELL_PATHS.has(pathname);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only idempotent reads. A POST/PUT/PATCH/DELETE must never be satisfied,
  // replayed or recorded from a cache.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Cross-origin requests are not ours to cache.
  if (url.origin !== self.location.origin) return;

  // API and SSE are never cached, never answered from cache.
  if (isReserved(url.pathname)) return;

  // Anything outside the static shell allowlist — `/healthz`, a future
  // `/login` or `/invite` page, any other dynamic response — goes straight to
  // the network untouched: no cache read, no cache write.
  if (!isShellAsset(url.pathname)) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      const response = await fetch(request);
      // The allowlist check above already excludes dynamic paths; a non-200 or
      // non-basic answer is likewise never stored. This put() can therefore
      // only ever write shell assets — the same set install() precaches.
      if (response && response.status === 200 && response.type === "basic") {
        cache.put(request, response.clone());
      }
      return response;
    }),
  );
});
