# Devcontainer truecolor

**Rule.** Pupkeep's devcontainer advertises truecolor to pi: `PI_TRUE_COLOR=1`
and `COLORTERM=truecolor` in `containerEnv`, and `terminal-features ...:RGB`,
`terminal-overrides ...:Tc`, `setenv -g COLORTERM truecolor` and
`setenv -g PI_TRUE_COLOR 1` inside tmux. Without them tmux reports only 256
colours and pi approximates its palette, so the coloured tool-call and thinking
sections look different inside a tmux pane.

## The repeat

- **2026-11-03 09:53:16 UTC — pupkeep `2c609d2`**, "fix(devcontainer): advertise
  truecolor and use kokomi theme for consistent pi look". Adds the two
  `containerEnv` keys, the tmux RGB/Tc features and the two tmux `setenv` lines.
- **2026-11-03 09:53:19 UTC — analytics-agent `2aa6720`**, "fix(devcontainer):
  advertise truecolor for consistent pi look". The same omission, the same
  lines, in a sibling project three seconds later. This is the cross-repo repeat
  the experiment spec cites.

pupkeep's commit also installed the kokomi theme. That is a different class (a
look choice, not a colour-capability fact) and is not part of this rule.

## Bad and good revisions

- **Bad: `f1f53e5` (`2c609d2^`).** `.devcontainer/shell/tmux.conf` already exists
  at this commit (added by `14e8f24`) and the rest of `devcontainer.json` is
  otherwise the same; the truecolor lines are the fix's only delta. This is the
  actual parent revision, not a reconstruction.
- **Good: `2c609d2`.** Current `main` keeps the same lines.

The check is the new test file copied into each worktree, because the bad
revision does not have it. Running the bad checkout alone would have no check to
run; copying the test in lets its assertions decide the old configuration.

## Proof

From this branch's checkout:

```bash
git -C /home/ubuntu/pupkeep worktree add --detach /tmp/pupkeep-truecolor-bad f1f53e5
cp test/devcontainer-truecolor.test.ts /tmp/pupkeep-truecolor-bad/test/
cd /tmp/pupkeep-truecolor-bad && node --test test/devcontainer-truecolor.test.ts
# exit 1: 0 pass, 4 fail

git -C /home/ubuntu/pupkeep worktree add --detach /tmp/pupkeep-truecolor-good 2c609d2
cp test/devcontainer-truecolor.test.ts /tmp/pupkeep-truecolor-good/test/
cd /tmp/pupkeep-truecolor-good && node --test test/devcontainer-truecolor.test.ts
# exit 0: 4 pass, 0 fail
```

The four failing cases at `f1f53e5` are the two `containerEnv` keys and the two
tmux groups (RGB/Tc, then COLORTERM/PI_TRUE_COLOR); at `2c609d2` all four pass.

## Capture: partial

Every form in pupkeep's own fix is red at `f1f53e5` and green at `2c609d2`:
outer env, tmux RGB/Tc, tmux COLORTERM/PI_TRUE_COLOR.

It does **not** pin `analytics-agent`'s copy (`2aa6720` has no equivalent test)
or a future project's, so the shared-template fix the spec points at remains
open. It also does not pin the kokomi theme from `2c609d2`, which is a different
class. The rule text is scoped to pupkeep for that reason; a project-local test
cannot enforce a sibling repository.

## Level, and why not higher

The check is a **test**.

- **Architecture** — pupkeep has no shared devcontainer owner. The values live
  in each project's `.devcontainer/`, so making the omission impossible needs
  the cross-repo template, not a change in this repository.
- **Type** — no schema boundary covers `devcontainer.json`, and a JSON schema
  cannot see `tmux.conf`; it would pin at most half the class and add schema
  tooling.
- **Lint** — there is no ESLint config here, ESLint does not parse `tmux.conf`,
  and the defect is an absence in two non-JS files, not a locally recognizable
  line of JS/TS. The project already guards devcontainer invariants with
  `node --test` (`test/devcontainer.test.ts`), so this stays at that seam rather
  than adding a dependency.

## Baseline, suppressions and checker

**Baseline:** none. The check is new and the tree has no existing violations.
**Suppressions:** none.

The vendored checker is contract version 1, sha256
`9ab0994ddab7d256f654791fb6d89a8f315d577b092ceae83a82887d90645822`, recorded in
`tools/rule-table.version`:

```bash
node tools/rule-table.mjs check AGENTS.md
# exit 0
```
