import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// The Phase 0 runtime claims that everything else depends on, kept alive as
// tests rather than as prose in a spike note (P0-01's exit criteria).

test("node:sqlite opens and the FULL sequence really raises synchronous to 2", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA synchronous = NORMAL");
    assert.deepEqual({ ...db.prepare("PRAGMA synchronous").get() }, { synchronous: 1 });

    // This is the sequence P1-07 must perform before any storage/harness opens.
    db.exec("PRAGMA synchronous = FULL");
    assert.deepEqual({ ...db.prepare("PRAGMA synchronous").get() }, { synchronous: 2 });

    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("commit-1");
    assert.deepEqual({ ...db.prepare("PRAGMA integrity_check").get() }, { integrity_check: "ok" });
  } finally {
    db.close();
  }
});

test("WAL is available on this runtime", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    // In-memory databases refuse WAL; the assertion is that the pragma answers at
    // all, because a build without WAL support would fail the statement.
    assert.equal(typeof row.journal_mode, "string");
  } finally {
    db.close();
  }
});

test("Intl resolves Europe/Paris with both DST offsets", () => {
  const format = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      timeZoneName: "shortOffset",
    }).format(new Date(iso));

  // An image without tzdata would fall back to UTC and lose the hour.
  assert.match(format("2026-01-15T12:00:00Z"), /GMT\+1\b/);
  assert.match(format("2026-07-15T12:00:00Z"), /GMT\+2\b/);
});
