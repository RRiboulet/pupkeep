// Bootstrapping the first four session documents (P1-08) and keeping them true.
//
// The first boot is one commit: two ownerless conversations (the human-facing
// thread and the hidden system thread) and the household, puppy, activity and
// commands documents. A crash therefore leaves either all of it or none of it;
// a second boot reads the household and only repairs what is missing.
//
// The household is the authority for display names after a profile exists.
// `config.json` is the authority for auth identities and roles: it seeds a
// missing profile, and a profile whose auth is gone is removed — never the other
// way round, so a removed member cannot be resurrected by a stale document.

import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { Activity, Commands, Household, MemberProfile, Puppy } from "../../shared/domain.ts";
import { activeMembers, reconcileMembers, type AppConfig, type Reconciliation } from "../config.ts";
import {
  ActivityDoc,
  CommandsDoc,
  HouseholdDoc,
  PuppyDoc,
  emptyActivity,
  emptyCommands,
  emptyHousehold,
  emptyPuppy,
  isIanaZone,
  parseActivity,
  parseCommands,
  parseHousehold,
  parseMemberProfiles,
  parsePuppy,
} from "./docs.ts";

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}

export interface BootstrapOptions {
  config: AppConfig;
  context: Context;
  /** Clock, injected by tests; defaults to the wall clock. */
  now?: () => Date;
  /** Override the runtime timezone; defaults to `Intl`'s resolved zone. */
  timezone?: string;
}

export interface BootstrapResult {
  created: boolean;
  household: Household;
  profilesCreated: number;
  profilesRemoved: number;
  nameDrift: Reconciliation["nameDrift"];
  docsCreated: string[];
  /** True when a model had been attached to the system conversation and was cleared. */
  clearedSystemModel: boolean;
}

function defaultTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isIanaZone(zone) ? zone : "UTC";
}

function duplicateMemberName(members: readonly MemberProfile[]): string | undefined {
  const seen = new Set<string>();
  for (const member of members) {
    const key = member.name.trim().toLowerCase();
    if (seen.has(key)) return member.name;
    seen.add(key);
  }
  return undefined;
}

function initialMembers(config: AppConfig): MemberProfile[] {
  const active = activeMembers(config);
  if (active.length === 0) {
    throw new BootstrapError("config.json has no active member; mint the owner before starting the server");
  }
  if (active.length > 2) {
    throw new BootstrapError("config.json has more than two active members; the household cap is two");
  }
  const members = active.map((member) => ({ id: member.id, name: member.displayName }));
  const duplicate = duplicateMemberName(members);
  if (duplicate) {
    throw new BootstrapError(`two members share the display name "${duplicate}"; rename one before starting`);
  }
  return members;
}

function initialHousehold(
  createdAt: string,
  timezone: string,
  members: MemberProfile[],
  sharedId: number,
  systemId: number,
): Household {
  return {
    ...emptyHousehold(),
    timezone,
    members,
    conversationId: sharedId,
    systemConversationId: systemId,
    createdAt,
  };
}

function initialPuppy(createdAt: string): Puppy {
  return { ...emptyPuppy(), createdAt };
}

function initialActivity(createdAt: string): Activity {
  return { ...emptyActivity(), createdAt };
}

function initialCommands(createdAt: string): Commands {
  return { ...emptyCommands(), createdAt };
}

async function clearSystemModel(harness: Harness, id: ConversationId, context: Context): Promise<boolean> {
  const conversation = await harness.conversation(id, context);
  if (!conversation) {
    throw new BootstrapError(`the system conversation ${id} does not exist`);
  }
  const agent = await conversation.agent(context);
  if (agent.model === undefined) return false;
  // The hidden thread owns reminder tasks; it must never be able to spend
  // budget. Repair a model attached by a bug or a partial migration.
  await conversation.configure({ model: null }, context);
  return true;
}

export async function bootstrapSession(
  harness: Harness,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const context = options.context;
  const now = options.now ?? (() => new Date());
  const members = initialMembers(options.config);
  const existing = await harness.snapshot(HouseholdDoc, context);

  if (existing === undefined) {
    // A household-less database with other session documents is a partial
    // restore/corruption, not a fresh install. Refuse rather than overwrite them.
    if ((await harness.snapshot(PuppyDoc, context)) !== undefined) {
      throw new BootstrapError("app.household is missing but app.puppy exists; refusing to reset it");
    }
    if ((await harness.snapshot(ActivityDoc, context)) !== undefined) {
      throw new BootstrapError("app.household is missing but app.activity exists; refusing to reset it");
    }
    if ((await harness.snapshot(CommandsDoc, context)) !== undefined) {
      throw new BootstrapError("app.household is missing but app.commands exists; refusing to reset it");
    }

    const createdAt = now().toISOString();
    const timezone = options.timezone ?? defaultTimezone();
    // Validate the zone before it is persisted; a bad value would break every
    // local-date computation later.
    if (!isIanaZone(timezone)) throw new BootstrapError(`not an IANA timezone: ${timezone}`);

    const ids = await harness.commit(async (tx) => {
      const shared = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const system = await tx.createConversation({ ownership: { kind: "ownerless" } });

      const household = await tx.doc(HouseholdDoc);
      Object.assign(household, initialHousehold(createdAt, timezone, members, shared.id, system.id));
      Object.assign(await tx.doc(PuppyDoc), initialPuppy(createdAt));
      Object.assign(await tx.doc(ActivityDoc), initialActivity(createdAt));
      Object.assign(await tx.doc(CommandsDoc), initialCommands(createdAt));

      return { shared: shared.id, system: system.id };
    }, context);

    const clearedSystemModel = await clearSystemModel(harness, ids.system, context);
    return {
      created: true,
      household: initialHousehold(createdAt, timezone, members, ids.shared, ids.system),
      profilesCreated: members.length,
      profilesRemoved: 0,
      nameDrift: [],
      docsCreated: ["app.household", "app.puppy", "app.activity", "app.commands"],
      clearedSystemModel,
    };
  }

  const household = parseHousehold(existing);
  if (!household) {
    throw new BootstrapError(
      "app.household is not a shape this build understands; refusing to reset it and lose members or settings",
    );
  }

  const shared = await harness.conversation(household.conversationId as ConversationId, context);
  if (!shared) {
    throw new BootstrapError(
      `app.household points at missing conversation ${household.conversationId}; refusing to create a replacement and lose the thread`,
    );
  }
  const system = await harness.conversation(household.systemConversationId as ConversationId, context);
  if (!system) {
    throw new BootstrapError(
      `app.household points at missing system conversation ${household.systemConversationId}; refusing to create a replacement`,
    );
  }

  const plan = reconcileMembers(options.config, household.members);
  const existingById = new Map(household.members.map((profile) => [profile.id, profile]));
  const creates = new Map(plan.createProfiles.map((profile) => [profile.id, profile]));
  const seededMembers = activeMembers(options.config).map(
    (member) => existingById.get(member.id) ?? creates.get(member.id)!,
  );
  const nextMembers = parseMemberProfiles(seededMembers);
  if (!nextMembers) {
    const duplicate = duplicateMemberName(seededMembers);
    throw new BootstrapError(
      duplicate
        ? `two members would share the display name "${duplicate}"; rename one before starting`
        : "the reconciled household profiles are invalid",
    );
  }
  const membersChanged =
    nextMembers.length !== household.members.length ||
    nextMembers.some(
      (member, index) =>
        member.id !== household.members[index]?.id || member.name !== household.members[index]?.name,
    );

  const puppySnapshot = await harness.snapshot(PuppyDoc, context);
  const puppy = puppySnapshot === undefined ? undefined : parsePuppy(puppySnapshot);
  if (puppySnapshot !== undefined && !puppy) {
    throw new BootstrapError("app.puppy is not a shape this build understands; refusing to reset it");
  }
  const activitySnapshot = await harness.snapshot(ActivityDoc, context);
  const activity = activitySnapshot === undefined ? undefined : parseActivity(activitySnapshot);
  if (activitySnapshot !== undefined && !activity) {
    throw new BootstrapError("app.activity is not a shape this build understands; refusing to reset it");
  }
  const commandsSnapshot = await harness.snapshot(CommandsDoc, context);
  const commands = commandsSnapshot === undefined ? undefined : parseCommands(commandsSnapshot);
  if (commandsSnapshot !== undefined && !commands) {
    throw new BootstrapError("app.commands is not a shape this build understands; refusing to reset it");
  }

  const docsCreated: string[] = [];
  if (!puppy) docsCreated.push("app.puppy");
  if (!activity) docsCreated.push("app.activity");
  if (!commands) docsCreated.push("app.commands");

  if (membersChanged || docsCreated.length > 0) {
    const createdAt = now().toISOString();
    await harness.commit(async (tx) => {
      if (membersChanged) {
        const draft = await tx.doc(HouseholdDoc);
        draft.members = nextMembers;
      }
      if (!puppy) Object.assign(await tx.doc(PuppyDoc), initialPuppy(createdAt));
      if (!activity) Object.assign(await tx.doc(ActivityDoc), initialActivity(createdAt));
      if (!commands) Object.assign(await tx.doc(CommandsDoc), initialCommands(createdAt));
    }, context);
  }

  const clearedSystemModel = await clearSystemModel(harness, household.systemConversationId as ConversationId, context);
  return {
    created: false,
    household: { ...household, members: nextMembers },
    profilesCreated: plan.createProfiles.length,
    profilesRemoved: plan.removeProfiles.length,
    nameDrift: plan.nameDrift,
    docsCreated,
    clearedSystemModel,
  };
}
