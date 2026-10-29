#!/usr/bin/env node
// Entry point for `npm start`. The real launcher is P1-04: access modes, bind
// addresses, the server child, restart/backoff, the tunnel supervisor and the
// owner link. Until it lands this fails with an explanation instead of a stack
// trace, so nobody mistakes a missing launcher for a broken install.

console.error(
  [
    "pupkeep launcher is not implemented yet (task P1-04).",
    "",
    "Phase 1 order: P1-02 devcontainer, P1-03 dependencies (done), then P1-04",
    "launcher and P1-05 data directory. See docs/PLAN.md §16.",
  ].join("\n"),
);
process.exit(1);
