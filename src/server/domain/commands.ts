// `app.commands`: one committed result per idempotency key (PLAN §7.4, §8.1).
//
// A care action is acknowledged only after its commit, and the client may lose
// the response: a double-tap, a phone that slept mid-request, a crash between
// the commit and the reply. The key is written **in the same commit** as the
// action, so a replay either finds the record (the action happened) or does not
// (it did not). Returning the recorded result is success, not a conflict; the
// same key with a *different* request is a conflict, because one key cannot
// honestly describe two different actions.
//
// The record is capped at 24 h and 1000 entries (§8.1). P2's feeding service
// reuses this helper; P1-11 is the first caller (profile edits).

import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord";
import { createHash } from "node:crypto";
import type { Tx } from "@earendil-works/pi-durable";
import type { CommandRecord, Commands } from "../../shared/domain.ts";
import { CommandsDoc, parseCommands, type DocStore } from "./docs.ts";
import { UnavailableError } from "./errors.ts";

/** PLAN §7.4: an idempotency record lives for a day. */
export const COMMAND_TTL_MS = 24 * 60 * 60 * 1000;
/** PLAN §8.1: the commands document keeps at most 1000 records. */
export const COMMAND_LIMIT = 1000;
/**
 * Longest stored key. A client key is at most 100 characters and the callers
 * namespace it (`http:`/`tool:`), so the stored form allows a little more.
 */
export const COMMAND_KEY_LIMIT = 120;
/** A client-supplied key stays shorter; the namespace prefix is not the client's. */
export const CLIENT_KEY_LIMIT = 100;

export type CommandOutcome<T extends JsonValue> =
  | { kind: "committed"; value: T }
  | { kind: "replayed"; result: JsonValue }
  | { kind: "conflict" };

export interface CommandRef {
  /** Committed reads and one commit. A `Harness` and a tool's `api` both fit. */
  readonly store: DocStore;
  readonly context: Context;
}

export interface CommandRequest {
  /** HTTP `Idempotency-Key`, or the tool task's id (§10.3). */
  readonly key: string;
  /** Hash of the normalised request; one key, one request. */
  readonly requestHash: string;
  readonly now: Date;
}

const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * One key, two different requests. A private sentinel rather than a domain
 * refusal: a `change()` callback that refuses (P2's already-fed slot) must
 * surface as its own 409, never as "this key was used for another request".
 */
class KeyCollisionError extends Error {
  constructor() {
    super("that idempotency key was used for a different request");
    this.name = "KeyCollisionError";
  }
}

export function isCommandKey(value: unknown, limit = COMMAND_KEY_LIMIT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && KEY_PATTERN.test(value);
}

/**
 * A deterministic hash of a request value. Object keys are sorted, so two
 * clients that build the same map in a different order hash the same, and the
 * hash is hex rather than a serialized body (no request text in the document).
 */
export function requestHashOf(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, JsonValue>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

function isLive(record: CommandRecord, now: Date): boolean {
  return Date.parse(record.expiresAt) > now.getTime();
}

async function readCommands(ref: CommandRef): Promise<Commands | undefined> {
  const snapshot = await ref.store.snapshot(CommandsDoc, ref.context);
  if (snapshot === undefined) return undefined;
  const commands = parseCommands(snapshot);
  if (!commands) throw new UnavailableError("app.commands is not a shape this build understands");
  return commands;
}

/**
 * Run `change` at most once per key, in the commit that also records the key.
 *
 * `change` runs inside the transaction: read and write only through `tx`, and
 * throw to refuse (which rolls the whole commit back, key included). The value
 * it returns must be JSON: it is the recorded result a replay answers with.
 */
export async function runIdempotent<T extends JsonValue>(
  ref: CommandRef,
  request: CommandRequest,
  change: (tx: Tx) => Promise<T>,
): Promise<CommandOutcome<T>> {
  // The one place that writes a key. A caller that builds one outside the
  // pattern fails here loudly instead of storing an unsearchable record.
  if (!isCommandKey(request.key)) throw new Error("the idempotency key is not storable");
  // A cheap pre-read keeps the common replay off the mutation line; the commit
  // below re-checks, because two replays can pass this point together.
  const before = await readCommands(ref);
  const known = before?.entries.find((entry) => entry.key === request.key && isLive(entry, request.now));
  if (known) {
    return known.requestHash === request.requestHash
      ? { kind: "replayed", result: known.result }
      : { kind: "conflict" };
  }

  let replayed: JsonValue | undefined;
  let committed: T | undefined;
  try {
    await ref.store.commit(async (tx) => {
      const commands = await tx.doc(CommandsDoc);
      const existing = commands.entries.find((entry) => entry.key === request.key && isLive(entry, request.now));
      if (existing) {
        if (existing.requestHash !== request.requestHash) throw new KeyCollisionError();
        replayed = existing.result;
        return;
      }

      const value = await change(tx);
      const expiresAt = new Date(request.now.getTime() + COMMAND_TTL_MS).toISOString();
      // Drop expired records here, not on a timer: the document is small and one
      // write path is easier to reason about than a background sweep.
      const kept = commands.entries.filter((entry) => isLive(entry, request.now));
      commands.entries = [...kept, { key: request.key, requestHash: request.requestHash, result: value, expiresAt }].slice(
        -COMMAND_LIMIT,
      );
      committed = value;
    }, ref.context);
  } catch (error) {
    // Only our own sentinel becomes "conflict"; a refusal thrown by `change` is
    // the domain's answer to *this* request and must reach the caller unchanged.
    if (error instanceof KeyCollisionError) return { kind: "conflict" };
    throw error;
  }

  if (replayed !== undefined) return { kind: "replayed", result: replayed };
  if (committed === undefined) {
    // Neither branch ran: unreachable unless `harness.commit` resolves without
    // invoking its callback, which would mean the Session is not the one we
    // think it is. Fail loudly instead of answering success with no result.
    throw new UnavailableError("the command commit did not run");
  }
  return { kind: "committed", value: committed };
}
