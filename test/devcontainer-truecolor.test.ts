// Guards the truecolor advertisement the devcontainer needs so pi does not
// approximate its palette inside tmux. The same omission was fixed in a
// sibling project on 2026-11-03 (analytics-agent 2aa6720) and again here
// (2c609d2); this is the check that stops the next regression.
//
// Both halves matter. containerEnv reaches pi when it is started directly;
// tmux does not forward COLORTERM to programs in a pane, so the tmux config has
// to set it again and advertise RGB to the terminal it hands them.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): Promise<string> => readFile(join(ROOT, path), "utf8");

interface Devcontainer {
  containerEnv?: Record<string, unknown>;
}

const config = async (): Promise<Devcontainer> =>
  JSON.parse(await read(".devcontainer/devcontainer.json")) as Devcontainer;
const tmux = (): Promise<string> => read(".devcontainer/shell/tmux.conf");

test("containerEnv sets PI_TRUE_COLOR=1 for pi started outside tmux", async () => {
  const env = (await config()).containerEnv;
  assert.equal(
    env?.PI_TRUE_COLOR,
    "1",
    "Set PI_TRUE_COLOR=1 in containerEnv so pi detects a truecolor terminal.",
  );
});

test("containerEnv sets COLORTERM=truecolor for pi started outside tmux", async () => {
  const env = (await config()).containerEnv;
  assert.equal(
    env?.COLORTERM,
    "truecolor",
    "Set COLORTERM=truecolor in containerEnv so pi does not approximate its palette.",
  );
});

test("tmux advertises RGB and Tc so pi detects truecolor inside a pane", async () => {
  const conf = await tmux();
  // `terminal-features` is what tmux hands to programs inside a pane; an
  // outer-terminal override alone does not flip pi's detection. Both are kept
  // because the recorded fix carried both, and removing the override changes
  // how the outer terminal is described.
  assert.match(
    conf,
    /^set -as terminal-features ".*:RGB"\s*$/m,
    'Add `set -as terminal-features ",*:RGB"` to .devcontainer/shell/tmux.conf so tmux advertises RGB.',
  );
  assert.match(
    conf,
    /^set -as terminal-overrides ".*:Tc"\s*$/m,
    'Add `set -as terminal-overrides ",*:Tc"` to .devcontainer/shell/tmux.conf alongside the RGB feature.',
  );
});

test("tmux sets COLORTERM and PI_TRUE_COLOR for programs inside a pane", async () => {
  const conf = await tmux();
  // tmux does not forward COLORTERM into a pane, so the config has to set it
  // again or pi still sees only TERM.
  assert.match(
    conf,
    /^setenv -g COLORTERM truecolor\s*$/m,
    "Add `setenv -g COLORTERM truecolor` to .devcontainer/shell/tmux.conf; tmux does not forward the outer variable.",
  );
  assert.match(
    conf,
    /^setenv -g PI_TRUE_COLOR 1\s*$/m,
    "Add `setenv -g PI_TRUE_COLOR 1` to .devcontainer/shell/tmux.conf so pi sees it inside a pane.",
  );
});
