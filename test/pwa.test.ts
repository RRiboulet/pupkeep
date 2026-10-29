// P1-10 — the PWA shell and the static security surface.
//
// The browser-only parts (manifest installability, the registration guard,
// the service worker's cache list) are asserted statically here; a device
// still has to confirm the actual localhost install and the partner's
// Tailscale load (PLAN §3.5). What *is* exercised against a real `node:http`
// server is the seam P1-09 composes: `serveStaticRequest` first, and when the
// request is not a static asset the dynamic layer answers with the security
// headers and `Cache-Control: no-store` — API/SSE never cached, never stubbed.

import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, before, after } from "node:test";
import {
  API_CACHE_CONTROL,
  CONTENT_SECURITY_POLICY,
  applySecurityHeaders,
  requestPathOf,
  serveStaticRequest,
} from "../src/server/static.ts";

const WEB = join(import.meta.dirname, "..", "web");
const PACK_NAME = `"name"`;

interface Fetched {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (address && typeof address === "object") resolvePort(address.port);
      else reject(new Error("no port"));
    });
    server.listen(0, "127.0.0.1");
  });
}

// One server per boot, shared by every test like one app start. The handler
// is the composition P1-09 will keep: static first, then the dynamic layer,
// which always sets the security headers and never allows caching.
let server: Server | null = null;
let port = 0;

before(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void serveStaticRequest(req, res, { root: WEB })
      .then((served) => {
        if (served) return;
        applySecurityHeaders(res);
        res.setHeader("Cache-Control", API_CACHE_CONTROL);
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      })
      .catch((error: unknown) => {
        res.statusCode = 500;
        res.end(String(error));
      });
  });
  port = await listen(server);
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
});

/** A GET/HEAD like a browser would send it — but without `fetch()`'s URL
 * normalization, so raw traversal targets reach the server untouched. */
function fetchRaw(
  path: string,
  method: "GET" | "HEAD" | "POST" = "GET",
): Promise<Fetched> {
  return new Promise((resolveFetch, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method });
    req.on("error", reject);
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolveFetch({
          status: res.statusCode ?? 0,
          headers: Object.fromEntries(
            Object.entries(res.headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
          ),
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.end();
  });
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// === The shell over HTTP ====================================================

test("the shell is served at / with the CSP, nosniff and no-referrer", async () => {
  const res = await fetchRaw("/");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(res.headers["content-security-policy"], "default-src 'self'");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  // No CORS anywhere.
  for (const [name] of Object.entries(res.headers)) {
    assert.ok(!name.startsWith("access-control"), `unexpected CORS header ${name}`);
  }
  assert.match(res.body, /<div id="app">/);
  assert.match(res.body, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
});

test("the shell mounts and navigates only through module scripts", async () => {
  const html = await readFile(join(WEB, "index.html"), "utf8");
  assert.match(html, /<script type="module" src="\.\/app\.js"><\/script>/);
  // CSP `default-src 'self'` allows no inline scripts, no inline styles and
  // no inline event handlers — none may sneak into the document.
  const inlineScript = /<script(?![^>]*\ssrc=)[^>]*>[^<]/i;
  assert.doesNotMatch(html, inlineScript);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "inline event handler");
  assert.doesNotMatch(html, /<style[\s>]/i, "inline <style>");
  assert.doesNotMatch(html, /\sstyle\s*=\s*["']/i, "inline style attribute");
  const app = await readFile(join(WEB, "app.js"), "utf8");
  for (const label of ["Today", "Calendar", "Pup", "Agent", "Settings"]) {
    assert.ok(app.includes(label), `bottom navigation misses "${label}"`);
  }
});

test("the shell imports the vendored modules by relative path", async () => {
  const entries = [
    "app.js",
    "store.js",
    "views/today.js",
    "views/calendar.js",
    "views/pup.js",
    "views/agent.js",
    "views/settings.js",
    "sw.js",
  ];
  for (const entry of entries) {
    const text = await readFile(join(WEB, entry), "utf8");
    assert.doesNotMatch(
      text,
      /(?<!\.)(?<!\/)(?:^|[^"'./\w])import\s+[^"'\n]*from\s+["'](?!\.\/|\.\.\/|\/|@)[a-z]/,
      `${entry} must not rely on bare module specifiers (no import map is served)`,
    );
  }
});

test("HEAD / serves the shell headers without a body", async () => {
  const res = await fetchRaw("/", "HEAD");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-security-policy"], "default-src 'self'");
  assert.equal(res.body, "");
});

test("query strings never change the file that is served", async () => {
  const withQuery = await fetchRaw("/?campaign=test");
  assert.equal(withQuery.status, 200);
  assert.match(withQuery.body, /<div id="app">/);
  const js = await fetchRaw("/app.js?x=1&y=2");
  assert.equal(js.status, 200);
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
});

test("the client modules, style and vendored modules have tight types and cache rules", async () => {
  const cases: Array<[string, string, string?]> = [
    ["/app.js", "text/javascript; charset=utf-8", "no-cache"],
    ["/store.js", "text/javascript; charset=utf-8", "no-cache"],
    ["/views/today.js", "text/javascript; charset=utf-8", "no-cache"],
    ["/style.css", "text/css; charset=utf-8", "no-cache"],
    ["/vendor/preact.mjs", "text/javascript; charset=utf-8", "public, max-age=3600"],
    ["/vendor/htm-preact.mjs", "text/javascript; charset=utf-8", "public, max-age=3600"],
  ];
  for (const [path, type, cacheControl] of cases) {
    const res = await fetchRaw(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers["content-type"], type, path);
    if (cacheControl) assert.equal(res.headers["cache-control"], cacheControl, path);
  }
});

test("the manifest, icons and service worker are served and cacheable correctly", async () => {
  const manifest = await fetchRaw("/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers["content-type"], "application/manifest+json; charset=utf-8");
  assert.equal(manifest.headers["cache-control"], "no-cache");

  const sw = await fetchRaw("/sw.js");
  assert.equal(sw.status, 200);
  assert.equal(sw.headers["content-type"], "text/javascript; charset=utf-8");
  // A service worker must revalidate: a stale worker registers an old cache list.
  assert.equal(sw.headers["cache-control"], "no-cache");

  for (const name of ["icon-192.png", "icon-512.png"]) {
    const icon = await fetchRaw(`/icons/${name}`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers["content-type"], "image/png", name);
  }
});

test("the manifest is an installable PWA manifest with real PNG icons", async () => {
  const raw = await readFile(join(WEB, "manifest.webmanifest"), "utf8");
  const manifest = JSON.parse(raw) as {
    name?: string;
    short_name?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    icons?: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  };
  assert.equal(manifest.name, "Pupkeep");
  assert.ok(manifest.short_name);
  assert.match(manifest.display ?? "", /^standalone$/);
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");

  assert.ok(manifest.icons && manifest.icons.length >= 4, "192 and 512 icons for any and maskable");
  const anys = manifest.icons.filter((icon) => (icon.purpose ?? "any").includes("any"));
  assert.ok(anys.length >= 2, "a plain `any` icon is required for installability");
  assert.ok(
    manifest.icons.some((icon) => (icon.purpose ?? "").includes("maskable")),
    "an adaptive-launcher icon keeps Android from letterboxing the app",
  );

  const sizes = new Set<string>();
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png", icon.src);
    assert.match(icon.sizes, /^\d+x\d+$/);
    sizes.add(icon.sizes);
    const bytes = await readFile(join(WEB, icon.src.replace(/^\.\//, "")));
    const dims = pngSize(bytes);
    assert.equal(
      `${dims.width}x${dims.height}`,
      icon.sizes,
      `${icon.src} does not really have the advertised size`,
    );
  }
  assert.deepEqual([...sizes].sort(), ["192x192", "512x512"]);
});

test("both icons are valid PNGs stamped with their advertised sizes", async () => {
  for (const [name, size] of [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ] as const) {
    const bytes = await readFile(join(WEB, "icons", name));
    const dims = pngSize(bytes);
    assert.equal(dims.width, size, name);
    assert.equal(dims.height, size, name);
    assert.ok(bytes.byteLength > 200, `${name} should not be a stub`);
    assert.ok(bytes.byteLength < 100_000, `${name} should stay small`);
  }
});

// === The dynamic surface is not the static surface ==========================

test("API and SSE paths are never claimed by the static layer", async () => {
  for (const path of ["/api/feed", "/api/entries", "/sse", "/api/", "/api/v1/events"] as const) {
    const res = await fetchRaw(path);
    assert.equal(res.status, 404, `${path} must not resolve to a file`);
    assert.equal(res.headers["cache-control"], API_CACHE_CONTROL, path);
    assert.equal(res.headers["content-security-policy"], "default-src 'self'", path);
    assert.match(res.body, /"error"/);
    assert.doesNotMatch(res.body, /<html/i, `${path} must not answer with the shell`);
  }
});

test("non-GET requests to the shell are not served either", async () => {
  const res = await fetchRaw("/", "POST");
  assert.equal(res.status, 404);
  assert.equal(res.headers["cache-control"], API_CACHE_CONTROL);
  assert.doesNotMatch(res.body, /<html/i);
});

test("requestPathOf strips whatever the client appended to the target", () => {
  assert.equal(requestPathOf({ url: "/app.js?x=1" } as IncomingMessage), "/app.js");
  assert.equal(requestPathOf({ url: "/index.html" } as IncomingMessage), "/index.html");
  assert.equal(requestPathOf({ url: "/" } as IncomingMessage), "/");
  assert.equal(requestPathOf({ url: "" } as IncomingMessage), "/");
});

test("path traversal never leaves the web root", async () => {
  const targets = [
    "/../package.json",
    "/..%2fpackage.json",
    "/%2e%2e/package.json",
    "/%2e%2e%2fpackage.json",
    "/..%2f..%2fpackage.json",
    "/vendor/..%2f..%2fpackage.json",
    "/views/%2e%2e/%2e%2e/%2e%2e/package.json",
    "/%252e%252e/package.json",
    "/.%00./package.json",
    "/..\\package.json",
  ];
  for (const target of targets) {
    const res = await fetchRaw(target);
    assert.notEqual(res.status, 200, `${target} escaped`);
    assert.doesNotMatch(
      res.body,
      new RegExp(PACK_NAME),
      `${target} served a file outside the web root`,
    );
    assert.equal(res.headers["cache-control"], API_CACHE_CONTROL, target);
  }
});

test("dotfiles and odd escapes are refused outright", async () => {
  for (const target of ["/.gitkeep", "/%2e", "/a%2fb/../.."] as const) {
    const res = await fetchRaw(target);
    assert.notEqual(res.status, 200, target);
  }
});

// === Browser-side guarantees (static assertions) ============================

test("the service worker registers only in a secure context and never claims push now", async () => {
  const app = await readFile(join(WEB, "app.js"), "utf8");
  // The registration guard: the worker is registered only when the origin is
  // HTTPS or localhost — never from the partner's plain-HTTP Tailscale origin.
  assert.match(app, /\bwindow\.isSecureContext\b/);
  const guard = app.indexOf("isSecureContext");
  const register = app.search(/serviceWorker\s*\.\s*register/);
  assert.ok(guard !== -1 && register !== -1 && guard < register, "guard runs before register");
  // The shell does not attempt Web Push or permission prompts: those are a
  // later phase, HTTPS-only, and must not exist through a security accident.
  assert.doesNotMatch(app, /pushManager/, "no Web Push subscription in the shell");
  assert.doesNotMatch(app, /Notification\.requestPermission/, "no notification prompt in the shell");
});

test("the service worker caches only the static shell", async () => {
  const sw = await readFile(join(WEB, "sw.js"), "utf8");
  // Extract the precache list and check every entry is a real file in web/.
  const list = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
  assert.ok(list, "PRECACHE list found");
  const entries = [...(list[1]?.matchAll(/"([^"]+)"/g) ?? [])].map((m) => m[1]!);
  assert.ok(entries.includes("./index.html"), "the document is precached");
  assert.ok(entries.some((entry) => entry.startsWith("./vendor/")), "vendored modules are precached");
  assert.ok(entries.some((entry) => entry.startsWith("./icons/")), "icons are precached");
  for (const entry of entries) {
    assert.ok(!entry.includes("api"), `${entry} is not an API path`);
    assert.ok(!entry.includes("sse"), `${entry} is not an SSE path`);
    if (entry === "./") {
      // The scope root: served as index.html by the static layer.
      continue;
    }
    const file = join(WEB, entry);
    await assert.doesNotReject(() => readFile(file), `${entry} does not exist in web/`);
  }
  // The dynamic paths are skipped by name in the fetch handler.
  assert.match(sw, /method !== "GET"/, "never touches non-GET requests");
  assert.match(sw, /isReserved/, "reserved paths (API/SSE) are excluded");
  assert.match(sw, /\/api\(/, "the /api prefix is reserved");
  assert.match(sw, /\/sse/, "the SSE path is reserved");
  assert.doesNotMatch(sw, /fetch\(["']/, "no offline writes: the worker never fabricates requests");

  // Runtime caching is allowlisted, not "everything except api/sse": derive
  // the shell pathnames from PRECACHE the way the worker does, and prove the
  // dynamic and unknown surfaces are outside it.
  const shell = new Set(entries.map((entry) => "/" + entry.replace(/^\.\//, "")));
  assert.ok(shell.has("/"), "the shell document is on the allowlist");
  assert.ok(shell.has("/index.html"), "index.html is on the allowlist");
  assert.ok(shell.has("/app.js"), "app modules are on the allowlist");
  for (const dynamic of ["/healthz", "/login", "/invite", "/tos", "/download"] as const) {
    assert.ok(
      !shell.has(dynamic),
      `${dynamic} is not a shell asset and must not be runtime-cached`,
    );
  }
  // And the fetch handler refuses to touch the cache for anything off the
  // allowlist, in both directions, before any cache operation could happen.
  const fetchHandler = sw.slice(sw.indexOf("addEventListener(\"fetch\""));
  const allowlist = fetchHandler.indexOf("!isShellAsset(url.pathname)");
  const cacheOpen = fetchHandler.indexOf("caches.open(CACHE)");
  assert.ok(allowlist !== -1, "the fetch handler checks the shell allowlist");
  assert.ok(cacheOpen !== -1, "the fetch handler uses its own shell cache");
  assert.ok(allowlist < cacheOpen, "non-shell requests never reach the cache at all");
  assert.match(
    fetchHandler,
    /if \(!isShellAsset\(url\.pathname\)\) \{\s*event\.respondWith\(fetch\(request\)\);\s*return;/,
    "off-allowlist requests bypass the cache untouched",
  );
  const put = fetchHandler.indexOf("cache.put(request");
  assert.ok(put !== -1 && put > allowlist, "cache.put is reachable only after the allowlist gate");
});
