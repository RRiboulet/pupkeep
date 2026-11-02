// P1-12: the application CI gate is an invariant of its own. `devcontainer.yml`
// is a path-filtered image-build proof; this workflow is the one that must run
// on every pull request, whatever the change touches.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

test("application CI typechecks and runs the test suite on every pull request", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  // A `pull_request` trigger with no path filter: a docs-only or route-only
  // change still runs the suite that covers it.
  assert.match(workflow, /^on:\n(?:  .*\n)*?  pull_request:\n/m);
  assert.doesNotMatch(workflow, /paths:/, "the PR gate must not be path-filtered");
  assert.match(workflow, /^\s+run: npm ci$/m);
  assert.match(workflow, /^\s+run: npm run typecheck$/m);
  assert.match(workflow, /^\s+run: npm test$/m);
  // The devcontainer's Node line (PLAN §5.1); the phone's Node 26 is re-measured
  // by P5-01 before a second matrix leg joins.
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /^\s+permissions:\n\s+contents: read$/m);
});

test("npm test is the Node test runner, so CI runs the same suite as local work", async () => {
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(manifest.scripts.test, "node --test");
  assert.equal(manifest.scripts.typecheck, "tsc --noEmit");
});
