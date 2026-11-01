// The Pupkeep service worker: a static-shell cache and nothing else.
//
// Rules (PLAN §14.2 / §3.5):
//  - it caches only the static shell listed in PRECACHE (the "versioned,
//    static-only cache");
//  - a request whose URL has a query string is never answered from, or written
//    to, the cache: shell files are addressed by path, so `/?token=…` must
//    reach the network and can never be answered with a cached document;
//  - the document, the app modules, the style and the manifest are
//    network-first with a cache fallback. They are exactly the files the HTTP
//    layer marks `Cache-Control: no-cache`, and a cache-first worker would
//    otherwise make a deploy invisible until VERSION was hand-bumped;
//  - only `./vendor/*` and `./icons/*` are cache-first: their names are the
//    version and they may live in a browser cache anyway;
//  - it never touches API, SSE or any non-GET request: no offline writes, no
//    replayed mutations, no cached dynamic responses;
//  - anything off the allowlist is passed straight to the network, and a
//    response that is not a pristine same-origin 200 is never stored;
//  - install fails loudly unless every precached entry is a pristine
//    same-origin 200. A followed redirect would otherwise store e.g. the login
//    page under the `/` key;
//  - bump VERSION when the shell changes; the old cache is deleted on activate.
//
// The shell still works offline: network-first falls back to the precache
// when the network rejects.
//
// Web Push event handlers (push, notificationclick) arrive with the push
// phase; the worker stays quiet about notifications until then.

const VERSION = "pupkeep-shell-v2";
const CACHE = `pupkeep-static-${VERSION}`;

// Relative to the worker's scope. Only minimum shell assets: the document,
// the style, the app modules, the manifest and the icons.
const PRECACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./client.js",
  "./live.js",
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

// The dynamic surface: the API and SSE namespaces. This list is kept identical
// to `RESERVED_PREFIXES` in `src/server/static.ts` — test/pwa.test.ts compares
// the two, so they cannot drift apart. The whole namespace is reserved
// (`/api`, `/api/…`, `/sse`, `/ssefoo`): no static file lives there, and
// over-reserving a prefix costs nothing.
const RESERVED = ["/api", "/sse"];

function isReserved(pathname) {
  return RESERVED.some((prefix) => pathname.startsWith(prefix));
}

// The runtime-cache allowlist: exactly the static shell, derived from the same
// PRECACHE list the install step fills the cache with, so the two can never
// drift apart. Anything not on this list — `/healthz`, a future `/login` or
// `/invite` page, or any other dynamic response — is never read from, written
// to, or replayed from the cache in either direction: a dynamic response can
// carry session state (e.g. a login page that sets a token), so caching one
// would leak it into a shared storage that outlives the request.
const SHELL_PATHS = new Set(
  PRECACHE.map((entry) => new URL(entry, self.location).pathname),
);

// Cache-first is limited to the assets whose name is the version: the vendored
// modules and the icons. Everything else on the allowlist revalidates through
// the network first. Derived from PRECACHE as well, so it stays inside the
// allowlist by construction.
const IMMUTABLE = new Set(
  PRECACHE.filter((entry) => entry.startsWith("./vendor/") || entry.startsWith("./icons/")).map(
    (entry) => new URL(entry, self.location).pathname,
  ),
);

function isShellAsset(pathname) {
  return SHELL_PATHS.has(pathname);
}

// What the worker may keep: a successful, same-origin, non-redirected answer.
// `type === "basic"` means the browser answered from our own origin;
// `redirected` is the followed-redirect case that `ok` alone cannot see.
function isShellResponse(response) {
  return response.ok && response.type === "basic" && !response.redirected;
}

async function storeIfPristine(cache, request, response) {
  if (isShellResponse(response)) await cache.put(request, response.clone());
  return response;
}

async function cacheFirst(cache, request) {
  const cached = await cache.match(request);
  if (cached) return cached;
  return storeIfPristine(cache, request, await fetch(request));
}

async function networkFirst(cache, request) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    // Offline (or the network refused): the precached shell is the fallback.
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
  return storeIfPristine(cache, request, response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    // Fetch and validate every entry before writing any of them: one bad
    // response fails the whole install instead of leaving a half-full cache
    // that looks usable.
    Promise.all(
      PRECACHE.map(async (entry) => {
        const url = new URL(entry, self.location);
        const response = await fetch(entry, { redirect: "error", cache: "no-cache" });
        if (!isShellResponse(response)) {
          throw new Error(
            `Pupkeep shell install: ${url.pathname} is not a same-origin 200 ` +
              `(status ${response.status}, type ${response.type}, redirected ${response.redirected})`,
          );
        }
        return [url.href, response];
      }),
    ).then(async (entries) => {
      const cache = await caches.open(CACHE);
      for (const [key, response] of entries) await cache.put(key, response);
      await self.skipWaiting();
    }),
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

  // A query string names a different resource (`/?token=…`, `/app.js?v=2`) and
  // the shell is addressed by path only. Off to the network, with no cache
  // read and no cache write — otherwise the cached shell would answer a login
  // link and a deploy's cache-busting query would be ignored.
  if (url.search !== "") {
    event.respondWith(fetch(request));
    return;
  }

  // Anything outside the static shell allowlist — `/healthz`, a future
  // `/login` or `/invite` page, any other dynamic response — goes straight to
  // the network untouched: no cache read, no cache write.
  if (!isShellAsset(url.pathname)) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => (IMMUTABLE.has(url.pathname) ? cacheFirst(cache, request) : networkFirst(cache, request))),
  );
});
