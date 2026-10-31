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
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";
import { createContext, Script } from "node:vm";
import {
  API_CACHE_CONTROL,
  CONTENT_SECURITY_POLICY,
  RESERVED_PATHS,
  RESERVED_PREFIXES,
  applySecurityHeaders,
  isReservedPath,
  looksLikeTraversal,
  requestPathOf,
  resolveStatic,
  serveStaticRequest,
  type StaticFileSystem,
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
  assert.equal(res.headers["content-security-policy"], CONTENT_SECURITY_POLICY);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  // No CORS anywhere.
  for (const [name] of Object.entries(res.headers)) {
    assert.ok(!name.startsWith("access-control"), `unexpected CORS header ${name}`);
  }
  assert.match(res.body, /<div id="app">/);
  assert.match(res.body, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
});

test("the CSP closes framing, base and form action without opening the document", () => {
  // `frame-ancestors`, `base-uri` and `form-action` do not inherit from
  // `default-src`; without them the app is framable (clickjacking in front of
  // the future approval cards) and a `<base>`/form could be pointed elsewhere.
  assert.equal(
    CONTENT_SECURITY_POLICY,
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  for (const directive of ["frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) {
    assert.ok(CONTENT_SECURITY_POLICY.includes(directive), `missing ${directive}`);
  }
  // Tightening must not become loosening: no inline, no eval, no remote origin.
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-inline|unsafe-eval|(?:https?:|wss?:|\*)/);
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
  assert.equal(res.headers["content-security-policy"], CONTENT_SECURITY_POLICY);
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
    assert.equal(res.headers["content-security-policy"], CONTENT_SECURITY_POLICY, path);
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

test("the traversal pre-filter expands percent-escapes case-insensitively", () => {
  // Percent escapes are case-insensitive: `%2E` is `%2e` is `.`. The older
  // filter lowercased the decoded copy but not the unescaping, so an uppercase
  // escape walked past the layer the comment claimed caught the classic tricks.
  for (const target of [
    "/%2e%2e/package.json",
    "/%2E%2E/package.json",
    "/%2E%2e/package.json",
    "/..%2Fpackage.json",
    "/..%2fpackage.json",
    "/%2E%2E%2Fpackage.json",
    "/..%5Cpackage.json",
    "/..%5cpackage.json",
    "/.%00./package.json",
  ]) {
    assert.equal(looksLikeTraversal(target), true, target);
  }
  for (const target of ["/", "/app.js", "/vendor/preact.mjs", "/views/today.js"]) {
    assert.equal(looksLikeTraversal(target), false, target);
  }
});

test("containment is decided before an out-of-root target is stat'ed or opened", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "pupkeep-static-"));
  try {
    const root = join(sandbox, "web");
    await mkdir(root);
    await writeFile(join(root, "app.js"), "inside the root");
    await writeFile(join(sandbox, "package.json"), `{${PACK_NAME}:"outside"}`);
    await symlink(join(sandbox, "package.json"), join(root, "escape.txt"));

    const calls: string[] = [];
    const fs: StaticFileSystem = {
      realpath: async (path) => {
        calls.push(`realpath ${path}`);
        return realpath(path);
      },
      stat: async (path) => {
        calls.push(`stat ${path}`);
        return stat(path);
      },
      access: async (path, mode) => {
        calls.push(`access ${path}`);
        await access(path, mode);
      },
      readFile: async (path) => {
        calls.push(`readFile ${path}`);
        return readFile(path);
      },
    };

    // The symlink resolves outside the root: containment must refuse it, and
    // the solution path must never be stat'ed, access'ed or read — otherwise
    // the handler is an existence/readability oracle for files it will refuse.
    assert.deepEqual(await resolveStatic("GET", "/escape.txt", { root, fs }), { served: false });
    assert.deepEqual(
      calls,
      [`realpath ${root}`, `realpath ${join(root, "escape.txt")}`],
      "containment must be the only filesystem call for an escaping target",
    );

    // A contained file is pinned first, then stat'ed, access'ed and read.
    calls.length = 0;
    const served = await resolveStatic("GET", "/app.js", { root, fs });
    assert.equal(served.served, true);
    if (!served.served) assert.fail("app.js was not served");
    assert.equal(served.response.body?.toString(), "inside the root");
    assert.deepEqual(calls, [
      `realpath ${root}`,
      `realpath ${join(root, "app.js")}`,
      `stat ${join(root, "app.js")}`,
      `access ${join(root, "app.js")}`,
      `readFile ${join(root, "app.js")}`,
    ]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
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


// === The service worker, executed ==========================================
//
// The worker is loaded into a `vm` sandbox with a fake `self`, `caches` and
// `fetch`, then driven through real install/activate/fetch events. The source
// is the shipped `web/sw.js`; only a one-line probe is appended so the test can
// read the cache list and the reserved prefixes the worker derived at boot.

const ORIGIN = "https://pupkeep.test";

interface WorkerRequest {
  url: string;
  method: string;
}

interface WorkerResponse {
  status: number;
  ok: boolean;
  type: string;
  redirected: boolean;
  body: string;
  clone(): WorkerResponse;
}

function shellResponse(init: Partial<Omit<WorkerResponse, "ok" | "clone">> = {}): WorkerResponse {
  const status = init.status ?? 200;
  const response: WorkerResponse = {
    status,
    ok: status >= 200 && status < 300,
    type: init.type ?? "basic",
    redirected: init.redirected ?? false,
    body: init.body ?? "shell",
    clone: () => ({ ...response, clone: response.clone }),
  };
  return response;
}

function fetchRequest(path: string, method = "GET"): WorkerRequest {
  return { url: new URL(path, ORIGIN).href, method };
}

interface MatchOptions {
  ignoreSearch?: boolean;
}

class FakeCache {
  readonly store = new Map<string, WorkerResponse>();
  readonly log: string[] = [];
  fetchImpl: (input: WorkerRequest | string, init?: RequestInit) => Promise<WorkerResponse>;

  constructor(fetchImpl: (input: WorkerRequest | string, init?: RequestInit) => Promise<WorkerResponse>) {
    this.fetchImpl = fetchImpl;
  }

  key(input: WorkerRequest | string): string {
    return new URL(typeof input === "string" ? input : input.url, ORIGIN).href;
  }

  async match(input: WorkerRequest | string, options?: MatchOptions): Promise<WorkerResponse | undefined> {
    const key = this.key(input);
    this.log.push(`match ${new URL(key).pathname}${options?.ignoreSearch ? " ignoreSearch" : ""}`);
    if (options?.ignoreSearch) {
      const bare = key.split("?")[0];
      for (const [candidate, response] of this.store) {
        if (candidate.split("?")[0] === bare) return response;
      }
      return undefined;
    }
    return this.store.get(key);
  }

  async put(input: WorkerRequest | string, response: WorkerResponse): Promise<void> {
    const key = this.key(input);
    this.log.push(`put ${new URL(key).pathname}`);
    this.store.set(key, response);
  }

  /** Cache API fidelity: the pre-fix worker used `addAll`, so the harness has
   * to be able to run it (with the default redirect-following fetch) to show
   * what the install path did before the fix. The fixed worker never calls it. */
  async addAll(inputs: readonly (WorkerRequest | string)[]): Promise<void> {
    for (const input of inputs) {
      this.log.push(`addAll ${new URL(this.key(input)).pathname}`);
      this.store.set(this.key(input), await this.fetchImpl(input));
    }
  }

  get(path: string): WorkerResponse | undefined {
    return this.store.get(new URL(path, ORIGIN).href);
  }

  remove(path: string): void {
    this.store.delete(new URL(path, ORIGIN).href);
  }

  paths(): string[] {
    return [...this.store.keys()].map((key) => new URL(key).pathname).sort();
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>();
  readonly opened: string[] = [];
  fetchImpl: (input: WorkerRequest | string, init?: RequestInit) => Promise<WorkerResponse>;

  constructor(fetchImpl: (input: WorkerRequest | string, init?: RequestInit) => Promise<WorkerResponse>) {
    this.fetchImpl = fetchImpl;
  }

  async open(name: string): Promise<FakeCache> {
    this.opened.push(name);
    const existing = this.stores.get(name);
    if (existing) return existing;
    const cache = new FakeCache(this.fetchImpl);
    this.stores.set(name, cache);
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  get only(): FakeCache {
    const first = this.stores.values().next();
    if (first.done) throw new Error("the worker opened no cache");
    return first.value;
  }
}

interface SwProbe {
  PRECACHE: string[];
  RESERVED: string[];
  CACHE: string;
  SHELL_PATHS: string[];
  IMMUTABLE: string[];
  isReserved(pathname: string): boolean;
}

interface SwEvent {
  request?: WorkerRequest;
  waitUntil(promise: Promise<unknown>): void;
  respondWith(promise: Promise<WorkerResponse>): void;
}

type SwListener = (event: SwEvent) => void;
type NetworkRoute = (url: URL, init: RequestInit | undefined) => WorkerResponse | Promise<WorkerResponse>;
type FetchCall = { url: string; init: RequestInit | undefined };

interface WorkerHarness {
  storage: FakeCaches;
  network: FetchCall[];
  readonly cache: FakeCache;
  probe: SwProbe;
  precache: string[];
  reserved: string[];
  install(): Promise<void>;
  activate(): Promise<void>;
  dispatch(request: WorkerRequest): Promise<WorkerResponse | undefined>;
  skipWaitingCalls(): number;
  claimCalls(): number;
}

async function loadWorker(route: NetworkRoute = () => shellResponse()): Promise<WorkerHarness> {
  const network: FetchCall[] = [];
  const listeners = new Map<string, SwListener[]>();
  let skipWaiting = 0;
  let claimed = 0;

  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener(type: string, listener: SwListener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    skipWaiting: async () => {
      skipWaiting += 1;
    },
    clients: {
      claim: async () => {
        claimed += 1;
      },
    },
  };

  const fetchSpy = async (input: WorkerRequest | string, init?: RequestInit): Promise<WorkerResponse> => {
    const url = new URL(typeof input === "string" ? input : input.url, ORIGIN);
    network.push({ url: url.href, init });
    return route(url, init);
  };
  const storage = new FakeCaches(fetchSpy);

  const source = `${await readFile(join(WEB, "sw.js"), "utf8")}
;globalThis.__swProbe = { PRECACHE, RESERVED, CACHE, SHELL_PATHS: [...SHELL_PATHS], IMMUTABLE: typeof IMMUTABLE === "undefined" ? [] : [...IMMUTABLE], isReserved };`;
  const context = createContext({ self, caches: storage, fetch: fetchSpy, URL, Error, Promise, console });
  new Script(source, { filename: "web/sw.js" }).runInContext(context);
  const probe = (context as unknown as { __swProbe: SwProbe }).__swProbe;

  const dispatchWait = (type: "install" | "activate"): Promise<void> => {
    let waited: Promise<unknown> | undefined;
    const event: SwEvent = {
      waitUntil(promise) {
        waited = promise;
      },
      respondWith() {
        throw new Error(`${type} must not call respondWith`);
      },
    };
    for (const listener of listeners.get(type) ?? []) listener(event);
    if (!waited) throw new Error(`${type} listener never called waitUntil`);
    return Promise.resolve(waited).then(() => undefined);
  };

  const dispatch = async (request: WorkerRequest): Promise<WorkerResponse | undefined> => {
    let responded: Promise<WorkerResponse> | undefined;
    const event: SwEvent = {
      request,
      waitUntil() {
        throw new Error("fetch must not call waitUntil");
      },
      respondWith(promise) {
        responded = promise;
      },
    };
    for (const listener of listeners.get("fetch") ?? []) listener(event);
    return responded;
  };

  return {
    storage,
    network,
    get cache() {
      return storage.only;
    },
    probe,
    precache: probe.PRECACHE,
    reserved: probe.RESERVED,
    install: () => dispatchWait("install"),
    activate: () => dispatchWait("activate"),
    dispatch,
    skipWaitingCalls: () => skipWaiting,
    claimCalls: () => claimed,
  };
}

test("install fills exactly PRECACHE, from pristine same-origin 200s", async () => {
  const worker = await loadWorker((url) => shellResponse({ body: `shell ${url.pathname}` }));
  await worker.install();

  const expected = [...worker.precache]
    .map((entry) => new URL(entry, `${ORIGIN}/sw.js`).pathname)
    .sort();
  assert.equal(expected.length, 15, "the shell is the document, styles, modules, manifest and icons");
  assert.deepEqual(worker.cache.paths(), expected, "the cache holds exactly the precache list");
  assert.equal(worker.network.length, worker.precache.length, "one network fetch per entry");
  for (const call of worker.network) {
    assert.equal(call.init?.redirect, "error", `${call.url} must not follow a redirect`);
    assert.equal(call.init?.cache, "no-cache", `${call.url} must revalidate`);
  }
  assert.equal(worker.skipWaitingCalls(), 1);
  assert.deepEqual(worker.storage.opened, [worker.probe.CACHE]);

  for (const entry of worker.precache) {
    assert.ok(!entry.includes("/api") && !entry.includes("/sse"), `${entry} is a dynamic path`);
    if (entry === "./") continue; // the scope root, served as index.html
    await assert.doesNotReject(() => readFile(join(WEB, entry)), `${entry} does not exist in web/`);
  }
});

test("install refuses a redirected shell response instead of storing it under /", async () => {
  // The browser got `302 / -> /login`, followed it, and answered 200 with the
  // login body. `ok` is true and the type is basic; only `redirected` shows it.
  const worker = await loadWorker((url) =>
    url.pathname === "/"
      ? shellResponse({ redirected: true, body: "<html>sign in</html>" })
      : shellResponse(),
  );
  await assert.rejects(worker.install(), /\/ is not a same-origin 200.*redirected true/);
  assert.deepEqual(worker.storage.opened, [], "nothing is written when one entry is bad");
});

test("install fails loudly on a non-200, a cross-origin or a rejected fetch", async () => {
  const cases: Array<[string, NetworkRoute]> = [
    ["404", (url) => (url.pathname === "/app.js" ? shellResponse({ status: 404 }) : shellResponse())],
    ["cors", (url) => (url.pathname === "/app.js" ? shellResponse({ type: "cors" }) : shellResponse())],
    [
      "redirect:error",
      (_url, init) => {
        if (init?.redirect === "error") throw new TypeError("redirect mode is error");
        return shellResponse();
      },
    ],
  ];
  for (const [label, route] of cases) {
    const worker = await loadWorker(route);
    await assert.rejects(worker.install(), /install|redirect/i, label);
    assert.equal(worker.storage.stores.size, 0, `${label}: no partial cache is left behind`);
  }
});

test("activate deletes the previous cache and claims the clients", async () => {
  const worker = await loadWorker();
  const old = await worker.storage.open("pupkeep-static-v0");
  await old.put("/index.html", shellResponse({ body: "old shell" }));
  await worker.install();
  await worker.activate();
  assert.deepEqual(await worker.storage.keys(), [worker.probe.CACHE]);
  assert.equal(worker.claimCalls(), 1);
});

test("the worker and the static layer reserve the same namespaces", async () => {
  const worker = await loadWorker();
  assert.deepEqual([...worker.reserved], [...RESERVED_PREFIXES, ...RESERVED_PATHS]);
  const candidates = [
    "/api",
    "/api/",
    "/api/feed",
    "/apifoo",
    "/sse",
    "/sse/",
    "/ssefoo",
    "/sessions",
    "/healthz",
    "/app.js",
    "/",
  ];
  for (const path of candidates) {
    assert.equal(worker.probe.isReserved(path), isReservedPath(path), path);
  }
});

test("the worker never intercepts /api, /sse, non-GET or cross-origin requests", async () => {
  const worker = await loadWorker();
  for (const path of ["/api", "/api/", "/api/feed", "/api/v1/events", "/sse", "/sse/stream", "/ssefoo"]) {
    assert.equal(await worker.dispatch(fetchRequest(path)), undefined, path);
  }
  assert.equal(await worker.dispatch(fetchRequest("/", "POST")), undefined, "non-GET");
  assert.equal(await worker.dispatch(fetchRequest("/app.js", "HEAD")), undefined, "HEAD is not a GET");
  assert.equal(
    await worker.dispatch({ url: "https://elsewhere.test/app.js", method: "GET" }),
    undefined,
    "cross-origin",
  );
  assert.equal(worker.network.length, 0, "nothing was fetched on the worker's behalf");
  assert.deepEqual(worker.storage.opened, [], "the cache was never opened");
});

test("off-allowlist and query-string requests go to the network with no cache read or write", async () => {
  const worker = await loadWorker((url) => shellResponse({ body: `${url.pathname}${url.search}` }));
  await worker.install();
  const cache = worker.cache;
  const before = cache.paths();
  cache.log.length = 0;

  const offAllowlist = ["/healthz", "/login", "/invite", "/tos", "/vendor/preact-hooks.mjs"];
  for (const path of offAllowlist) {
    const response = await worker.dispatch(fetchRequest(path));
    assert.equal(response?.body, path, `${path} must be a live network answer`);
  }

  const withQuery = ["/?token=secret", "/index.html?v=2", "/app.js?x=1", "/vendor/preact.mjs?v=1"];
  for (const path of withQuery) {
    const url = new URL(path, ORIGIN);
    const response = await worker.dispatch(fetchRequest(path));
    assert.equal(response?.body, url.pathname + url.search, `${path} must reach the network`);
  }

  assert.deepEqual(cache.paths(), before, "nothing was written");
  assert.ok(
    cache.log.every((entry) => !entry.includes("ignoreSearch")),
    "the shell must never be matched with ignoreSearch",
  );
  assert.deepEqual(cache.log, [], `the cache was touched: ${cache.log.join(", ")}`);
  assert.equal(worker.network.length, worker.precache.length + offAllowlist.length + withQuery.length);
  // The query survived to the network: `/?token=…` was not collapsed to `/`.
  assert.ok(worker.network.some((call) => call.url === `${ORIGIN}/?token=secret`));
});

test("revalidating shell files are network-first with a cache fallback", async () => {
  let online = true;
  const worker = await loadWorker((url) => {
    if (!online) throw new TypeError("offline");
    return shellResponse({ body: `fresh ${url.pathname}` });
  });
  await worker.install();

  // The files the HTTP layer serves `Cache-Control: no-cache`.
  for (const path of ["/", "/index.html", "/app.js", "/store.js", "/views/today.js", "/manifest.webmanifest", "/style.css"]) {
    worker.network.length = 0;
    const response = await worker.dispatch(fetchRequest(path));
    assert.equal(response?.body, `fresh ${path}`, `${path} must be answered by the network first`);
    assert.equal(worker.network.length, 1, `${path} must hit the network`);
    assert.equal(worker.network[0]?.url, new URL(path, ORIGIN).href, path);
    assert.equal(worker.cache.get(path)?.body, `fresh ${path}`, `${path} refreshed the cache`);
  }

  online = false;
  for (const path of ["/", "/app.js", "/views/calendar.js"]) {
    worker.network.length = 0;
    const response = await worker.dispatch(fetchRequest(path));
    assert.equal(response?.body, `fresh ${path}`, `${path} fell back to the precache offline`);
    assert.equal(worker.network.length, 1, `${path} still tried the network once`);
  }

  // Offline with nothing cached is an honest failure, not a fabricated shell.
  worker.cache.remove("/views/pup.js");
  await assert.rejects(worker.dispatch(fetchRequest("/views/pup.js")), /offline/);
});

test("vendored modules and icons are answered from cache first", async () => {
  const worker = await loadWorker((url) => shellResponse({ body: `network ${url.pathname}` }));
  await worker.install();
  const cache = worker.cache;

  for (const path of ["/vendor/preact.mjs", "/vendor/htm.mjs", "/icons/icon-192.png", "/icons/icon-512.png"]) {
    worker.network.length = 0;
    const response = await worker.dispatch(fetchRequest(path));
    assert.equal(response?.body, `network ${path}`, `${path} came from the precache`);
    assert.equal(worker.network.length, 0, `${path} did not hit the network`);
  }

  // A cache miss fetches once and fills the cache.
  cache.remove("/vendor/htm.mjs");
  worker.network.length = 0;
  const fetched = await worker.dispatch(fetchRequest("/vendor/htm.mjs"));
  assert.equal(fetched?.body, "network /vendor/htm.mjs");
  assert.equal(worker.network.length, 1);
  assert.equal(cache.get("/vendor/htm.mjs")?.body, "network /vendor/htm.mjs");
});

test("a non-200, cross-origin-typed or redirected answer is never stored", async () => {
  const cases: Array<[string, WorkerResponse]> = [
    ["/app.js", shellResponse({ status: 500 })],
    ["/style.css", shellResponse({ status: 404 })],
    ["/app.js", shellResponse({ type: "cors" })],
    ["/vendor/preact.mjs", shellResponse({ redirected: true })],
  ];
  for (const [path, answer] of cases) {
    // Install succeeds first; only the runtime answer is the bad one.
    let answering = false;
    const worker = await loadWorker((url) =>
      answering && url.pathname === path ? answer : shellResponse({ body: `precached ${url.pathname}` }),
    );
    await worker.install();
    answering = true;
    const cached = worker.cache.get(path)?.body;
    assert.ok(cached, `${path} was precached`);
    worker.cache.log.length = 0;

    const served = await worker.dispatch(fetchRequest(path));
    assert.equal(served?.status, answer.status, path);
    assert.equal(worker.cache.get(path)?.body, cached, `${path} was overwritten`);
    assert.ok(
      !worker.cache.log.some((entry) => entry.startsWith("put ")),
      `${path} was written despite status ${answer.status}, type ${answer.type}, redirected ${answer.redirected}`,
    );
  }
});

// === app.js scheduling ======================================================
//
// app.js has no build step and no module mocking; the test strips its imports
// (their behaviour is the fake store's) and runs the rest against a fake DOM.

test("app.js applies every state change in a frame and the last one wins", async () => {
  const source = await readFile(join(WEB, "app.js"), "utf8");
  const body = source
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n")
    .replace(/^export /gm, "");
  assert.doesNotMatch(body, /^\s*(?:import|export)\b/m, "the harness could not strip the module syntax");

  const routes = new Set(["today", "calendar", "pup", "agent", "settings"]);
  const location = { hash: "" };
  const state = { route: "today", online: true as boolean };
  const subscribers = new Set<(next: typeof state) => void>();
  const hashRoute = () =>
    routes.has(String(location.hash).replace(/^#\/?/, "")) ? String(location.hash).replace(/^#\/?/, "") : "today";
  const setState = (patch: Partial<typeof state>) => {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (state[key as keyof typeof state] === value) continue;
      (state as Record<string, unknown>)[key] = value;
      changed = true;
    }
    if (changed) for (const listener of subscribers) listener(state);
  };
  const subscribe = (listener: (next: typeof state) => void) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  };

  const frames: Array<() => void> = [];
  const renders: Array<{ route: string; online: boolean }> = [];
  const htm = {
    bind: () => (_strings: TemplateStringsArray, ...values: unknown[]) => ({ values }),
  };
  const h = () => null;
  const render = (vnode: { values: unknown[] }) => {
    renders.push({ route: String(vnode.values[1]), online: Boolean(vnode.values[2]) });
  };
  const windowListeners = new Map<string, Array<() => void>>();
  const window = {
    isSecureContext: true,
    addEventListener(type: string, listener: () => void) {
      const list = windowListeners.get(type) ?? [];
      list.push(listener);
      windowListeners.set(type, list);
    },
  };
  const dispatchWindow = (type: string) => {
    for (const listener of windowListeners.get(type) ?? []) listener();
  };
  const navigator = { onLine: true };
  const document = { getElementById: () => ({}) };
  const requestAnimationFrame = (callback: () => void) => frames.push(callback);
  const View = () => null;

  new Function(
    "h",
    "render",
    "htm",
    "hashRoute",
    "setState",
    "subscribe",
    "Today",
    "Calendar",
    "Pup",
    "Agent",
    "Settings",
    "document",
    "navigator",
    "window",
    "requestAnimationFrame",
    body,
  )(
    h,
    render,
    htm,
    hashRoute,
    setState,
    subscribe,
    View,
    View,
    View,
    View,
    View,
    document,
    navigator,
    window,
    requestAnimationFrame,
  );

  const flush = () => {
    const frame = frames.shift();
    assert.ok(frame, "a frame was queued");
    frame();
  };

  // The first frame is still pending when the user navigates and goes offline.
  location.hash = "#calendar";
  navigator.onLine = false;
  dispatchWindow("hashchange");
  dispatchWindow("offline");
  assert.equal(frames.length, 1, "both changes coalesce into the one queued frame");
  flush();
  assert.deepEqual(renders[0], { route: "calendar", online: false });

  // The frame reset `pending`: the next change paints again.
  navigator.onLine = true;
  dispatchWindow("online");
  assert.equal(frames.length, 1, "a later change queues a new frame");
  flush();
  assert.deepEqual(renders[1], { route: "calendar", online: true });

  // Two navigation changes in one frame: the last route wins, not the first.
  location.hash = "#pup";
  dispatchWindow("hashchange");
  location.hash = "#agent";
  dispatchWindow("hashchange");
  assert.equal(frames.length, 1);
  flush();
  assert.deepEqual(renders[2], { route: "agent", online: true });

  assert.equal(renders.length, 3, "one render per frame, no dropped or duplicated paint");
});
