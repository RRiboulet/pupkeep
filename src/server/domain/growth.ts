// The growth service (PLAN §8.1, §8.3, §8.4, §7.3, §7.4, §9.2).
//
// One writer, one document: `logMeasurement` appends a measurement and, in the
// same commit, one activity entry and the `app.commands` idempotency record.
//
// The decisions live in `shared/growth.ts` (the shape, the gram precision, the
// derived series); this module adds the two things that need the server: the
// clock (which decides `localDate` in the household zone — never client input,
// §8.4) and the actor (resolved inside the commit from the household it reads,
// §9.2). The target weight is deliberately not written here: it is a field of
// `app.puppy` with its own revision (P1-11), and a measurement commit must not
// become a second way to change it.
//
// A measurement has no revision and no conflict rule. Unlike a feed, which
// claims one meal per slot and day, weighing the puppy twice is legitimate; the
// day's latest reading is what the chart and P3-02's windows use, and the
// history keeps both. So the only refusal is an invalid shape, answered with
// `MEASUREMENT_RULE`. The fields are normalised *before* the idempotency lookup
// so that a retry with padded text or extra decimals hashes as the same request
// (§7.3); an invalid body is refused before a key could be burnt.

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Growth, GrowthMeasurement } from "../../shared/domain.ts";
import {
  MEASUREMENT_RULE,
  formatWeightKg,
  parseGrowthMeasurement,
  parseGrowthMeasurements,
  parseMeasurementFields,
} from "../../shared/growth.ts";
import { activityEntry, appendActivity } from "./activity.ts";
import type { ActorResolver } from "./actor.ts";
import { requestHashOf, runIdempotent, type CommandOutcome } from "./commands.ts";
import { ActivityDoc, GrowthDoc, HouseholdDoc, parseGrowth, type DocStore } from "./docs.ts";
import { DomainConflictError, UnavailableError } from "./errors.ts";
import { localDateAt } from "./time.ts";

/** `app.growth` is missing or unreadable; retry once the server has booted. */
export class GrowthUnavailableError extends UnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "GrowthUnavailableError";
  }
}

/** The measurement history. Boot keeps the document present. */
export async function readGrowth(store: DocStore, context: Context): Promise<Growth> {
  const snapshot = await store.snapshot(GrowthDoc, context);
  const growth = snapshot === undefined ? undefined : parseGrowth(snapshot);
  if (!growth) throw new GrowthUnavailableError("the growth history is not available; retry after boot");
  return growth;
}

export type MeasurementWrite = {
  /** Resolved inside the commit, through the household the write reads. */
  readonly actor: ActorResolver;
  /** The HTTP idempotency key or the agent tool's task id, namespaced (§7.3). */
  readonly actionId: string;
  /** Kilograms; normalised to whole grams inside the commit. */
  readonly weightKg: number;
  readonly heightCm?: number;
  readonly note?: string;
  /** `ui` from the route, `agent` from a tool (P3-03). */
  readonly source: GrowthMeasurement["source"];
  /** Server clock; injected by tests. */
  readonly now?: Date;
  /** Test seam for the measurement id. */
  readonly id?: string;
};

export type MeasurementOutcome =
  | { kind: "logged" | "replayed"; measurement: GrowthMeasurement }
  /** One idempotency key was reused for a different request. */
  | { kind: "key-conflict" };

/**
 * Append one measurement. The clock (the local date) and the actor are resolved
 * inside the callback, so a replay returns the recorded measurement rather than
 * re-deriving a date or a label from a later clock or a renamed member.
 */
export async function logMeasurement(
  store: DocStore,
  context: Context,
  input: MeasurementWrite,
): Promise<MeasurementOutcome> {
  const now = input.now ?? new Date();

  // Normalised once, so a padded note or extra decimals describe one request:
  // the same key retried with `" 4.20 kg "` and `4.2 kg` must replay, not
  // collide. `parseMeasurementFields` is the same parser the route and the tool
  // (P3-03) will call, so the hash cannot drift from the validated value. A
  // replay of the same body therefore passes this check too — it is never
  // re-judged against a later clock or a renamed member.
  const fields = parseMeasurementFields({
    weightKg: input.weightKg,
    ...(input.heightCm !== undefined ? { heightCm: input.heightCm } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
  if (!fields) throw new DomainConflictError(MEASUREMENT_RULE);
  const request = {
    weightKg: fields.weightKg,
    heightCm: fields.heightCm ?? null,
    note: fields.note ?? null,
    source: input.source,
  } as JsonObject;

  const outcome: CommandOutcome<{ measurement: GrowthMeasurement }> = await runIdempotent(
    { store, context },
    { key: input.actionId, requestHash: requestHashOf(request), now },
    async (tx) => {
      const household = await tx.doc(HouseholdDoc);
      const actor = await input.actor(tx, household);
      const localDate = localDateAt(now, household.timezone);

      const measurement: GrowthMeasurement = {
        id: input.id ?? randomUUID(),
        localDate,
        at: now.toISOString(),
        weightKg: fields.weightKg,
        byUserId: actor.id,
        byLabel: actor.label,
        source: input.source,
        actionId: input.actionId,
      };
      if (fields.heightCm !== undefined) measurement.heightCm = fields.heightCm;
      if (fields.note !== undefined) measurement.note = fields.note;

      // Backstop, as `logFeed` does: a document the parser refuses would fail
      // the next boot, so the appended list is validated before it is stored.
      const parsed = parseGrowthMeasurement(measurement);
      if (!parsed) throw new DomainConflictError(MEASUREMENT_RULE);
      const draft = await tx.doc(GrowthDoc);
      // Bootstrap seeds `createdAt`; a harness that reaches a write without a
      // boot still gets a real one rather than storing an unparseable value.
      if (draft.createdAt === "") draft.createdAt = now.toISOString();
      const measurements = [...draft.measurements, parsed];
      if (!parseGrowthMeasurements(measurements)) {
        throw new DomainConflictError(MEASUREMENT_RULE);
      }
      draft.measurements = measurements;

      appendActivity(
        await tx.doc(ActivityDoc),
        activityEntry({
          kind: "growth.measurement",
          // The weight is household data, not free text: it is safe in a
          // one-line feed, and `formatWeightKg` is the one unit rule.
          summary: `${actor.label} logged a weight of ${formatWeightKg(parsed.weightKg)}`,
          actorId: actor.id,
          actorLabel: actor.label,
          now,
        }),
      );

      return { measurement: parsed };
    },
  );

  if (outcome.kind === "conflict") return { kind: "key-conflict" };
  const recorded = (outcome.kind === "replayed" ? outcome.result : outcome.value) as {
    measurement: GrowthMeasurement;
  };
  return { kind: outcome.kind === "replayed" ? "replayed" : "logged", measurement: recorded.measurement };
}
