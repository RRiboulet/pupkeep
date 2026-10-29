import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  activeMembers,
  dataPaths,
  dataStores,
  emptyConfig,
  emptyPush,
  emptySecrets,
  ensureDataDir,
  parseConfig,
  parsePush,
  parseSecrets,
  reconcileMembers,
  type AppConfig,
  type MemberRecord,
} from "../src/server/config.ts";

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "m1",
    role: "member",
    displayName: "Ronan",
    // Distinct names are required by the parser: two active members with one
    // display name make the shared thread's actor attribution ambiguous.
    createdAt: "2026-10-29T10:00:00.000Z",
    sessions: [],
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pupkeep-config-"));
}

// --- the data directory -----------------------------------------------------

test("ensureDataDir creates the directory at 0700 and tightens a loose one", async () => {
  const root = await tempDir();
  const created = join(root, "pupkeep");
  const first = await ensureDataDir(created);
  assert.equal(first.fixedMode, false);
  assert.equal((await stat(created)).mode & 0o777, 0o700);

  const { chmod } = await import("node:fs/promises");
  await chmod(created, 0o755);
  const second = await ensureDataDir(created);
  assert.equal(second.fixedMode, true, "an existing loose directory is corrected");
  assert.equal((await stat(created)).mode & 0o777, 0o700);
});

test("a data path that is a file is refused with a sentence", async () => {
  const root = await tempDir();
  const file = join(root, "not-a-dir");
  await writeFile(file, "x", "utf8");
  await assert.rejects(ensureDataDir(file), /not a directory/);
});

test("the four files live where the plan says, all inside the data dir", async () => {
  const paths = dataPaths("/home/owner/.pupkeep");
  assert.equal(paths.config, "/home/owner/.pupkeep/config.json");
  assert.equal(paths.secrets, "/home/owner/.pupkeep/secrets.json");
  assert.equal(paths.push, "/home/owner/.pupkeep/push.json");
  assert.equal(paths.models, "/home/owner/.pupkeep/models.json");
  assert.equal(paths.ownerLink, "/home/owner/.pupkeep/owner-link.txt");
});

test("every store writes 0600 files", async () => {
  const dir = await ensureDataDir(await tempDir());
  const stores = dataStores(dir.path);
  await stores.config.ensure();

  await stores.config.update((config) => ({ ...config, ownerTokenHash: "ownerhash0123456789abcdef" }));
  await stores.secrets.update((secrets) => ({ ...secrets, providerKeys: { "opencode-go": "sk-test-0123456789" } }));
  await stores.push.update((push) => ({ ...push, ntfy: { m1: { topic: "abcdefghijklmnopqrstuvwx" } } }));

  for (const path of [stores.paths.config, stores.paths.secrets, stores.paths.push]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600, path);
  }
});

// --- schemas ----------------------------------------------------------------

test("the config is the auth authority: hashes, roles, removals", () => {
  const config: AppConfig = {
    schemaVersion: 1,
    ownerTokenHash: "owner-hash",
    members: [
      member({ id: "owner", role: "owner", displayName: "Ronan" }),
      member({ id: "partner", inviteHash: "invite-hash" }),
      member({ id: "gone", removedAt: "2026-10-29T11:00:00.000Z" }),
    ],
  };
  assert.deepEqual(
    activeMembers(config).map((m) => m.id),
    ["owner", "partner"],
  );
  // A removed member is retained on purpose: otherwise a stale profile would
  // resurrect them on the next boot.
  assert.ok(config.members.some((m) => m.id === "gone" && m.removedAt !== undefined));
});

test("a config with a duplicate member id is refused", () => {
  const raw = {
    schemaVersion: 1,
    ownerTokenHash: null,
    members: [member({ id: "same" }), member({ id: "same" })],
  };
  assert.equal(parseConfig(raw), undefined);
});

test("a config from another schema version is refused rather than guessed", () => {
  assert.equal(parseConfig({ ...emptyConfig(), schemaVersion: 2 }), undefined);
  assert.equal(parseConfig({ ...emptyConfig(), members: "nope" }), undefined);
  assert.equal(parseSecrets({ ...emptySecrets(), schemaVersion: 99 }), undefined);
  assert.equal(parsePush({ ...emptyPush(), schemaVersion: 99 }), undefined);
});

test("unknown notification categories are refused", () => {
  const push = {
    ...emptyPush(),
    prefs: { m1: { enabled: true, categories: ["feed_overdue", "vet_appointments"] } },
  };
  assert.equal(parsePush(push), undefined);
});

test("push keeps the VAPID pair and per-user ntfy topics", () => {
  const parsed = parsePush({
    ...emptyPush(),
    vapid: { publicKey: "p".repeat(80), privateKey: "s".repeat(40) },
    ntfy: { partner: { topic: "abcdefghijklmnopqrstuvwx" } },
    prefs: { partner: { enabled: true, categories: ["fed", "feed_overdue"] } },
  });
  assert.deepEqual(parsed?.vapid, { publicKey: "p".repeat(80), privateKey: "s".repeat(40) });
  assert.equal(parsed?.ntfy.partner?.topic, "abcdefghijklmnopqrstuvwx");
  assert.deepEqual(parsed?.prefs.partner?.categories, ["fed", "feed_overdue"]);
});

test("secrets hold provider keys and nothing else", () => {
  const parsed = parseSecrets({
    schemaVersion: 1,
    providerKeys: { "opencode-go": "key-1", openrouter: "key-2" },
  });
  assert.deepEqual(parsed?.providerKeys, { "opencode-go": "key-1", openrouter: "key-2" });
  assert.equal(parseSecrets({ schemaVersion: 1, providerKeys: { x: 5 } }), undefined);
});

// --- reconciliation: config wins, and the dead stay dead --------------------

test("a member in config with no profile gets one", () => {
  const config: AppConfig = { ...emptyConfig(), members: [member({ id: "m1" })] };
  const plan = reconcileMembers(config, []);
  assert.deepEqual(plan.createProfiles, [{ memberId: "m1", displayName: "Ronan" }]);
});

test("a profile whose member is gone from config is removed", () => {
  const config: AppConfig = { ...emptyConfig(), members: [] };
  const plan = reconcileMembers(config, [{ memberId: "ghost", displayName: "Ghost" }]);
  assert.deepEqual(plan.removeProfiles, [{ memberId: "ghost", displayName: "Ghost", reason: "missing" }]);
  assert.deepEqual(plan.createProfiles, []);
});

test("a removed member is not resurrected from a stale profile", () => {
  const config: AppConfig = {
    ...emptyConfig(),
    members: [member({ id: "gone", removedAt: "2026-10-29T11:00:00.000Z" })],
  };
  const plan = reconcileMembers(config, [{ memberId: "gone", displayName: "Ronan" }]);

  assert.deepEqual(
    plan.removeProfiles,
    [{ memberId: "gone", displayName: "Ronan", reason: "removed" }],
    "the profile goes, the auth record stays removed",
  );
  assert.deepEqual(plan.createProfiles, [], "and boot must not recreate either");
});

test("config display name wins over a drifted profile", () => {
  const config: AppConfig = { ...emptyConfig(), members: [member({ id: "m1", displayName: "Ronan" })] };
  const plan = reconcileMembers(config, [{ memberId: "m1", displayName: "R." }]);
  assert.deepEqual(plan.updateProfiles, [{ memberId: "m1", from: "R.", to: "Ronan" }]);
});

test("a member who is up to date causes no work", () => {
  const config: AppConfig = { ...emptyConfig(), members: [member({ id: "m1" })] };
  const plan = reconcileMembers(config, [{ memberId: "m1", displayName: "Ronan" }]);
  assert.deepEqual(plan, { createProfiles: [], updateProfiles: [], removeProfiles: [] });
});

// --- files on disk ----------------------------------------------------------

test("a config written by the store reads back with its hashes intact", async () => {
  const dir = await ensureDataDir(await tempDir());
  const stores = dataStores(dir.path);
  await stores.config.ensure();

  await stores.config.update((config) => ({
    ...config,
    ownerTokenHash: "ownerhash0123456789abcdef",
    members: [
      member({
        inviteHash: "invitehash0123456789abcdef",
        sessions: [{ tokenHash: "sessionhash0123456789abcdef", createdAt: "2026-10-29T10:00:00.000Z" }],
      }),
    ],
  }));

  const reread = await stores.config.read();
  assert.equal(reread.ownerTokenHash, "ownerhash0123456789abcdef");
  assert.equal(reread.members[0]!.inviteHash, "invitehash0123456789abcdef");
  assert.equal(reread.members[0]!.sessions[0]!.tokenHash, "sessionhash0123456789abcdef");

  // Hashes only: nothing in the file is a usable credential.
  const text = await readFile(stores.paths.config, "utf8");
  assert.match(text, /ownerhash/);
  assert.doesNotMatch(text, /token=|invite=|Bearer /);
});

test("concurrent config updates lose nothing", async () => {
  const dir = await ensureDataDir(await tempDir());
  const stores = dataStores(dir.path);
  await stores.config.ensure();

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      stores.config.update((config) => ({
        ...config,
        members: [...config.members, member({ id: `m${index}`, displayName: `Person ${index}` })],
      })),
    ),
  );

  const config = await stores.config.read();
  assert.equal(config.members.length, 20);
  assert.equal(new Set(config.members.map((m) => m.id)).size, 20);
});

test("the models cache round-trips through its store", async () => {
  const dir = await ensureDataDir(await tempDir());
  const stores = dataStores(dir.path);

  await stores.models.update((cache) => ({
    ...cache,
    checkedAt: "2026-10-29T12:00:00.000Z",
    results: [
      {
        id: "opencode-go/mimo-v2.6-flash",
        provider: "opencode-go",
        model: "mimo-v2.6-flash",
        status: "ok",
        toolCall: true,
        latencyMs: 900,
        checkedAt: "2026-10-29T12:00:00.000Z",
      },
    ],
  }));

  const cache = await stores.models.read();
  assert.equal(cache.results.length, 1);
  assert.equal(cache.results[0]!.status, "ok");
});

test("a missing config is an error, not an empty authority; other files may be absent", async () => {
  const dir = await ensureDataDir(await tempDir());
  const stores = dataStores(dir.path);

  // A typo'd --data or a partial restore must fail loudly: reading "no owner, no
  // members" as valid would start the app and lose every invite, silently.
  await assert.rejects(stores.config.read(), /is missing/);
  assert.deepEqual(await stores.secrets.read(), emptySecrets());
  assert.deepEqual(await stores.push.read(), emptyPush());

  // First run creates it deliberately.
  assert.equal(await stores.config.ensure(), true);
  assert.equal(await stores.config.ensure(), false, "ensure is idempotent");
  assert.deepEqual(await stores.config.read(), emptyConfig());
});
