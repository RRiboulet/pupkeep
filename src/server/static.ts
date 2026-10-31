// The static surface: the web shell under `web/`, served with tight security
// headers and nothing else.
//
// P1-09 owns the live HTTP layer; this module is the P1-10 half of the seam
// and is deliberately self-contained so it can be tested against a real
// `node:http` server (test/pwa.test.ts). The integration is small:
//
//   * `serveStaticRequest(req, res, opts)` — try to serve; returns `false`
//     when the request is not a static asset (API, SSE, unknown), and the
//     HTTP layer's own routing takes over;
//   * `applySecurityHeaders(res)` — sets CSP/nosniff/Referrer-Policy on any
//     response; the live layer should call this for every response so the
//     API/SSE surface rides under the same policy;
//   * `API_CACHE_CONTROL` — `no-store`, for every API and SSE response;
//     the static shell is the only cacheable thing this app serves.
//
// Safety properties (PLAN §14.2):
//   * path traversal can never leave `root`: percent-decoding is validated
//     segment by segment, `..`/backslash/NUL are refused, the resolved file
//     must exist under the root's realpath, and symlinked roots are pinned;
//   * the MIME mapping is explicit, because `X-Content-Type-Options:
//     nosniff` means a wrong type is a broken page, not a sniffing hazard;
//   * the service worker (`web/sw.js`) caches only this static surface, so
//     declining the dynamic paths here is also what keeps them uncached.

import type { IncomingMessage, ServerResponse } from "node:http";
import { constants as fsConstants, type Stats } from "node:fs";
import { access as fsAccess, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** The whole-CSP for the app: everything comes from our own origin — the
 * vendored Preact/htm modules, the stylesheet, the manifest, the icons and
 * the (future) same-origin API/SSE. No `unsafe-inline`, no `unsafe-eval`, no
 * third-party origins, no CORS. New client code must keep loading the
 * modules through relative imports, not inline scripts.
 *
 * `frame-ancestors`, `base-uri` and `form-action` do not inherit from
 * `default-src`, so they are stated explicitly: without them the app is
 * framable (clickjacking in front of the approval cards) and a `<base>` or a
 * form could be pointed off-origin. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** The headers every response (static and dynamic) should carry. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

/** API and SSE responses are never cacheable. The service worker also skips
 * them by path; this is the HTTP layer's half of the guarantee. */
export const API_CACHE_CONTROL = "no-store";

/** Path prefixes the static surface never claims — the dynamic app. This list
 * is kept identical to `RESERVED` in `web/sw.js` — test/pwa.test.ts compares
 * the two, so they cannot drift apart. The whole namespace is reserved
 * (`/api`, `/api/…`, `/sse`, `/ssefoo`): no static file lives under either
 * prefix, and over-reserving a prefix costs nothing. */
export const RESERVED_PREFIXES: readonly string[] = Object.freeze(["/api", "/sse"]);
export const RESERVED_PATHS: readonly string[] = Object.freeze([]);

export type Mime = string;

const MIME_TYPES: Readonly<Record<string, Mime>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
});

const DEFAULT_MIME = "application/octet-stream";

/** Cache policy by how a file is identified. The document, the service worker
 * and the manifest must revalidate so a deploy lands; vendor modules and
 * icons may live in a browser cache. Everything unlisted is not cached. */
export function cacheControlFor(requestPath: string): string {
  if (
    requestPath === "/" ||
    requestPath === "/index.html" ||
    requestPath === "/sw.js" ||
    requestPath === "/manifest.webmanifest" ||
    requestPath.startsWith("/style.css")
  ) {
    return "no-cache";
  }
  if (requestPath.startsWith("/vendor/") || requestPath.startsWith("/icons/")) {
    return "public, max-age=3600";
  }
  return "no-cache";
}

/** The filesystem calls the static surface makes. Injected only by tests, so
 * a test can prove the containment check runs before anything stats or opens
 * the target; production always uses the real filesystem. */
export interface StaticFileSystem {
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<Stats>;
  access: (path: string, mode?: number) => Promise<void>;
  readFile: (path: string) => Promise<Buffer>;
}

const REAL_FS: StaticFileSystem = { realpath, stat, access: fsAccess, readFile };

export interface StaticOptions {
  /** Absolute path of the directory whose root is served. Default: `web/`. */
  root?: string;
  /** Lowercased, query-stripped request paths that are never static. */
  reserved?: readonly string[];
  /** Filesystem seam, injected only by tests. Default: the real filesystem. */
  fs?: StaticFileSystem;
}

export interface StaticResponse {
  status: number;
  headers: Record<string, string>;
  body?: Buffer;
}

export type StaticResult = { served: true; response: StaticResponse } | { served: false };

function defaultRoot(): string {
  // The web/ directory always sits next to src/ in this checkout, whether on
  // the machine or deployed by a tag; there is no build step that could
  // separate them.
  return resolve(import.meta.dirname, "..", "..", "web");
}

interface NormalizedPath {
  key: string;
  /** `/`-joined, percent-decoded segments without leading slash. */
  segments: readonly string[];
}

/** Turn a raw request target into either a safe directory-relative key or
 * `undefined`. Anything ambiguous is refused, never "attempted anyway". */
export function normalizeRequestPath(requestPath: string): NormalizedPath | undefined {
  if (!requestPath.startsWith("/")) return undefined;

  // Only the path owns the resource; a query string is never part of a file.
  const question = requestPath.indexOf("?");
  const pathPart = question === -1 ? requestPath : requestPath.slice(0, question);
  if (pathPart.length === 0) return undefined;

  // The key is lowercased so the cache-control rules stay predictable; the
  // real filename keeps its case below.
  const key = pathPart.toLowerCase();

  const decodedSegments: string[] = [];
  for (const rawSegment of pathPart.split("/")) {
    if (rawSegment === "") continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return undefined; // malformed escape — refuse, do not guess
    }
    if (decoded === "") return undefined;
    if (decoded.includes("\\") || decoded.includes("\0")) return undefined;
    if (decoded === "." || decoded === "..") return undefined;
    if (decoded.startsWith(".")) return undefined; // dotfiles are never served
    decodedSegments.push(decoded);
  }
  return { key, segments: decodedSegments };
}

function mimeFor(fileName: string): Mime {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return DEFAULT_MIME;
  return MIME_TYPES[fileName.slice(dot).toLowerCase()] ?? DEFAULT_MIME;
}

/** Resistor: the classic traversal tricks, as raw request targets. Percent
 * escapes are case-insensitive (`%2E` is `%2e` is `.`), so the target is
 * lowercased before they are expanded — otherwise an uppercase escape walks
 * past this layer. It is a cheap pre-filter; the decoded-segment walk in
 * `normalizeRequestPath` and the realpath containment check below are the
 * layers that actually decide, so refusing here is defence in depth. */
export function looksLikeTraversal(requestPath: string): boolean {
  const lowered = requestPath.toLowerCase();
  const unescaped = lowered.replaceAll("%2e", ".").replaceAll("%2f", "/").replaceAll("%5c", "\\");
  return unescaped.includes("..") || lowered.includes("\\") || lowered.includes("%00");
}

const rootRealpaths = new Map<string, string>();

async function rootRealpath(root: string, fs: StaticFileSystem): Promise<string> {
  // The cache belongs to the real filesystem; an injected one (tests) is never
  // cached, so a spy sees every call.
  if (fs !== REAL_FS) return fs.realpath(root);
  const cached = rootRealpaths.get(root);
  if (cached) return cached;
  const real = await fs.realpath(root);
  if (rootRealpaths.size > 16) rootRealpaths.clear();
  rootRealpaths.set(root, real);
  return real;
}

export function isReservedPath(requestPath: string, reserved?: readonly string[]): boolean {
  const list = reserved ?? [...RESERVED_PREFIXES, ...RESERVED_PATHS];
  return list.some((entry) => requestPath === entry || requestPath.startsWith(entry));
}

/** Resolve a request target against `root`. Returns `undefined` when the
 * request is not the static surface's business or escapes the root. */
export async function resolveStatic(
  method: string,
  requestPath: string,
  options: StaticOptions = {},
): Promise<StaticResult> {
  const root = options.root ?? defaultRoot();
  const fs = options.fs ?? REAL_FS;
  if (method !== "GET" && method !== "HEAD") return { served: false };
  if (isReservedPath(requestPath, options.reserved)) return { served: false };
  if (looksLikeTraversal(requestPath)) return { served: false };

  const normalized = normalizeRequestPath(requestPath);
  if (!normalized) return { served: false };

  const segments = normalized.segments;
  const target = segments.length === 0 ? join(root, "index.html") : join(root, ...segments);

  // Pin the final answer to the root's own identity *first*: a symlink anywhere
  // in or under the root, or a segment that decoded to an embedded slash plus
  // `..`, cannot point outside it. Doing this before `stat`/`access` also keeps
  // the handler from probing an out-of-root path for existence or readability —
  // the containment check, not a rejected stat, is what refuses the request.
  let filePath: string;
  try {
    const [rootReal, fileReal] = await Promise.all([
      rootRealpath(root, fs),
      fs.realpath(target),
    ]);
    if (fileReal !== rootReal && !fileReal.startsWith(rootReal + sep)) {
      return { served: false };
    }
    filePath = fileReal;
  } catch {
    return { served: false };
  }

  let stats: Stats;
  try {
    stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      // A directory request (e.g. `/vendor/`) is not a shell asset; the HTTP
      // layer decides what non-static paths mean.
      return { served: false };
    }
    // May the process read it at all — after believing the stat is contained.
    await fs.access(filePath, fsConstants.R_OK);
  } catch {
    return { served: false };
  }

  const body = await fs.readFile(filePath).catch(() => undefined);
  if (!body) return { served: false };

  const originalName = segments.length === 0 ? "index.html" : segments[segments.length - 1]!;
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "Content-Type": mimeFor(originalName),
    "Content-Length": String(body.byteLength),
    "Cache-Control": cacheControlFor(normalized.key),
  };

  return {
    served: true,
    response: {
      status: 200,
      headers,
      body: method === "HEAD" ? undefined : body,
    },
  };
}

/** Try to answer a request entirely from the static surface. Returns whether
 * it took the response; when it did not, the HTTP layer's routing must run. */
export async function serveStaticRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: StaticOptions = {},
): Promise<boolean> {
  const result = await resolveStatic(req.method ?? "GET", requestPathOf(req), options);
  if (!result.served) return false;
  const { response } = result;
  res.statusCode = response.status;
  for (const [name, value] of Object.entries(response.headers)) {
    res.setHeader(name, value);
  }
  res.end(response.body);
  return true;
}

/** The pathname of a request target, query string and fragment removed. */
export function requestPathOf(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const question = url.indexOf("?");
  const hash = url.indexOf("#");
  let pathPart = hash === -1 ? url : url.slice(0, hash);
  if (question !== -1) pathPart = pathPart.slice(0, question);
  return pathPart.length === 0 ? "/" : pathPart;
}

/** Set the security headers on any response. Safe to call after other header
 * writes set the same names (setHeader replaces, so there are never two CSP
 * or two nosniff values). */
export function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}
