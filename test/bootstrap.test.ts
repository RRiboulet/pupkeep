// P1-08's acceptance rows: a fresh boot creates the household, puppy, activity,
// commands and two conversations; a second boot changes nothing; a removed member
// stays removed; a missing profile is repaired from config; a household rename is
// not clobbered; and the hidden system conversation never keeps a model.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, type ConversationId } from "@earendil-works/pi-durable";
import { openHarness, type OpenedHarness } from "../src/server/harness.ts";
import { emptyConfig, type AppConfig, type MemberRecord } from "../src/server/config.ts";
import { bootstrapSession, BootstrapError } from "../src/server/domain/bootstrap.ts";
import {
  ActivityDoc,
  CommandsDoc,
  HouseholdDoc,
  PuppyDoc,
  emptyHousehold,
  parseHousehold,
} from "../src/server/domain/docs.ts";
import {
  DEFAULT_HOUSEHOLD_NAME,
  DEFAULT_HOUSEHOLD_SETTINGS,
  type Household,
} from "../src/shared/domain.ts";

const context = BACKGROUND_CONTEXT;
const NOW = new Date("2026-10-29T12:00:00.000Z");
const now = (): Date => NOW;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "owner",
    role: "owner",
    displayName: "Owner",
    createdAt: "2026-10-29T10:00:00.000Z",
    sessions: [],
    ...overrides,
  };
}

function config(...members: MemberRecord[]): AppConfig {
  return { ...emptyConfig(), members };
}

const owner = member();
const partner = member({ id: "partner", role: "member", displayName: "Sam" });

async function withHarness(run: (opened: OpenedHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pupkeep-bootstrap-"));
  const opened = await openHarness({ path: join(dir, "pupkeep.sqlite"), models, registry: createRegistry() });
  try {
    await run(opened);
  } finally {
    await opened.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}

test("a fresh boot creates the household, puppy, activity, commands and two conversations", async () => {
  await withHarness(async (opened) => {
    const result = await bootstrapSession(opened.harness, {
      config: config(owner, partner),
      context,
      now,
      timezone: "Europe/Paris",
    });

    assert.equal(result.created, true);
    assert.equal(result.household.name, DEFAULT_HOUSEHOLD_NAME);
    assert.equal(result.household.timezone, "Europe/Paris");
    assert.deepEqual(result.household.members, [
      { id: "owner", name: "Owner" },
      { id: "partner", name: "Sam" },
    ]);
    assert.deepEqual(result.household.settings, DEFAULT_HOUSEHOLD_SETTINGS);
    assert.equal(result.household.createdAt, NOW.toISOString());
    assert.ok(result.household.conversationId > 0);
    assert.ok(result.household.systemConversationId > 0);
    assert.notEqual(result.household.conversationId, result.household.systemConversationId);
    assert.equal(result.profilesCreated, 2);
    assert.equal(result.profilesRemoved, 0);
    assert.deepEqual(result.docsCreated.sort(), [
      "app.activity",
      "app.commands",
      "app.household",
      "app.puppy",
    ]);

    assert.deepEqual(await opened.harness.snapshot(HouseholdDoc, context), result.household);
    const puppy = await opened.harness.snapshot(PuppyDoc, context);
    assert.equal(puppy?.schemaVersion, 1);
    assert.equal(puppy?.name, "");
    assert.equal(puppy?.createdAt, NOW.toISOString());
    const activity = await opened.harness.snapshot(ActivityDoc, context);
    assert.deepEqual(activity?.entries, []);
    const commands = await opened.harness.snapshot(CommandsDoc, context);
    assert.deepEqual(commands?.entries, []);

    const shared = await opened.harness.conversation(result.household.conversationId as ConversationId, context);
    const system = await opened.harness.conversation(result.household.systemConversationId as ConversationId, context);
    assert.ok(shared, "the human-facing thread exists");
    assert.ok(system, "the hidden system thread exists");
    assert.equal((await shared.agent(context)).model, undefined);
    assert.equal((await system.agent(context)).model, undefined, "the system conversation never gets a model");
  });
});

test("a second boot changes nothing and creates no new conversation", async () => {
  await withHarness(async (opened) => {
    const first = await bootstrapSession(opened.harness, { config: config(owner, partner), context, now });
    const second = await bootstrapSession(opened.harness, { config: config(owner, partner), context, now });

    assert.equal(second.created, false);
    assert.equal(second.household.conversationId, first.household.conversationId);
    assert.equal(second.household.systemConversationId, first.household.systemConversationId);
    assert.deepEqual(second.household, first.household);
    assert.deepEqual(second.docsCreated, []);
    assert.equal(second.profilesCreated, 0);
    assert.equal(second.profilesRemoved, 0);
    assert.deepEqual(await opened.harness.snapshot(HouseholdDoc, context), first.household);
  });
});

test("a removed member is not restored by a stale profile", async () => {
  await withHarness(async (opened) => {
    await bootstrapSession(opened.harness, { config: config(owner, partner), context, now });
    const removed = { ...partner, removedAt: "2026-10-29T11:00:00.000Z" };
    const afterRemoval = await bootstrapSession(opened.harness, { config: config(owner, removed), context, now });

    assert.equal(afterRemoval.profilesRemoved, 1);
    assert.deepEqual(afterRemoval.household.members, [{ id: "owner", name: "Owner" }]);
    assert.deepEqual((await opened.harness.snapshot(HouseholdDoc, context))?.members, [
      { id: "owner", name: "Owner" },
    ]);

    const again = await bootstrapSession(opened.harness, { config: config(owner, removed), context, now });
    assert.equal(again.profilesCreated, 0);
    assert.deepEqual(again.household.members, [{ id: "owner", name: "Owner" }]);
  });
});

test("a missing profile is repaired from config, with its config name", async () => {
  await withHarness(async (opened) => {
    await bootstrapSession(opened.harness, { config: config(owner), context, now });
    const repaired = await bootstrapSession(opened.harness, { config: config(owner, partner), context, now });

    assert.equal(repaired.profilesCreated, 1);
    assert.deepEqual(repaired.household.members, [
      { id: "owner", name: "Owner" },
      { id: "partner", name: "Sam" },
    ]);
  });
});

test("a household rename is kept even when config still says the seed name", async () => {
  await withHarness(async (opened) => {
    await bootstrapSession(opened.harness, { config: config(owner), context, now });
    await opened.harness.commit(async (tx) => {
      const draft = await tx.doc(HouseholdDoc);
      draft.members = [{ id: "owner", name: "Alex" }];
    }, context);

    const result = await bootstrapSession(opened.harness, { config: config(owner), context, now });
    assert.deepEqual(result.household.members, [{ id: "owner", name: "Alex" }]);
    assert.deepEqual(result.nameDrift, [{ id: "owner", profileName: "Alex", configName: "Owner" }]);
    assert.equal(result.profilesCreated, 0);
    assert.equal(result.profilesRemoved, 0);
  });
});

test("a missing conversation is a hard error, not a silent replacement", async () => {
  await withHarness(async (opened) => {
    const result = await bootstrapSession(opened.harness, { config: config(owner), context, now });
    await opened.harness.commit(async (tx) => {
      const draft = await tx.doc(HouseholdDoc);
      draft.conversationId = 999_999;
    }, context);

    await assert.rejects(
      bootstrapSession(opened.harness, { config: config(owner), context, now }),
      /missing conversation/,
    );
    // The document was not reset.
    assert.equal((await opened.harness.snapshot(HouseholdDoc, context))?.conversationId, 999_999);
    assert.ok(result.household.conversationId);
  });
});

test("config must have one or two active members", async () => {
  await withHarness(async (opened) => {
    await assert.rejects(
      bootstrapSession(opened.harness, { config: config(), context, now }),
      (error: unknown) => error instanceof BootstrapError && /no active member/.test(error.message),
    );
    await assert.rejects(
      bootstrapSession(opened.harness, {
        config: config(owner, partner, member({ id: "third", role: "member", displayName: "Third" })),
        context,
        now,
      }),
      (error: unknown) => error instanceof BootstrapError && /more than two/.test(error.message),
    );
    assert.equal(await opened.harness.snapshot(HouseholdDoc, context), undefined);
  });
});

test("an unknown household schemaVersion is refused instead of reset", async () => {
  await withHarness(async (opened) => {
    await bootstrapSession(opened.harness, { config: config(owner), context, now });
    await opened.harness.commit(async (tx) => {
      const draft = await tx.doc(HouseholdDoc);
      (draft as unknown as { schemaVersion: number }).schemaVersion = 2;
    }, context);

    await assert.rejects(
      bootstrapSession(opened.harness, { config: config(owner), context, now }),
      /app\.household is not a shape/,
    );
    const stored = await opened.harness.snapshot(HouseholdDoc, context);
    assert.equal((stored as unknown as { schemaVersion: number }).schemaVersion, 2);
  });
});

test("a model attached to the system conversation is cleared on boot", async () => {
  await withHarness(async (opened) => {
    const first = await bootstrapSession(opened.harness, { config: config(owner), context, now });
    const system = await opened.harness.conversation(first.household.systemConversationId as ConversationId, context);
    assert.ok(system);
    await system.configure(
      { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
      context,
    );
    assert.ok((await system.agent(context)).model, "the test set a model first");

    const repaired = await bootstrapSession(opened.harness, { config: config(owner), context, now });
    assert.equal(repaired.clearedSystemModel, true);
    assert.equal((await system.agent(context)).model, undefined);
  });
});

test("the document checkpoints after a bounded number of deltas", () => {
  const household: Household = emptyHousehold();
  assert.equal(HouseholdDoc.definition.checkpointWhen(household, [], { deltasSinceBase: 99 }), false);
  assert.equal(HouseholdDoc.definition.checkpointWhen(household, [], { deltasSinceBase: 100 }), true);
  assert.ok(parseHousehold(household) === undefined, "the empty initial value is never a valid persisted household");
});
