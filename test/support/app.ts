// The shared harness for the care-surface suites (PLAN §15.3, §16 P3-08).
//
// Every HTTP/tool suite used to boot its own app the same way: a temp data
// directory, a `config.json` with one or two members, a faux provider, an owner
// session, and (sometimes) a household timezone. P3-05's carried note asked for
// one helper rather than a fifth copy; this is it.
//
// What stays local: the request builders (`post`, `patch`, their mutation-guard
// options), the fixtures' *data* (meal slots, milestone ids), and the tests
// themselves. What moves here: the boot, the sessions, the clock, the optional
// partner and timezone, and the two tool seams (`toolApi`, `resultText`) that
// every agent-side test needs.
//
// Determinism: the clock is a value or a function supplied by the caller, the
// partner's session expiry is a fixed far-future instant (never `Date.now()` in
// an expectation), and nothing here waits on a timer. A suite that needs to move
// the clock passes a function over its own variable, as `walk-routes` does.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { SESSION_COOKIE, Auth, hashToken, newToken } from "../../src/server/auth.ts";
import { startApp, type AppHandle } from "../../src/server/app.ts";
import { dataStores } from "../../src/server/config.ts";
import { HouseholdDoc } from "../../src/server/domain/docs.ts";
import { createLogger } from "../../src/server/log.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../../src/server/http.ts";
import type { PuppyProfile } from "../../src/shared/profile.ts";

/** A scripted faux-provider answer, or a thunk producing one per call. */
export type ResponseStep =
  | ReturnType<typeof fauxAssistantMessage>
  | (() => ReturnType<typeof fauxAssistantMessage>);

export interface TestAppOptions {
  /** Temp-directory prefix, e.g. `"pupkeep-growth-routes-"`. */
  prefix: string;
  /**
   * The server clock in milliseconds, fixed or read through a function. A
   * suite that advances time passes `() => current.getTime()` over its own
   * variable; nothing else in the suite may read the wall clock.
   */
  now?: number | (() => number);
  /** Add a second member ("Sam" by default) with a pre-minted session. */
  partner?: true | { name: string };
  /** Script the faux provider, for a suite that drives a real conversation. */
  responses?: readonly ResponseStep[];
  /** Set the household zone after boot through the real `PATCH /api/household`. */
  timezone?: string;
}

export interface TestApp {
  dir: string;
  app: AppHandle;
  url: string;
  /** Raw session-cookie values (not the `Cookie` header). */
  cookies: { owner: string; partner?: string };
  /** The pinned clock the app and the tool seam both read. */
  now(): number;
  /** The care-state read, as the owner. */
  profile(): Promise<PuppyProfile>;
  /** Close the app and remove its data directory. */
  stop(): Promise<void>;
}

/** The fixed expiry every test partner session carries (no wall clock). */
const SESSION_EXPIRES_AT = "2099-01-01T00:00:00.000Z";
/** Before every pinned test clock, so a fixture instant never postdates "now". */
const MEMBER_CREATED_AT = "2025-01-01T00:00:00.000Z";

function cookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

/**
 * Boot one app with the shared fixture: owner "Alex", an optional partner with
 * a pre-minted session, a faux provider, and a household zone (UTC unless the
 * caller names one, so no suite depends on the host's zone).
 */
export async function startTestApp(options: TestAppOptions): Promise<TestApp> {
  const dir = await mkdtemp(join(tmpdir(), options.prefix));
  const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "mimo-v2.6-flash" }] });
  if (options.responses !== undefined) faux.setResponses([...options.responses]);
  const models = createModels();
  models.setProvider(faux.provider);

  const partner = options.partner === undefined ? undefined : options.partner;
  const partnerName = typeof partner === "object" ? partner.name : "Sam";
  const partnerToken = partner === undefined ? undefined : newToken();

  const stores = dataStores(dir);
  await stores.config.ensure();
  await stores.config.update((current) => ({
    ...current,
    members: [
      { id: "owner", role: "owner", displayName: "Alex", createdAt: MEMBER_CREATED_AT, sessions: [] },
      ...(partnerToken === undefined
        ? []
        : [
            {
              id: "partner",
              role: "member" as const,
              displayName: partnerName,
              createdAt: MEMBER_CREATED_AT,
              sessions: [
                { tokenHash: hashToken(partnerToken), createdAt: MEMBER_CREATED_AT, expiresAt: SESSION_EXPIRES_AT },
              ],
            },
          ]),
    ],
  }));

  const clock =
    options.now === undefined
      ? () => Date.now()
      : typeof options.now === "number"
        ? () => options.now as number
        : options.now;
  const result = await startApp(
    { dataDir: dir, host: "127.0.0.1", port: 0, models, now: clock },
    { logger: createLogger({ scope: "test", sink: () => undefined }) },
  );
  assert.ok(result.ok, "the app must start");

  const auth = new Auth({ config: stores.config });
  const ownerToken = await auth.mintOwner("http://127.0.0.1").then((m) => m.token);
  const ownerCookie = await auth.login(ownerToken).then((l) => l.token);

  const close = async (): Promise<void> => {
    await result.app.close();
    await rm(dir, { recursive: true, force: true });
  };

  const fixture: TestApp = {
    dir,
    app: result.app,
    url: result.app.url,
    cookies: {
      owner: ownerCookie,
      ...(partnerToken === undefined ? {} : { partner: partnerToken }),
    },
    now: clock,
    profile: async () => {
      const response = await fetch(`${result.app.url}/api/puppy`, {
        headers: { Cookie: cookieHeader(ownerCookie) },
      });
      assert.equal(response.status, 200, "the care-state read answers");
      return (await response.json()) as PuppyProfile;
    },
    stop: close,
  };

  // Set the zone through the real route, so the care documents carry it. A
  // failure here must not leak the listener and the temp directory: the
  // caller's `finally` has not started yet.
  try {
    const current = await fixture.profile();
    const patched = await fetch(`${result.app.url}/api/household`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        "Idempotency-Key": "zone-setup",
        Cookie: cookieHeader(ownerCookie),
        Origin: result.app.url,
      },
      body: JSON.stringify({ rev: current.household.rev, timezone: options.timezone ?? "UTC" }),
    });
    assert.equal(patched.status, 200, "the household zone is set for the fixture");
  } catch (error) {
    await close();
    throw error;
  }

  return fixture;
}

/**
 * The tool execution seam: committed reads, one commit, a fixed task id, an
 * in-memory memo and the fixture's pinned clock (a caller may name a later
 * instant for one call, as the walk suite does). Never the wall clock.
 */
export function toolApi(
  fixture: TestApp,
  conversationId: number,
  taskId: string | number = "task-1",
  memos = new Map<string, unknown>(),
  nowMs = fixture.now(),
): ToolExecutionApi {
  const api = {
    taskId,
    conversationId: conversationId as ConversationId,
    now: () => nowMs,
    snapshot: (token: never, ctx: never) => fixture.app.app.snapshot(token, ctx),
    commit: (change: never, ctx: never) => fixture.app.app.commit(change, ctx),
    memo: async (name: string, candidateOrContext: unknown, maybeContext?: unknown) => {
      if (maybeContext === undefined) return memos.get(name);
      if (!memos.has(name)) memos.set(name, candidateOrContext);
      return memos.get(name);
    },
  };
  return api as unknown as ToolExecutionApi;
}

/** The shared household conversation a tool call must name. */
export async function conversationIdOf(fixture: TestApp, context: Context = BACKGROUND_CONTEXT): Promise<number> {
  const household = await fixture.app.app.snapshot(HouseholdDoc, context);
  return household!.conversationId;
}

/** The first text block of a tool result. */
export function resultText(result: { output?: unknown }): string {
  return (result.output as { text: string }[])[0]!.text;
}

/**
 * Poll until `probe` yields a value. Only for a real provider run: the model's
 * turn is not a clock question, so there is nothing deterministic to await.
 * Everything else in the suite uses the pinned clock instead.
 */
export async function until<T>(probe: () => T | undefined | Promise<T | undefined>, budgetMs = 8000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
