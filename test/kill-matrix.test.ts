// P5-01a: the host half of the kill/restart matrix (PLAN §7.4, §15.2, §3.2).
//
// §15.2 asks for kills at the interesting boundaries, and until now the suite
// only had the cheap ones: a committed document read back after a SIGKILL
// (`harness.test.ts`), and an open walk after a SIGKILL (`multiplayer.test.ts`,
// which defers the harder rows here in a comment). What is missing is the row
// P5-01's gate names: a process killed **mid-turn**, between the tool intent and
// the tool result.
//
// These tests use a real child process, a real SQLite file, a real SIGKILL and a
// real reopen. Nothing is simulated, and no close is graceful.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import { startApp, type AppHandle } from "../src/server/app.ts";
import { dataStores } from "../src/server/config.ts";
import { readFeeding } from "../src/server/domain/feeding.ts";
import { readWalks } from "../src/server/domain/walks.ts";
import { readCalendar } from "../src/server/domain/calendar.ts";
import { SESSION_COOKIE, Auth, hashToken, newToken } from "../src/server/auth.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { createLogger } from "../src/server/log.ts";
import { KILL_PROBE_NOTE, createKillProbe } from "../src/server/testing/kill-probe.ts";

const T0 = new Date("2026-10-30T08:00:00.000Z");
const quietLogger = createLogger({ scope: "kill-matrix", sink: () => undefined });

/** Wait for a write-then-rename marker and return its contents. */
async function waitForMarker(path: string, budgetMs = 20_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) return await readFile(path, "utf8");
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function until<T>(probe: () => Promise<T | undefined>, budgetMs = 15_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A data directory the launcher would have prepared: one owner, one partner,
 * both with sessions the parent holds the tokens for. Same shape the P2-08 walk
 * child uses, so the child can sign in over HTTP like a browser.
 */
async function seedHousehold(dir: string): Promise<{ ownerToken: string }> {
  const stores = dataStores(dir);
  await stores.config.ensure();
  const createdAt = "2026-10-29T10:00:00.000Z";
  const partnerToken = newToken();
  await stores.config.update((current) => ({
    ...current,
    members: [
      { id: "owner", role: "owner", displayName: "Alex", createdAt, sessions: [] },
      {
        id: "partner",
        role: "member",
        displayName: "Sam",
        createdAt,
        sessions: [{ tokenHash: hashToken(partnerToken), createdAt, expiresAt: "2099-01-01T00:00:00.000Z" }],
      },
    ],
  }));
  const auth = new Auth({ config: stores.config });
  const minted = await auth.mintOwner("http://127.0.0.1");
  const session = await auth.login(minted.token);
  return { ownerToken: session.token };
}

interface ThreadSnapshot {
  entries: Array<{
    kind: string;
    text?: string;
    authorName?: string;
    authorId?: string | null;
    byLabel?: string;
    byUserId?: string | null;
    toolName?: string;
    status?: string;
  }>;
}

async function readThread(app: AppHandle, token: string): Promise<ThreadSnapshot> {
  const response = await fetch(`${app.url}/api/agent/thread`, {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(response.status, 200, "the thread snapshot must be readable");
  return (await response.json()) as ThreadSnapshot;
}

test("a kill mid-turn reruns the safe tool once, completes the turn, and keeps its author", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-kill-turn-"));
  const { ownerToken } = await seedHousehold(dir);
  const marker = join(dir, "probe-committed");
  const childPath = fileURLToPath(new URL("../src/server/testing/turn-child.ts", import.meta.url));
  const child = spawn(process.execPath, [childPath, dir, marker, ownerToken], {
    cwd: join(import.meta.dirname, ".."),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await waitForMarker(marker).catch((error) => {
      throw new Error(`${(error as Error).message}: ${stderr}`);
    });

    // The kill is the test: the care write is committed (that is what the marker
    // means), the tool result is not, and there is no graceful close.
    assert.equal(child.kill("SIGKILL"), true, "the child was alive to kill");
    const exit = await exited;
    assert.equal(exit.signal, "SIGKILL", `the child must die by SIGKILL (code ${exit.code}, stderr: ${stderr})`);

    // Reopen the same data directory. The registry must declare the same tool,
    // or the pending task has no definition to rerun; `resume()` is the call that
    // continues it.
    const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] });
    faux.setResponses([fauxAssistantMessage("Logged it after the restart.")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry<ToolRegistration>();
    registry.install(createKillProbe({ now: T0 }));
    const reopened = await startApp(
      { dataDir: dir, host: "127.0.0.1", port: 0, models, registry },
      { logger: quietLogger },
    );
    assert.ok(reopened.ok, "the app reopens on the same data directory");

    try {
      // The turn finishes: the tool reruns, its result commits, and the model
      // answers the follow-up request.
      const snapshot = await until(async () => {
        const thread = await readThread(reopened.app, ownerToken);
        return thread.entries.some((entry) => entry.kind === "assistant") ? thread : undefined;
      });

      // One write, not two: the rerun is a replay on the tool task id, which is
      // the same idempotency the product's `log_feeding` depends on (§7.3).
      const feeding = await readFeeding(reopened.app.app, BACKGROUND_CONTEXT);
      const probes = feeding.events.filter((event) => event.note === KILL_PROBE_NOTE);
      assert.equal(probes.length, 1, "the interrupted tool must commit exactly one care write");

      // The turn is recoverable *and attributed*: the assistant entry takes the
      // author of the chat entry that started the run (§9.2 rule 2).
      const chat = snapshot.entries.find((entry) => entry.kind === "chat");
      assert.equal(chat?.authorId, "owner");
      assert.equal(chat?.authorName, "Alex");
      const assistant = snapshot.entries.find((entry) => entry.kind === "assistant");
      assert.equal(assistant?.text, "Logged it after the restart.");
      assert.equal(assistant?.authorName, "Alex", "the recovered turn keeps the caregiver who started it");

      const tool = snapshot.entries.find((entry) => entry.kind === "tool");
      assert.equal(tool?.toolName, "log_kill_probe");
      assert.equal(tool?.status, "ok", "the rerun's result is committed, not left as an interrupted error");
      // Direct evidence that this is the *rerun* and not the first call: the
      // domain answered from the recorded idempotency row.
      assert.match(tool?.text ?? "", /replayed/, "the rerun must replay the committed write, not repeat it");
      assert.equal(tool?.byLabel, "Alex", "the tool card is attributed to the caregiver too");
    } finally {
      await reopened.app.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

// --- kill at a commit boundary -------------------------------------------------

/**
 * The four writes §15.2 names, each with the same shape of claim: the process
 * dies right after the write acked, and a fresh app on the same directory finds
 * it exactly once. `walk-end` starts a walk first, so the boundary under test is
 * the end. `approve` is deliberately absent: `test/approvals.test.ts` already
 * proves a double confirm replays the stored result, and the kill window there is
 * the same single Pi Durable commit these four rows exercise.
 */
interface ActionRow {
  readonly name: string;
  readonly key: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  /** The write's own effect, read back from the reopened app. */
  readonly effect: (app: AppHandle) => Promise<number>;
  /** POST the same key and body again; the answer must be a replay, not a duplicate. */
  readonly replay: () => Promise<unknown>;
}

const ACTIONS: readonly ActionRow[] = [
  {
    name: "feed",
    key: "http:kill-feed",
    path: "/api/feeding/extra",
    body: { amount: "a treat" },
    effect: async (app) => (await readFeeding(app.app, BACKGROUND_CONTEXT)).events.length,
    replay: async () => undefined,
  },
  {
    name: "walk-start",
    key: "http:kill-walk-start",
    path: "/api/walks/start",
    body: {},
    effect: async (app) => (await readWalks(app.app, BACKGROUND_CONTEXT)).walks.length,
    replay: async () => undefined,
  },
  {
    name: "walk-end",
    key: "http:kill-walk-end",
    path: "/api/walks/end",
    body: { walkId: "", pee: 1 },
    effect: async (app) => {
      // An ended walk leaves `open` null and stays in the append-only history.
      const walks = await readWalks(app.app, BACKGROUND_CONTEXT);
      const open = walks.walks.filter((walk) => walk.endedAt === undefined);
      return open.length === 0 && walks.walks.length === 1 ? 1 : 0;
    },
    replay: async () => undefined,
  },
  {
    name: "appointment",
    key: "http:kill-appointment",
    path: "/api/appointments",
    body: { title: "Vet visit", localDate: "2026-12-20", timeLocal: "09:00", durationMin: 30 },
    effect: async (app) => (await readCalendar(app.app, BACKGROUND_CONTEXT)).appointments.length,
    replay: async () => undefined,
  },
];

for (const action of ACTIONS) {
  test(`a kill after the ${action.name} ack keeps exactly one effect and replays the same key`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `pupkeep-kill-${action.name}-`));
    const { ownerToken } = await seedHousehold(dir);
    const marker = join(dir, "committed");
    const childPath = fileURLToPath(new URL("../src/server/testing/commit-child.ts", import.meta.url));
    const child = spawn(process.execPath, [childPath, dir, marker, ownerToken, action.name], {
      cwd: join(import.meta.dirname, ".."),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    try {
      const markerBody = await waitForMarker(marker).catch((error) => {
        throw new Error(`${(error as Error).message}: ${stderr}`);
      });
      assert.equal(child.kill("SIGKILL"), true, "the child was alive to kill");
      const exit = await exited;
      assert.equal(exit.signal, "SIGKILL", `the child must die by SIGKILL (code ${exit.code}, stderr: ${stderr})`);

      const models = createModels();
      models.setProvider(fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] }).provider);
      const reopened = await startApp(
        { dataDir: dir, host: "127.0.0.1", port: 0, models },
        { logger: quietLogger },
      );
      assert.ok(reopened.ok, "the app reopens on the same data directory");
      try {
        assert.equal(await action.effect(reopened.app), 1, `the ${action.name} write survived the kill exactly once`);

        // §7.3: the same key and body is success, not a conflict and not a second
        // effect. A crash between the commit and the response must be
        // indistinguishable from a slow answer.
        const replayBody = action.name === "walk-end"
          ? { ...action.body, walkId: (JSON.parse(markerBody) as { walk: { id: string } }).walk.id }
          : action.body;
        const replay = await fetch(`${reopened.app.url}${action.path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
            "Idempotency-Key": action.key,
            Cookie: `${SESSION_COOKIE}=${ownerToken}`,
            Origin: reopened.app.url,
          },
          body: JSON.stringify(replayBody),
        });
        const replayText = await replay.text();
        assert.equal(replay.status, 200, `the ${action.name} replay must succeed: ${replayText}`);
        const body = JSON.parse(replayText) as { replayed?: boolean };
        assert.equal(body.replayed, true, `the ${action.name} retry must report a replay`);
        assert.equal(await action.effect(reopened.app), 1, "a replay must not add a second effect");
      } finally {
        await reopened.app.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });
}
