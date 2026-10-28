# Upstream projects and attribution

Pupkeep plans to reuse or adapt host infrastructure from these MIT-licensed
projects. The plan is to keep their copyright notices and licence texts beside
any copied code, and to record the exact files and commits in this file when the
code lands.

## Pi Pocket

- Repository: <https://github.com/TannerMidd/pi-pocket>
- Version checked: `0.26.0`
- Licence: MIT, copyright (c) Tanner Middleton
- Planned reuse/adaptation: launcher access modes (`local`, `lan`, `cloudflare`,
  `tailscale`), server/tunnel supervision, owner-token and invite auth, Web Push
  (RFC 8291/8292) and service-worker patterns, process lock, and the no-build
  Preact/htm web structure.
- Not reused: the coding-agent domain (sessions, files, subagents, browser,
  design mode).

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

## Preact and htm

- Preact: MIT, <https://preactjs.com/>
- htm: Apache-2.0, <https://github.com/developit/htm>
- Use: no-build browser UI, with the licence notices kept when the vendor files
  are added.

## Cloudflare Tunnel

- Service: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
- Terms apply. The tunnel client and Zero Trust free tier are used as a service,
  not vendored.
