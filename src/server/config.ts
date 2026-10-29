// The data directory and the three JSON files that are not Pi Durable's.
//
// P1-04 landed `ensureDataDir`; this task gives the directory its files and the
// rules PLAN §7.1/§8.2 fix:
//
//   config.json  the authority for auth identities and roles (owner token hash,
//                invite hashes, session hashes, member records)
//   secrets.json provider keys — never in SQLite, never in the backup
//   push.json    VAPID keys, subscriptions, prefs, per-user ntfy topics — this
//                one *is* in the encrypted backup, deliberately, so push
//                subscriptions survive a restore
//
// All three are 0600 and written through `JsonFileStore` (one queue per file,
// temp + fsync + rename + fsync(dir)). Display names live in the household
// document; `reconcileMembers` below only mirrors them, and never resurrects a
// member whose auth record is gone.

import { chmod, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JsonFileStore, type JsonFileOptions } from "./json-file.ts";
import { parseModelProbeCache, PROBE_CACHE_VERSION, type ModelProbeCache } from "./models/cache.ts";

export const DATA_DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
export const OWNER_LINK_MODE = 0o600;
export const CONFIG_SCHEMA_VERSION = 1;

export interface DataDir {
  path: string;
  /** True when the mode had to be corrected; worth telling the owner once. */
  fixedMode: boolean;
}

/** Create the data directory if needed and make sure it is private. */
export async function ensureDataDir(path: string): Promise<DataDir> {
  const absolute = resolve(path);
  try {
    await mkdir(absolute, { recursive: true, mode: DATA_DIR_MODE });
  } catch (error) {
    // A path that exists as a file is the common mistake (a stray `--data` value);
    // say that, rather than echoing EEXIST at the operator.
    const existing = await stat(absolute).catch(() => undefined);
    if (existing && !existing.isDirectory()) {
      throw new Error(`the data path is not a directory: ${absolute}`);
    }
    throw new Error(`cannot create the data directory ${absolute}: ${(error as Error).message}`);
  }

  const info = await stat(absolute);
  if (!info.isDirectory()) {
    throw new Error(`the data path is not a directory: ${absolute}`);
  }
  let fixedMode = false;
  if ((info.mode & 0o777) !== DATA_DIR_MODE) {
    // An existing directory may have been created by a loose umask; a data
    // directory holding secrets must not be world-readable.
    await chmod(absolute, DATA_DIR_MODE);
    fixedMode = true;
  }
  return { path: absolute, fixedMode };
}

export interface DataPaths {
  root: string;
  config: string;
  secrets: string;
  push: string;
  models: string;
  ownerLink: string;
}

export function dataPaths(dataDir: string): DataPaths {
  const root = resolve(dataDir);
  return {
    root,
    config: join(root, "config.json"),
    secrets: join(root, "secrets.json"),
    push: join(root, "push.json"),
    models: join(root, "models.json"),
    ownerLink: join(root, "owner-link.txt"),
  };
}

export function ownerLinkPath(dataDir: string): string {
  return dataPaths(dataDir).ownerLink;
}

// --- config.json -----------------------------------------------------------

export type MemberRole = "owner" | "member";

export interface SessionRecord {
  /** Hash of the session token; the token itself is only ever in a cookie. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
}

export interface MemberRecord {
  id: string;
  role: MemberRole;
  displayName: string;
  createdAt: string;
  /** Set when the member is removed; the record is kept so boot cannot undo it. */
  removedAt?: string;
  /** One-time invite, cleared once accepted. */
  inviteHash?: string;
  sessions: SessionRecord[];
}

export interface AppConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  /** Hash of the owner sign-in token; null until the first mint. */
  ownerTokenHash: string | null;
  members: MemberRecord[];
}

export function emptyConfig(): AppConfig {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, ownerTokenHash: null, members: [] };
}

export function activeMembers(config: AppConfig): MemberRecord[] {
  return config.members.filter((member) => member.removedAt === undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseSession(value: unknown): SessionRecord | undefined {
  const record = asRecord(value);
  if (!record || typeof record.tokenHash !== "string" || typeof record.createdAt !== "string") {
    return undefined;
  }
  return {
    tokenHash: record.tokenHash,
    createdAt: record.createdAt,
    ...(typeof record.lastSeenAt === "string" ? { lastSeenAt: record.lastSeenAt } : {}),
  };
}

function parseMember(value: unknown): MemberRecord | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { id, role, displayName, createdAt, removedAt, inviteHash, sessions } = record;
  if (typeof id !== "string" || id === "") return undefined;
  if (role !== "owner" && role !== "member") return undefined;
  if (typeof displayName !== "string") return undefined;
  if (typeof createdAt !== "string") return undefined;

  const parsedSessions: SessionRecord[] = [];
  for (const item of Array.isArray(sessions) ? sessions : []) {
    const session = parseSession(item);
    if (!session) return undefined;
    parsedSessions.push(session);
  }

  return {
    id,
    role,
    displayName,
    createdAt,
    sessions: parsedSessions,
    ...(typeof removedAt === "string" ? { removedAt } : {}),
    ...(typeof inviteHash === "string" ? { inviteHash } : {}),
  };
}

export function parseConfig(raw: unknown): AppConfig | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  if (record.schemaVersion !== CONFIG_SCHEMA_VERSION) return undefined;
  if (record.ownerTokenHash !== null && typeof record.ownerTokenHash !== "string") return undefined;
  if (!Array.isArray(record.members)) return undefined;

  const members: MemberRecord[] = [];
  for (const item of record.members) {
    const member = parseMember(item);
    if (!member) return undefined; // a half-valid config is not a config
    members.push(member);
  }

  const ids = new Set(members.map((member) => member.id));
  if (ids.size !== members.length) return undefined;

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    ownerTokenHash: record.ownerTokenHash as string | null,
    members,
  };
}

// --- secrets.json ----------------------------------------------------------

export interface SecretsConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  /** provider id → API key. Never leaves this file except to a provider call. */
  providerKeys: Record<string, string>;
}

export function emptySecrets(): SecretsConfig {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, providerKeys: {} };
}

export function parseSecrets(raw: unknown): SecretsConfig | undefined {
  const record = asRecord(raw);
  if (!record || record.schemaVersion !== CONFIG_SCHEMA_VERSION) return undefined;
  const keys = asRecord(record.providerKeys);
  if (!keys) return undefined;

  const providerKeys: Record<string, string> = {};
  for (const [provider, value] of Object.entries(keys)) {
    if (typeof value !== "string") return undefined;
    providerKeys[provider] = value;
  }
  return { schemaVersion: CONFIG_SCHEMA_VERSION, providerKeys };
}

// --- push.json -------------------------------------------------------------

export interface PushSubscriptionRecord {
  id: string;
  memberId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
}

export type NotificationCategory = "appointment" | "feed_overdue" | "fed" | "approval" | "test";

export interface NotificationPrefs {
  enabled: boolean;
  categories: NotificationCategory[];
}

export interface PushConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  /** Absent until P4-05 generates a key pair; rotating it invalidates every subscription. */
  vapid: { publicKey: string; privateKey: string } | null;
  subscriptions: PushSubscriptionRecord[];
  /** memberId → prefs. */
  prefs: Record<string, NotificationPrefs>;
  /** memberId → ntfy topic (the partner's daily transport). */
  ntfy: Record<string, { topic: string }>;
}

export function emptyPush(): PushConfig {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, vapid: null, subscriptions: [], prefs: {}, ntfy: {} };
}

const CATEGORIES: ReadonlySet<string> = new Set<NotificationCategory>([
  "appointment",
  "feed_overdue",
  "fed",
  "approval",
  "test",
]);

function parseSubscription(value: unknown): PushSubscriptionRecord | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { id, memberId, endpoint, p256dh, auth, createdAt } = record;
  if ([id, memberId, endpoint, p256dh, auth, createdAt].some((field) => typeof field !== "string")) {
    return undefined;
  }
  return {
    id: id as string,
    memberId: memberId as string,
    endpoint: endpoint as string,
    p256dh: p256dh as string,
    auth: auth as string,
    createdAt: createdAt as string,
  };
}

export function parsePush(raw: unknown): PushConfig | undefined {
  const record = asRecord(raw);
  if (!record || record.schemaVersion !== CONFIG_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(record.subscriptions)) return undefined;

  const subscriptions: PushSubscriptionRecord[] = [];
  for (const item of record.subscriptions) {
    const subscription = parseSubscription(item);
    if (!subscription) return undefined;
    subscriptions.push(subscription);
  }

  let vapid: PushConfig["vapid"] = null;
  if (record.vapid !== null && record.vapid !== undefined) {
    const keys = asRecord(record.vapid);
    if (!keys || typeof keys.publicKey !== "string" || typeof keys.privateKey !== "string") return undefined;
    vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  }

  const prefs: Record<string, NotificationPrefs> = {};
  const rawPrefs = asRecord(record.prefs) ?? {};
  for (const [memberId, value] of Object.entries(rawPrefs)) {
    const prefsRecord = asRecord(value);
    if (!prefsRecord || typeof prefsRecord.enabled !== "boolean") return undefined;
    if (!Array.isArray(prefsRecord.categories)) return undefined;
    const categories: NotificationCategory[] = [];
    for (const category of prefsRecord.categories) {
      if (typeof category !== "string" || !CATEGORIES.has(category)) return undefined;
      categories.push(category as NotificationCategory);
    }
    prefs[memberId] = { enabled: prefsRecord.enabled, categories };
  }

  const ntfy: Record<string, { topic: string }> = {};
  const rawNtfy = asRecord(record.ntfy) ?? {};
  for (const [memberId, value] of Object.entries(rawNtfy)) {
    const ntfyRecord = asRecord(value);
    if (!ntfyRecord || typeof ntfyRecord.topic !== "string") return undefined;
    ntfy[memberId] = { topic: ntfyRecord.topic };
  }

  return { schemaVersion: CONFIG_SCHEMA_VERSION, vapid, subscriptions, prefs, ntfy };
}

// --- stores ----------------------------------------------------------------

export interface DataStores {
  paths: DataPaths;
  config: JsonFileStore<AppConfig>;
  secrets: JsonFileStore<SecretsConfig>;
  push: JsonFileStore<PushConfig>;
  models: JsonFileStore<ModelProbeCache>;
}

function store<T>(options: JsonFileOptions<T>): JsonFileStore<T> {
  return new JsonFileStore<T>({ ...options, mode: FILE_MODE });
}

export function dataStores(dataDir: string): DataStores {
  const paths = dataPaths(dataDir);
  return {
    paths,
    config: store({ path: paths.config, parse: parseConfig, initial: emptyConfig }),
    secrets: store({ path: paths.secrets, parse: parseSecrets, initial: emptySecrets }),
    push: store({ path: paths.push, parse: parsePush, initial: emptyPush }),
    models: store({
      path: paths.models,
      parse: parseModelProbeCache,
      initial: () => ({ version: PROBE_CACHE_VERSION, checkedAt: new Date(0).toISOString(), results: [] }),
    }),
  };
}

// --- reconciliation --------------------------------------------------------

export interface HouseholdProfile {
  memberId: string;
  displayName: string;
}

export interface Reconciliation {
  /** Profiles to create for members that exist in config but not in the document. */
  createProfiles: HouseholdProfile[];
  /** Display names that drifted from config; config wins. */
  updateProfiles: Array<{ memberId: string; from: string; to: string }>;
  /** Profiles to drop: their config record is gone or the member was removed. */
  removeProfiles: string[];
}

/**
 * PLAN §7.1: `config.json` is the authority. Boot may *mirror* a member into the
 * household document, and may remove a profile whose auth is gone — but it must
 * never create auth from a profile, so a removed member stays removed even if the
 * document still mentions them.
 */
export function reconcileMembers(
  config: AppConfig,
  profiles: readonly HouseholdProfile[],
): Reconciliation {
  const active = new Map(activeMembers(config).map((member) => [member.id, member]));
  const existing = new Map(profiles.map((profile) => [profile.memberId, profile]));

  const createProfiles: HouseholdProfile[] = [];
  for (const member of active.values()) {
    const profile = existing.get(member.id);
    if (!profile) createProfiles.push({ memberId: member.id, displayName: member.displayName });
  }

  const updateProfiles: Reconciliation["updateProfiles"] = [];
  for (const member of active.values()) {
    const profile = existing.get(member.id);
    if (profile && profile.displayName !== member.displayName) {
      updateProfiles.push({ memberId: member.id, from: profile.displayName, to: member.displayName });
    }
  }

  const removeProfiles: string[] = [];
  for (const profile of profiles) {
    if (!active.has(profile.memberId)) removeProfiles.push(profile.memberId);
  }

  return { createProfiles, updateProfiles, removeProfiles };
}
