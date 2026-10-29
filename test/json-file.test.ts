import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWrite, JsonFileError, JsonFileStore, whenIdle } from "../src/server/json-file.ts";

interface Shape {
  counter: number;
  items: string[];
}

const parse = (raw: unknown): Shape | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.counter !== "number" || !Array.isArray(record.items)) return undefined;
  return { counter: record.counter, items: record.items.map(String) };
};

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pupkeep-json-"));
}

function storeAt(path: string): JsonFileStore<Shape> {
  return new JsonFileStore<Shape>({ path, parse, initial: () => ({ counter: 0, items: [] }) });
}

test("a missing file reads as the initial value, not an error", async () => {
  const dir = await tempDir();
  const store = storeAt(join(dir, "config.json"));
  assert.deepEqual(await store.read(), { counter: 0, items: [] });
});

test("a write lands at 0600, and the value round-trips", async () => {
  const dir = await tempDir();
  const path = join(dir, "config.json");
  const store = storeAt(path);

  await store.update((current) => ({ ...current, counter: 1 }));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.read(), { counter: 1, items: [] });
  assert.equal(JSON.parse(await readFile(path, "utf8")).counter, 1);
});

test("concurrent read-modify-write cycles do not lose updates", async () => {
  // The point of the single queue: a plain temp+rename would make each write
  // atomic and still let two updaters read the same old value.
  const dir = await tempDir();
  const path = join(dir, "config.json");
  const store = storeAt(path);

  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      store.update((current) => ({
        counter: (current.counter ?? 0) + 1,
        items: [...current.items, `item-${index}`],
      })),
    ),
  );

  const final = await store.read();
  assert.equal(final.counter, 50);
  assert.equal(final.items.length, 50);
  assert.equal(new Set(final.items).size, 50, "every updater's change survived exactly once");
});

test("two stores on the same path share one queue", async () => {
  // One queue per file, not per instance: a second store is how a lost update
  // would sneak back in.
  const dir = await tempDir();
  const path = join(dir, "config.json");
  const a = storeAt(path);
  const b = storeAt(path);

  await Promise.all([
    a.update((current) => ({ ...current, counter: current.counter + 1 })),
    b.update((current) => ({ ...current, counter: current.counter + 1 })),
    a.update((current) => ({ ...current, counter: current.counter + 1 })),
    b.update((current) => ({ ...current, counter: current.counter + 1 })),
  ]);

  assert.equal((await a.read()).counter, 4);
});

test("a failed update does not block later ones", async () => {
  const dir = await tempDir();
  const path = join(dir, "config.json");
  const store = storeAt(path);

  await assert.rejects(
    store.update(() => {
      throw new Error("mutator exploded");
    }),
    /mutator exploded/,
  );
  await store.update((current) => ({ ...current, counter: 7 }));
  assert.equal((await store.read()).counter, 7);
});

test("invalid JSON is reported rather than replaced with defaults", async () => {
  const dir = await tempDir();
  const path = join(dir, "config.json");
  await writeFile(path, "{ this is not json", "utf8");
  const store = storeAt(path);
  await assert.rejects(store.read(), JsonFileError);
  // The file is untouched: guessing would drop every invite in it.
  assert.equal(await readFile(path, "utf8"), "{ this is not json");
});

test("a file that parses but is the wrong shape is refused", async () => {
  const dir = await tempDir();
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ counter: "one" }), "utf8");
  await assert.rejects(storeAt(path).read(), /expected shape/);
});

test("no temp files are left behind, even after many writes", async () => {
  const dir = await tempDir();
  const path = join(dir, "config.json");
  const store = storeAt(path);
  await Promise.all(Array.from({ length: 10 }, () => store.update((c) => ({ ...c, counter: c.counter + 1 }))));
  await whenIdle(path);

  const names = await readdir(dir);
  assert.deepEqual(
    names.filter((name) => name.includes(".tmp-")),
    [],
    "a renamed temp file must not accumulate",
  );
});

test("atomicWrite replaces a file and keeps the requested mode", async () => {
  const dir = await tempDir();
  const path = join(dir, "secrets.json");
  await atomicWrite(path, "first\n", { mode: 0o600 });
  await atomicWrite(path, "second\n", { mode: 0o600 });
  assert.equal(await readFile(path, "utf8"), "second\n");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("a mutator that would write an unreadable value is rejected, not persisted", async () => {
  const dir = await tempDir();
  const path = join(dir, "config.json");
  const store = storeAt(path);

  await assert.rejects(
    // A spread bug that drops a required field: the file must not be bricked.
    store.update(() => ({ counter: "not-a-number" }) as unknown as Shape),
    /would write a value the parser rejects/,
  );
  // The old value is still there and readable.
  assert.deepEqual(await store.read(), { counter: 0, items: [] });
});

test("a value written by a previous version names the version it found", async () => {
  const dir = await tempDir();
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 7, counter: 1, items: [] }), "utf8");
  const strict = new JsonFileStore<Shape>({
    path,
    parse: (raw) => {
      const record = raw as { schemaVersion?: unknown; counter?: unknown; items?: unknown };
      if (record?.schemaVersion !== 1) return undefined;
      if (typeof record.counter !== "number" || !Array.isArray(record.items)) return undefined;
      return { counter: record.counter, items: record.items.map(String) };
    },
    initial: () => ({ counter: 0, items: [] }),
  });
  await assert.rejects(strict.read(), /found 7/);
});
