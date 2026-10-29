import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOptions, expandHome, DEFAULT_PORT } from "../src/launcher/options.ts";

const HOME = "/home/owner";

test("defaults: local access, port 8787, ~/.pupkeep", () => {
  const parsed = parseOptions([], {}, HOME);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.options, {
    mode: "local",
    port: DEFAULT_PORT,
    dataDir: "/home/owner/.pupkeep",
    boot: false,
    reissueOwner: false,
    help: false,
    // No TTY in a test runner: never print a token by default.
    interactive: false,
  });
});

test("every documented flag is accepted, in both spellings for values", () => {
  const spaced = parseOptions(["--access", "tailscale", "--port", "9000", "--data", "/srv/pk"], {}, HOME);
  assert.ok(spaced.ok);
  assert.equal(spaced.options.mode, "tailscale");
  assert.equal(spaced.options.port, 9000);
  assert.equal(spaced.options.dataDir, "/srv/pk");

  const inline = parseOptions(["--access=cloudflare", "--port=9001", "--data=/srv/x"], {}, HOME);
  assert.ok(inline.ok);
  assert.equal(inline.options.mode, "cloudflare");
  assert.equal(inline.options.port, 9001);
});

test("--boot and --reissue-owner are switches", () => {
  const parsed = parseOptions(["--boot", "--reissue-owner"], {}, HOME);
  assert.ok(parsed.ok);
  assert.equal(parsed.options.boot, true);
  assert.equal(parsed.options.reissueOwner, true);
});

test("environment fills the defaults, and flags win over it", () => {
  const env = { PUPKEEP_ACCESS: "lan", PUPKEEP_PORT: "9100", PUPKEEP_DATA_DIR: "/tmp/pk" };
  const parsed = parseOptions([], env, HOME);
  assert.ok(parsed.ok);
  assert.equal(parsed.options.mode, "lan");
  assert.equal(parsed.options.port, 9100);
  assert.equal(parsed.options.dataDir, "/tmp/pk");

  const overridden = parseOptions(["--access", "local", "--port", "9200"], env, HOME);
  assert.ok(overridden.ok);
  assert.equal(overridden.options.mode, "local");
  assert.equal(overridden.options.port, 9200);
});

test("bad input is refused with a message naming the problem", () => {
  const cases: Array<[string[], RegExp]> = [
    [["--access", "public"], /--access must be one of local, lan, tailscale, cloudflare/],
    [["--access"], /--access needs a mode/],
    [["--port", "0"], /--port must be an integer 1\.\.65535/],
    [["--port", "70000"], /--port must be an integer/],
    [["--port", "abc"], /--port must be an integer/],
    [["--data"], /--data needs a directory/],
    [["--wat"], /unknown argument: --wat/],
  ];
  for (const [argv, expected] of cases) {
    const parsed = parseOptions(argv, {}, HOME);
    assert.ok(!parsed.ok, `expected ${JSON.stringify(argv)} to fail`);
    assert.match(parsed.error, expected);
  }
});

test("a bad environment value fails the same way", () => {
  const mode = parseOptions([], { PUPKEEP_ACCESS: "nope" }, HOME);
  assert.ok(!mode.ok);
  assert.match(mode.error, /PUPKEEP_ACCESS is not an access mode/);

  const port = parseOptions([], { PUPKEEP_PORT: "http" }, HOME);
  assert.ok(!port.ok);
  assert.match(port.error, /PUPKEEP_PORT is not a port/);
});

test("~ is expanded and relative data dirs resolve against home, not the cwd", () => {
  assert.equal(expandHome("~", HOME), HOME);
  assert.equal(expandHome("~/x/y", HOME), "/home/owner/x/y");
  assert.equal(expandHome("/abs", HOME), "/abs");

  const tilde = parseOptions(["--data", "~/.pupkeep-test"], {}, HOME);
  assert.ok(tilde.ok);
  assert.equal(tilde.options.dataDir, "/home/owner/.pupkeep-test");
});

test("--help does not require a mode", () => {
  const parsed = parseOptions(["--help"], {}, HOME);
  assert.ok(parsed.ok);
  assert.equal(parsed.options.help, true);

  const short = parseOptions(["-h"], {}, HOME);
  assert.ok(short.ok);
  assert.equal(short.options.help, true);
});

test("interactive is a TTY fact, not an operator's memory", () => {
  // A boot script redirects stdout into server.log and is not a TTY, so the
  // token must not be printed even without --boot.
  const redirected = parseOptions([], {}, HOME, false);
  assert.ok(redirected.ok);
  assert.equal(redirected.options.interactive, false);
  const tty = parseOptions([], {}, HOME, true);
  assert.ok(tty.ok);
  assert.equal(tty.options.interactive, true);

  const forcedBoot = parseOptions(["--boot"], {}, HOME, true);
  assert.ok(forcedBoot.ok);
  assert.equal(forcedBoot.options.interactive, false);
});

test("an empty or attached value on the wrong kind of flag is refused", () => {
  // `--data=` used to resolve the data directory to $HOME and chmod it.
  for (const [argv, expected] of [
    [["--data="], /--data needs a directory/],
    [["--access="], /--access needs a mode/],
    [["--boot=yes"], /--boot does not take a value/],
    [["--reissue-owner=1"], /--reissue-owner does not take a value/],
  ] as Array<[string[], RegExp]>) {
    const parsed = parseOptions(argv, {}, HOME);
    assert.ok(!parsed.ok, JSON.stringify(argv));
    assert.match(parsed.error, expected);
  }
});
