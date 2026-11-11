// P1-12: the application CI gate is an invariant of its own. `devcontainer.yml`
// is a path-filtered image-build proof; this workflow is the one that must run
// on every pull request, whatever the change touches.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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

test("CI installs the browser the render checks drive, so they cannot silently skip", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  // `test/browser-render.test.ts` skips when no Chromium is present, which keeps
  // a fresh container green. That makes this step the only thing standing
  // between the layout gate and a permanently skipped suite (P5-10), so the
  // workflow may not lose it.
  assert.match(
    workflow,
    /^\s+- name: .*\n\s+run: npx playwright install --with-deps chromium$/m,
    "the render checks need CI to install the browser before `npm test`",
  );
  // …and it has to run before the suite, or it installs a browser nobody uses.
  const install = workflow.indexOf("npx playwright install");
  const suite = workflow.indexOf("run: npm test");
  assert.ok(install !== -1 && suite !== -1 && install < suite, "the install must precede the test step");
});

test("npm test is the Node test runner over the suite files, so CI runs the same suite as local work", async () => {
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts: Record<string, string>;
  };
  // The runner is Node's own, and the patterns cover every `*.test.*` file in
  // `test/` recursively. The support helpers (`test/support/`) are deliberately
  // not tests: Node's directory-wide default would run them as one empty
  // passing file. A pattern that matches nothing is a *green zero-test* run, so
  // the discovery invariant below is what keeps a renamed or moved suite from
  // silently dropping out.
  assert.equal(manifest.scripts.test, 'node --test "test/**/*.test.ts" "test/**/*.test.js"');
  assert.equal(manifest.scripts.typecheck, "tsc --noEmit");

  const testFiles = (
    await readdir(new URL("../test", import.meta.url), { recursive: true, withFileTypes: true })
  ).filter((entry) => entry.isFile() && entry.name.includes(".test."));
  assert.ok(testFiles.length > 20, "the suite is discovered at all");
  for (const file of testFiles) {
    assert.match(
      file.name,
      /\.test\.(ts|js)$/,
      `${file.name} must be named *.test.ts or *.test.js so the npm test patterns discover it`,
    );
  }
});
