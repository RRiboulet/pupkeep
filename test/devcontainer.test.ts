// Static guards for the devcontainer. Building a container in CI is a separate
// concern; these tests catch the mistakes that are cheap to make and expensive
// to notice later — a base tag that moved off Node 24, a pi version that drifted
// from 1.4.0, a tool missing from the apt layer, a postCreate that re-declares
// the shared package in the repo, or a dev database pointed at the 9p mount.

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): Promise<string> => readFile(join(ROOT, path), "utf8");

interface Devcontainer {
  dockerComposeFile?: unknown;
  service?: unknown;
  workspaceFolder?: unknown;
  postCreateCommand?: unknown;
  forwardPorts?: unknown;
  containerEnv?: Record<string, unknown>;
  features?: Record<string, unknown>;
  remoteUser?: unknown;
}

test("devcontainer.json targets the repo mount, forwards 8787 and runs postCreate", async () => {
  const config = JSON.parse(await read(".devcontainer/devcontainer.json")) as Devcontainer;
  assert.equal(config.dockerComposeFile, "docker-compose.yml");
  assert.equal(config.service, "devcontainer");
  assert.equal(config.workspaceFolder, "/workspace");
  assert.equal(config.remoteUser, "vscode");
  assert.equal(config.postCreateCommand, "bash .devcontainer/postCreate.sh");
  assert.deepEqual(config.forwardPorts, [8787]);
  assert.equal(config.containerEnv?.PUPKEEP_DATA_DIR, "/tmp/pupkeep-dev");
  assert.equal(config.containerEnv?.PUPKEEP_PORT, "8787");
  assert.equal(config.containerEnv?.PUPKEEP_ACCESS, "local");

  const features = Object.keys(config.features ?? {});
  assert.ok(features.some((feature) => feature.includes("common-utils")));
  assert.ok(features.some((feature) => feature.includes("github-cli")));
});

test("compose mounts the repo and a persistent, explicitly named pi-config volume", async () => {
  const compose = await read(".devcontainer/docker-compose.yml");
  assert.match(compose, /context: \.\./);
  assert.match(compose, /dockerfile: \.devcontainer\/Dockerfile/);
  assert.match(compose, /\.\.:\/workspace:cached/);
  assert.match(compose, /pupkeep-pi-config:\/home\/vscode\/\.pi/);
  assert.match(compose, /name: pupkeep-pi-config/);
  assert.match(compose, /user: vscode/);
});

test("the image is the Node 24 base with the pinned pi and host tools", async () => {
  const dockerfile = await read(".devcontainer/Dockerfile");
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/devcontainers\/javascript-node:24-bookworm$/m);
  assert.match(dockerfile, /test "\$\(node --version \| cut -d\. -f1\)" = "v24"/);

  assert.match(dockerfile, /@earendil-works\/pi-coding-agent@1\.4\.0/);
  assert.match(dockerfile, /test "\$\(pi --version\)" = "1\.4\.0"/);

  assert.match(dockerfile, /CLOUDFLARED_VERSION=2026\.10\.5/);
  assert.match(dockerfile, /CLOUDFLARED_SHA256=149d1ec4ac8e58bdbf08a41cc42347da9184d9fb4ef0df6528d75c90a85ac0ed/);
  assert.match(dockerfile, /cloudflared-linux-amd64\.deb/);
  assert.match(dockerfile, /sha256sum -c -/);

  const apt = /apt-get install -y --no-install-recommends([\s\S]*?)&& rm -rf \/var\/lib\/apt\/lists/.exec(
    dockerfile,
  );
  assert.ok(apt, "the apt install block must be present");
  for (const tool of [
    "age",
    "curl",
    "expect",
    "git",
    "jq",
    "openssl",
    "rclone",
    "ripgrep",
    "sqlite3",
    "sudo",
    "tar",
    "tmux",
    "unzip",
  ]) {
    assert.match(apt[1]!, new RegExp(`\\b${tool}\\b`), `${tool} is missing from the image`);
  }
  assert.doesNotMatch(apt[1]!, /android|openjdk|gradle|sdkmanager/i, "no Android/JDK/Gradle belongs in this image");

  assert.match(dockerfile, /git config --system credential\.https:\/\/github\.com\.helper/);
  assert.match(dockerfile, /USER vscode/);
  assert.match(dockerfile, /WORKDIR \/workspace/);
});

test("postCreate seeds .env, runs the suite, checks versions and installs the shared package personally", async () => {
  const path = join(ROOT, ".devcontainer/postCreate.sh");
  const script = await readFile(path, "utf8");
  const info = await stat(path);
  assert.notEqual(info.mode & 0o111, 0, "postCreate.sh must be executable");

  assert.match(script, /if \[ ! -f \.env \]; then/);
  assert.match(script, /cp \.env\.example \.env/);
  assert.match(script, /npm ci/);
  assert.match(script, /npm run typecheck/);
  assert.match(script, /npm test/);
  assert.match(script, /chmod 700 \/tmp\/pupkeep-dev/);

  assert.match(script, /if \[ "\$node_major" != "v24" \]/);
  assert.match(script, /if \[ "\$pi_version" != "1\.4\.0" \]/);
  assert.match(script, /cloudflared 2026\.10\.5/);
  for (const tool of ["age", "expect", "gh", "jq", "openssl", "rclone", "rg", "sqlite3", "tar", "tmux"]) {
    assert.match(script, new RegExp(`\\b${tool}\\b`), `postCreate does not check ${tool}`);
  }

  // The shared package goes into the personal pi settings in the volume, never
  // the repo's .pi/settings.json — that is the duplicate-package failure the
  // P1-05 guard pins from the other side.
  assert.match(script, /SHARED_PACKAGE_REF=.*v1\.9\.0/);
  assert.match(script, /pi install "git:github\.com\/RRiboulet\/my-agent-setup@\$\{SHARED_PACKAGE_REF\}"/);
  assert.doesNotMatch(script, /pi install[^\n]*--local/);
  assert.doesNotMatch(script, />>?\s*\.pi\/settings\.json/);
});

test("the dev environment keeps its database off the workspace mount", async () => {
  const env = await read(".env.example");
  assert.match(env, /^PUPKEEP_DATA_DIR=\/tmp\/pupkeep-dev$/m);
  assert.match(env, /^PUPKEEP_PORT=8787$/m);
  assert.match(env, /^PUPKEEP_ACCESS=local$/m);
});

test("the build context excludes secrets, dependencies and local data", async () => {
  const dockerignore = await read(".dockerignore");
  for (const entry of [".env", ".git", "node_modules", "data", "*.sqlite", ".pi/todos"]) {
    assert.match(dockerignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
});

test("the pi-config volume is documented without turning into a package declaration", async () => {
  const readme = await read(".devcontainer/pi/README.md");
  assert.match(readme, /pupkeep-pi-config/);
  assert.match(readme, /personal.*settings/);
  assert.match(readme, /not.*declare|duplicate|twice/i);
});
