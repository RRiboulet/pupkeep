import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAccess, PUBLIC_ORIGIN_REQUIRED } from "../src/launcher/access.ts";
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
    retryParked: false,
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

test("--retry-parked is a switch and refuses a value", () => {
  const parsed = parseOptions(["--retry-parked"], {}, HOME);
  assert.ok(parsed.ok);
  assert.equal(parsed.options.retryParked, true);
  assert.equal(parsed.options.boot, false, "the operator's own start, not a boot path");

  // A value would read as a task id to whoever typed it, and this flag retries
  // every parked task. Refuse it rather than silently ignore the value.
  const bad = parseOptions(["--retry-parked=1"], {}, HOME);
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /does not take a value/);
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
    [["--access", "bogus"], /--access must be one of local, lan, public, tailscale, cloudflare/],
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

test("public needs a valid configured origin, and the plaintext modes refuse one", () => {
  // The origin is the trust anchor (P6): without it there is nothing to mint a
  // link on, and with it a plaintext mode is a contradiction.
  const missing = parseOptions(["--access", "public"], {}, HOME);
  assert.ok(!missing.ok);
  assert.match(missing.error, /public mode needs PUPKEEP_PUBLIC_ORIGIN/);

  const ok = parseOptions(
    ["--access", "public"],
    { PUPKEEP_PUBLIC_ORIGIN: "https://PUPPKEEP.example:443/" },
    HOME,
  );
  assert.ok(ok.ok);
  // Lower-cased host, default port and trailing slash dropped: the exact string
  // `allowedOrigins` will compare against a browser's `Origin` header.
  assert.equal(ok.options.publicOrigin, "https://puppkeep.example");
});

test("the CLI path refuses public without an origin in exactly one message", () => {
  // The parser is the authority: the launcher never gets as far as planning, so
  // this is the only sentence an operator sees. `resolveAccess` keeps the same
  // check only for a caller that skips parsing, and must repeat the constant
  // rather than invent a second explanation of the same problem (P6/R2).
  const parsed = parseOptions(["--access", "public"], {}, HOME);
  assert.ok(!parsed.ok);
  assert.equal(parsed.error, PUBLIC_ORIGIN_REQUIRED);
  assert.equal(parsed.error.match(/public mode needs PUPKEEP_PUBLIC_ORIGIN/g)?.length, 1);

  const planned = resolveAccess("public", [], DEFAULT_PORT);
  assert.ok(!planned.ok);
  assert.equal(planned.reason, PUBLIC_ORIGIN_REQUIRED);
});

test("a malformed configured origin is refused by name", () => {
  const cases: Array<[string, RegExp]> = [
    ["http://pupkeep.example", /must be https:\/\//],
    ["not a url", /is not a URL/],
    // `new URL` accepts both of these as a host; the raw text does not make
    // them an origin the operator could have meant.
    ["https:example.com", /must be https:\/\//],
    ["https://pupkeep.example:0", /must not use port 0/],
    // The parser resolves `%2e%2e` to `/`, so a path can look "bare" after
    // normalisation. The written path is what decides.
    ["https://pupkeep.example/a/%2e%2e/", /bare origin/],
    ["https://pupkeep.example/login", /bare origin/],
    ["https://pupkeep.example?x=1", /bare origin/],
    ["https://user:pw@pupkeep.example", /must not carry credentials/],
  ];
  for (const [value, expected] of cases) {
    const parsed = parseOptions([], { PUPKEEP_PUBLIC_ORIGIN: value }, HOME);
    assert.ok(!parsed.ok, `expected ${value} to fail`);
    assert.match(parsed.error, expected);
  }
});

test("a 'public' origin that is a loopback, private or dotted host is refused", () => {
  const cases: Array<[string, RegExp]> = [
    ["https://127.0.0.1", /must be a public host/],
    ["https://localhost", /must be a public host/],
    ["https://192.168.1.9", /must be a public host/],
    ["https://100.90.202.61", /must be a public host/],
    ["https://pupkeep.example.", /must not end its host with a dot/],
  ];
  for (const [value, expected] of cases) {
    const parsed = parseOptions([], { PUPKEEP_PUBLIC_ORIGIN: value }, HOME);
    assert.ok(!parsed.ok, `expected ${value} to fail`);
    assert.match(parsed.error, expected);
  }
});
