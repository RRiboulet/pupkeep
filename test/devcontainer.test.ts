// Static guards for the devcontainer. Building a container in CI is a separate
// concern; these tests catch the mistakes that are cheap to make and expensive
// to notice later — a base tag that moved off Node 24, a pi version that drifted
// from 1.4.0, a tool missing from the apt layer, a postCreate that re-declares
// the shared package in the repo, or a dev database pointed at the 9p mount.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  // Docker publishes to the container's own interface, never its loopback, so
  // the in-container server has to bind every interface for the published port
  // to work. The publish itself is host-loopback only (tested below), which is
  // what keeps the wider bind inside the container's private namespace.
  assert.equal(config.containerEnv?.PUPKEEP_ACCESS, "lan");

  const features = Object.entries(config.features ?? {});
  assert.ok(features.some(([feature]) => feature.includes("common-utils")));
  const githubCli = features.find(([feature]) => feature.includes("github-cli"))?.[1] as
    | { version?: unknown }
    | undefined;
  assert.equal(githubCli?.version, "2.103.2", "gh is pinned, not left to the feature's latest");
  const commonUtils = features.find(([feature]) => feature.includes("common-utils"))?.[1] as
    | { username?: unknown }
    | undefined;
  assert.equal(
    commonUtils?.username,
    "vscode",
    "the feature must name the user the image renames, or it creates a second one on 1001",
  );
});

test("compose mounts the repo and a persistent, explicitly named pi-config volume", async () => {
  const compose = await read(".devcontainer/docker-compose.yml");
  assert.match(compose, /context: \.\./);
  assert.match(compose, /dockerfile: \.devcontainer\/Dockerfile/);
  assert.match(compose, /\.\.:\/workspace:cached/);
  assert.match(compose, /pupkeep-pi-config:\/home\/vscode\/\.pi/);
  assert.match(compose, /name: pupkeep-pi-config/);
  assert.match(compose, /user: vscode/);

  // Headless clients (the Dev Containers CLI, `docker compose`) never apply
  // devcontainer.json's `forwardPorts` — that is a VS Code client feature. The
  // port has to be published by Compose, and only on the host's loopback.
  assert.match(compose, /- "127\.0\.0\.1:8787:8787"/);
  assert.doesNotMatch(compose, /"0\.0\.0\.0:8787:8787"/, "8787 must never be published on every host interface");
});

test("the image is the Node 24 base with the pinned pi and host tools", async () => {
  const dockerfile = await read(".devcontainer/Dockerfile");
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/devcontainers\/javascript-node:24-bookworm$/m);
  assert.match(dockerfile, /test "\$\(node --version \| cut -d\. -f1\)" = "v24"/);

  assert.match(dockerfile, /@earendil-works\/pi-coding-agent@1\.4\.0/);
  assert.match(dockerfile, /test "\$\(pi --version\)" = "1\.4\.0"/);

  assert.match(dockerfile, /CLOUDFLARED_VERSION=2026\.10\.5/);
  // Cloudflare publishes a `.deb` per architecture and no shared manifest, so
  // each one carries its own SHA-256. A single checksum cannot describe both.
  assert.match(dockerfile, /CLOUDFLARED_SHA256_AMD64=149d1ec4ac8e58bdbf08a41cc42347da9184d9fb4ef0df6528d75c90a85ac0ed/);
  assert.match(dockerfile, /CLOUDFLARED_SHA256_ARM64=361584f9c6a1af6f9c553011291494b72fb6c887841ce6735dc6df8b6e727e72/);
  // The download must be architecture-selected, not hardcoded to one build.
  assert.match(dockerfile, /cloudflared-linux-\$\{arch\}\.deb/);
  assert.doesNotMatch(dockerfile, /cloudflared-linux-amd64\.deb/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /dpkg --print-architecture/, "the arch guard must not no-op without TARGETARCH");
  // Each allowed architecture must map to its own checksum, and an unknown one
  // must fail before dpkg sees a package for the wrong platform.
  assert.match(dockerfile, /amd64\) sha="\$\{CLOUDFLARED_SHA256_AMD64\}"/);
  assert.match(dockerfile, /arm64\) sha="\$\{CLOUDFLARED_SHA256_ARM64\}"/);
  assert.match(dockerfile, /amd64\|arm64\)/, "the guard must accept both supported architectures");

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
  assert.match(dockerfile, /WORKDIR \/workspace/);
});

test("the image renames the base uid-1000 user to vscode, so its home is writable before postCreate", async () => {
  const dockerfile = await read(".devcontainer/Dockerfile");

  // The base image ships uid/gid 1000 as `node`. common-utils cannot put a
  // second user on that uid, and `useradd -m` leaves a home directory that
  // already exists alone — so a /home/vscode created here as root stays
  // root-owned, and VS Code installs ~/.vscode-server as `vscode` *before*
  // postCreate runs. Repairing the home there is always too late.
  assert.match(dockerfile, /groupmod --new-name vscode node/);
  assert.match(dockerfile, /usermod --login vscode --home \/home\/vscode --move-home node/);

  // The invariant, enforced by the image rather than assumed: uid 1000 and a
  // home that user owns. The order of the rename and the `mkdir` further down
  // is not pinned here because the build enforces it — `usermod --move-home`
  // exits 12 when the new home already exists.
  assert.match(dockerfile, /test "\$\(id -u vscode\)" = "1000"/);
  assert.match(dockerfile, /test "\$\(stat -c %u:%g \/home\/vscode\)" = "1000:1000"/);

  // The base image's sudoers entry names `node`; write one that survives the
  // rename so a `sudo` run does not depend on the feature re-writing it. A
  // drop-in that is not 0440 is ignored by sudo, so the mode is pinned too.
  assert.match(dockerfile, /NOPASSWD:ALL' > \/etc\/sudoers\.d\/vscode/);
  assert.match(dockerfile, /chmod 0440 \/etc\/sudoers\.d\/vscode/);
  assert.match(dockerfile, /rm -f \/etc\/sudoers\.d\/node/);

  // Whatever the image creates in the home belongs to vscode, so a fresh volume
  // copies up writable.
  assert.match(dockerfile, /chown -R vscode:vscode \/home\/vscode\/\.pi/);

  // Still root: the layers install system-wide and postCreate runs `sudo git
  // config --system`. `remoteUser` and Compose's `user:` decide who connects.
  assert.doesNotMatch(dockerfile, /^USER vscode$/m);
});

test("postCreate seeds .env, runs the suite, checks versions and installs the shared package personally", async () => {
  const script = await read(".devcontainer/postCreate.sh");

  assert.match(script, /if \[ ! -f \.env \]; then/);
  assert.match(script, /cp \.env\.example \.env/);
  assert.match(script, /chmod 600 \.env/);
  assert.match(script, /npm ci/);
  assert.match(script, /npm run typecheck/);
  assert.match(script, /npm test/);
  assert.match(script, /chmod 700 \/tmp\/pupkeep-dev/);
  // The home belongs to vscode from the image on; only the named volume can
  // still arrive root-owned, and that is what postCreate repairs. It must not
  // go back to repairing the home wholesale: postCreate runs after VS Code
  // needs ~/.vscode-server, which is how this create failed.
  assert.match(script, /sudo chown -R vscode:vscode \/home\/vscode\/\.pi/);
  assert.doesNotMatch(script, /chown -R vscode:vscode \/home\/vscode[ \t]+\/tmp/);

  assert.match(script, /node_major/);
  assert.match(script, /v24/);
  assert.match(script, /pi_version/);
  assert.match(script, /1\.4\.0/);
  assert.match(script, /gh 2\.103\.2 is required/);
  assert.match(script, /cloudflared 2026\.10\.5/);
  assert.match(script, /git config --global user\.email/);
  for (const tool of ["age", "expect", "gh", "jq", "openssl", "rclone", "rg", "sqlite3", "tar", "tmux"]) {
    assert.match(script, new RegExp(`\\b${tool}\\b`), `postCreate does not check ${tool}`);
  }

  // The shared package goes into the personal pi settings in the volume, never
  // the repo's .pi/settings.json — that is the duplicate-package failure the
  // P1-05 guard pins from the other side.
  assert.match(script, /SHARED_PACKAGE_REF=.*v1\.10\.0/);
  assert.match(script, /grep -q 'my-agent-setup' \.pi\/settings\.json/);
  assert.match(script, /pi install "git:github\.com\/RRiboulet\/my-agent-setup@\$\{SHARED_PACKAGE_REF\}"/);
  assert.doesNotMatch(script, /pi install[^\n]*--local/);
  assert.doesNotMatch(script, />>?\s*\.pi\/settings\.json/);
});

test("the dev environment keeps its database off the workspace mount and reads .env", async () => {
  const env = await read(".env.example");
  assert.match(env, /^PUPKEEP_DATA_DIR=\/tmp\/pupkeep-dev$/m);
  assert.match(env, /^PUPKEEP_PORT=8787$/m);
  assert.match(env, /^PUPKEEP_ACCESS=local$/m);

  const pkg = JSON.parse(await read("package.json")) as { scripts?: Record<string, string> };
  assert.match(pkg.scripts?.start ?? "", /--env-file-if-exists=\.env/);
});

test("the build context excludes secrets, dependencies and local data", async () => {
  const dockerignore = await read(".dockerignore");
  for (const entry of [".env", ".git", "node_modules", "data", "*.sqlite", ".pi/todos"]) {
    assert.match(dockerignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
});
