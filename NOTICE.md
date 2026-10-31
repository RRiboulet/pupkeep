# Upstream projects and attribution

Pupkeep plans to reuse or adapt host infrastructure from these MIT-licensed
projects. The plan is to keep their copyright notices and licence texts beside
any copied code, and to record the exact files and commits in this file when
code is copied.

## Pi Pocket

- Repository: <https://github.com/TannerMidd/pi-pocket>
- Package version `0.26.0`; audited commit is two commits after the `v0.26.0` tag.
- Licence: MIT, copyright (c) 2026 Tanner Middleton
- Commit audited: `e984c60b4060ba5c5856a2d3413d6d6d6e0eb522`
  (`v0.26.0-2-ge984c60`, package `0.26.0`).
- Audited reuse/adaptation: `src/server/lock.ts`, `src/server/push.ts`,
  `web/sw.js` and `src/launcher/access.ts` near-direct; adapt
  `src/server/auth.ts`, `src/server/config.ts`, `web/notify.js` and the
  `web/index.html` import-map/vendor pattern. The audit and deviations are in
  `docs/spikes/P0-02-pi-pocket-reuse.md`.
- Not reused: the coding-agent domain (sessions, files, subagents, browser,
  design mode, extensions, update system).

## Pi Durable / Pi AI / Chord

- Repository: <https://github.com/earendil-works/pi>
- Version checked: `1.4.0`
- Licence: MIT, Earendil Works
- Use: durable harness, conversations, tasks, tools, documents, SQLite storage,
  model access.

## Pi coding agent

- Package: `@earendil-works/pi-coding-agent@1.4.0`
- Licence: MIT
- Use: development environment only. The phone runtime does not need the coding
  agent; it uses Pi Durable and Pi AI directly.

## Termux

- Website: <https://termux.dev/>
- Licence: GPL-3.0 (the runtime is installed by the user from F-Droid; Pupkeep
  does not redistribute Termux binaries)
- Use: the Node/SQLite runtime on the host phone.

## Preact, htm, marked and DOMPurify

- Preact: MIT, <https://preactjs.com/>
- htm: Apache-2.0, <https://github.com/developit/htm>
- marked: MIT, <https://github.com/markedjs/marked>
- DOMPurify: Apache-2.0 / MPL-2.0, <https://github.com/cure53/DOMPurify>
- Use: no-build browser UI and safe Markdown rendering, with the licence
  notices and pinned versions/checksums kept when the vendor files are added.

### Vendored browser files (committed, not npm dependencies)

These live in `web/vendor/` byte-for-byte from the published tarballs and are
**not** server runtime dependencies. `test/vendor.test.ts` recomputes the
checksums below and fails if a file changes without its line here changing too —
that is the whole point of vendoring them.

| File | Package | Version | SHA-256 |
|---|---|---|---|
| `web/vendor/preact.mjs` | `preact` (dist/preact.mjs) | `11.1.0` | `25288b8d9d60f7885df6c487a813a495e98c9addbeaf7c0e8f59683c71d426b5` |
| `web/vendor/preact-hooks.mjs` | `preact` (hooks/dist/hooks.mjs) | `11.1.0` | `24231102dc3e509c9c657bca591524e348eb8a5272c9d40538faef9beeeb654c` |
| `web/vendor/htm.mjs` | `htm` (dist/htm.mjs) | `3.1.1` | `ab33dd3f38059b9be4d5f5350128eefb2356639c4e0bbe9d9e8b3ba75847e9e4` |
| `web/vendor/htm-preact.mjs` | `htm` (preact/index.module.js) | `3.1.1` | `b3f51db71c12eabba61819feb74ace7cadc2744af41866c3fcad2ab960415746` |

The two files that import bare `preact` / `htm` specifiers
(`preact-hooks.mjs`, `htm-preact.mjs`) are unmodified and stay pinned for a
future import map: the shell imports `preact.mjs` and `htm.mjs` relatively,
serves no import map and does not load the two bare-specifier builds (P1-10), so
their checksums stay honest instead of an edited copy nobody can diff against
upstream.

## Cloudflare Tunnel

- Service: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
- Terms apply. The tunnel client and Zero Trust free tier are used as a service,
  not vendored.
