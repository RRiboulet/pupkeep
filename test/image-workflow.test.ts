// Phase 6, R11: the deployment image is built by its own workflow, and its
// invariants are pinned here because a tag push is the only thing in this
// repository that writes to a container registry. The spec calls this test
// `test/ci.test.ts`'s sibling (R12); like that one, it reads the YAML as text
// rather than executing it — a hosted runner is the only place a workflow can
// actually run, and the plan lists that run as a host-side check.
//
// The reading style is deliberately literal: `assert.match` against the lines
// that carry the guarantee, so a change that loosens the guarantee fails here
// with the line it changed.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const imagePath = new URL("../.github/workflows/image.yml", import.meta.url);
const ciPath = new URL("../.github/workflows/ci.yml", import.meta.url);

/**
 * The file with its full-line comments dropped. Every assertion below pins a
 * *declaration*, and prose is allowed to name the thing it forbids — a comment
 * saying "there is no `pull_request_target` here" must not satisfy, or trip,
 * the check that there is none.
 */
function declarations(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * The body of a YAML block whose header line is exactly `header` (indentation
 * included, so the top-level `permissions:` and the job-level one are told
 * apart), with each body line trimmed. Throws when the header is absent, which
 * is what makes "the workflow must declare this" assertions cheap.
 */
function block(yaml: string, header: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.indexOf(header);
  assert.notEqual(start, -1, `expected a "${header}" line`);
  const indent = header.length - header.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent) break;
    body.push(line.trim());
  }
  return body;
}

test("the image builds on every pull request and pushes only from a version tag", async () => {
  const workflow = declarations(await readFile(imagePath, "utf8"));

  // `pull_request` with no path filter: a Dockerfile change and a docs-only
  // change both have to prove the image still builds, so a `paths:` filter here
  // would be the way this gate quietly stops covering what it claims.
  assert.match(workflow, /^on:\n  pull_request:\n/m);
  assert.doesNotMatch(workflow, /^\s+paths:/m, "the image build must not be path-filtered");
  assert.doesNotMatch(workflow, /^\s+paths-ignore:/m);

  // The `push` trigger is tags only — no branch pushes, so an ordinary merge to
  // `main` cannot publish an image — and the tag pattern is the version line.
  assert.match(workflow, /^  push:\n    tags:\n      - "v\*"$/m);
  assert.doesNotMatch(workflow, /^\s+branches:/m, "no trigger may be filtered to one branch");
  // A manual run is a build probe: the push inputs below are gated on the ref,
  // so a dispatch publishes nothing.
  assert.match(workflow, /^  workflow_dispatch:$/m);

  // `pull_request_target` runs with the base repo's token and secrets against a
  // fork's code. It must never appear — this workflow needs no such privilege
  // and is only safe because it does not have it.
  assert.doesNotMatch(workflow, /pull_request_target/);

  // The registry write is reachable only from a tag: `github.ref_type` is `tag`
  // for a tag push and never for `pull_request` or `workflow_dispatch`.
  assert.match(workflow, /^\s+push: \$\{\{ github\.ref_type == 'tag' \}\}$/m);
  assert.match(
    workflow,
    /^      - name: Log in to GHCR \(tag pushes only\)\n        if: github\.ref_type == 'tag'\n        uses: docker\/login-action@v3$/m,
    "the registry login must be gated on a tag, or a fork PR would fail trying to authenticate",
  );
  // The build must not be able to run before the checkout, and the checkout
  // before the build: an image built from an empty context is the failure this
  // pins.
  assert.ok(workflow.indexOf("actions/checkout") < workflow.indexOf("docker/build-push-action"));
});

test("the tags come from the git ref: a semver tag plus sha-<short>", async () => {
  const workflow = declarations(await readFile(imagePath, "utf8"));

  // `v0.1.1` pushes `0.1.1`, which is the reference `docker-compose.yml` names;
  // hand-written tag strings drift from the release tag, derived ones cannot.
  assert.match(
    workflow,
    /^\s+tags: \|\n\s+type=semver,pattern=\{\{version\}\}\n\s+type=sha$/m,
    "the pushed tags are the ref's semver version plus a sha- short tag",
  );
  // The reference is lower-cased before it is used: GHCR rejects an upper-case
  // repository name, `github.repository` keeps the owner's spelling
  // (`RRiboulet/pupkeep`), and `docker-compose.yml` names the lower-case path.
  // Pushing anywhere else publishes a package the compose file cannot pull.
  assert.ok(
    workflow.includes('echo "ref=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_OUTPUT"'),
    "the image reference must be lower-cased, or the push is rejected/mismatched",
  );
  assert.match(workflow, /^\s+images: \$\{\{ steps\.image\.outputs\.ref \}\}$/m);
  assert.doesNotMatch(workflow, /ghcr\.io\/\$\{\{ github\.repository \}\}/);
});

test("the image is built for linux/arm64 and the pushed manifest is proven arm64", async () => {
  const workflow = declarations(await readFile(imagePath, "utf8"));

  // The host is an Oracle A1 (arm64) and every hosted runner is amd64, so the
  // platform is an explicit input and QEMU is what makes the arm64 steps run.
  assert.match(workflow, /^\s+platforms: linux\/arm64$/m);
  assert.match(workflow, /uses: docker\/setup-qemu-action@v3/);
  assert.match(workflow, /^\s+platforms: arm64$/m);
  assert.match(workflow, /uses: docker\/setup-buildx-action@v3/);

  // R11 says the *pushed manifest* is arm64, so the workflow checks the
  // registry's answer instead of trusting the input above: pull the tag back by
  // name and assert the platform Docker resolved.
  assert.match(workflow, /docker pull --platform linux\/arm64 "\$ref"/);
  assert.match(workflow, /test "\$arch" = "linux\/arm64"/);
  assert.match(workflow, /docker image inspect --format '\{\{\.Os\}\}\/\{\{\.Architecture\}\}'/);
  // …and only on a tag: on a pull request nothing was pushed, so a pull there
  // would fail a build that is otherwise doing exactly what it should.
  assert.match(
    workflow,
    /^      - name: Prove the pushed image is linux\/arm64\n        if: github\.ref_type == 'tag'$/m,
    "the arm64 verification must be gated on a tag push",
  );
});

test("the image job is least-privilege: read at the top, packages: write on the job only", async () => {
  const workflow = declarations(await readFile(imagePath, "utf8"));

  // Top level: the checkout and nothing else. A `packages: write` here would be
  // inherited by every job the file ever grows.
  assert.deepEqual(block(workflow, "permissions:"), ["contents: read"]);

  // Job level: exactly the two R11 names. Provenance comes from buildx
  // (`provenance: mode=max`), which needs no token scope of its own; the
  // `actions/attest-build-provenance` alternative would need `id-token: write`
  // and `attestations: write`, and that widening is what this assertion
  // refuses. If provenance is ever switched to that action, the permissions
  // change belongs in the same diff as this test.
  assert.deepEqual(block(workflow, "    permissions:"), ["contents: read", "packages: write"]);
  assert.match(workflow, /^\s+provenance: mode=max$/m);
  assert.doesNotMatch(workflow, /id-token/);
  assert.doesNotMatch(workflow, /attest-build-provenance/);
  assert.doesNotMatch(workflow, /attestations:/);

  // One run per ref, and a superseded run is cancelled: two tag pushes racing
  // would otherwise interleave their pushes to the same two tags.
  assert.match(
    workflow,
    /^concurrency:\n  group: image-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m,
  );
});

test("a pull request reads the build cache but never writes it", async () => {
  const workflow = declarations(await readFile(imagePath, "utf8"));

  // The GHA cache is what makes the emulated `npm ci` affordable on every PR.
  assert.match(workflow, /^\s+cache-from: type=gha$/m);
  // …but only a tag push may export it. A fork's PR restoring layers is fine;
  // a fork's PR *writing* the cache an authenticated push later builds from is
  // the poisoning path, and the gate removes it rather than relying on cache
  // scoping alone.
  assert.ok(
    workflow.includes("cache-to: ${{ github.ref_type == 'tag' && 'type=gha,mode=max' || '' }}"),
    "cache-to must be gated on a tag so a pull request cannot export cache",
  );
});

test("ci.yml still declares exactly contents: read, so the PR gate grants nothing extra", async () => {
  const ci = declarations(await readFile(ciPath, "utf8"));

  // `test/ci.test.ts` pins the same string; this is the counterweight to the
  // image workflow above — the privileged job must not leak into the gate that
  // every pull request runs. Exactly one `permissions:` in the file means there
  // is no job-level block that could widen it.
  assert.deepEqual(block(ci, "permissions:"), ["contents: read"]);
  assert.equal(
    (ci.match(/^\s*permissions:$/gm) ?? []).length,
    1,
    "ci.yml must have a single, top-level permissions block",
  );
  assert.doesNotMatch(ci, /packages: write|id-token|attestations:|pull_request_target/);
});
