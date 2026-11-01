// The puppy profile as both sides see it (PLAN §8.1, §13.1).
//
// `app.puppy` stores only facts a human typed: name, birthday (a *local* date),
// breed, sex and a target weight. Age, the household roster and the revision
// are derived or held elsewhere, so the browser never has to mask a timezone
// itself and the agent cannot invent an age.
//
// The patch parser is shared on purpose: the HTTP route and the agent tool are
// two thin wrappers over one domain function, so they must accept exactly the
// same shape. It validates shape only; "a birthday cannot be in the future" is
// a clock question and the domain service answers it.

import type { MemberProfile, PuppySex } from "./domain.ts";

/** Longest name/breed a profile accepts, in characters. */
export const PROFILE_TEXT_LIMIT = 60;
/** A puppy weighing more than this is a typo, not a puppy. */
export const TARGET_WEIGHT_MAX_KG = 200;

/** The editable fields of `app.puppy`, as one value. */
export type PuppyFields = {
  name: string;
  birthday: string | null;
  breed: string | null;
  sex: PuppySex | null;
  targetWeightKg: number | null;
};

/** A partial edit; an absent field is left alone, an explicit `null` clears it. */
export type PuppyPatch = Partial<PuppyFields>;

/** Computed from `birthday` and the household-local date, never stored. */
export type PuppyAge = {
  days: number;
  weeks: number;
  /** Deterministic text such as "12 weeks old"; never model output. */
  label: string;
};

/**
 * What `GET /api/puppy`, `PATCH /api/puppy`, the `profile` SSE frame and the
 * `get_puppy` tool all return. `rev` is what the client echoes back on save.
 */
export type PuppyProfile = {
  rev: number;
  puppy: PuppyFields;
  age: PuppyAge | null;
  household: {
    name: string;
    timezone: string;
    members: MemberProfile[];
  };
  /** The household-local date the age was computed for (`YYYY-MM-DD`). */
  today: string;
};

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A syntactically valid `YYYY-MM-DD` that names a real day. */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !LOCAL_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** No control characters: a name is one line of text, not a second feed entry. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** True when `text` carries a control character (a newline, a NUL, a DEL). */
export function hasControlCharacter(text: string): boolean {
  return CONTROL_CHARACTERS.test(text);
}

function textOrNull(value: unknown, limit: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > limit) return undefined;
  // A newline here would let a crafted name forge a line in the activity feed
  // the other caregiver reads (and the agent quotes back).
  if (CONTROL_CHARACTERS.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Validate one patch. Returns `undefined` for anything this build does not
 * accept; unknown keys are refused rather than ignored, so a typo in a client
 * is visible instead of silently dropped. An empty patch is invalid too: it
 * would burn a revision for no change.
 */
export function parsePuppyPatch(raw: unknown): PuppyPatch | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const patch: PuppyPatch = {};

  for (const key of Object.keys(record)) {
    if (!["name", "birthday", "breed", "sex", "targetWeightKg"].includes(key)) return undefined;
  }

  if ("name" in record) {
    const name = textOrNull(record.name, PROFILE_TEXT_LIMIT);
    // A profile always has a name: `null`/"" would leave a nameless puppy.
    if (name === undefined || name === null) return undefined;
    patch.name = name;
  }
  if ("breed" in record) {
    const breed = textOrNull(record.breed, PROFILE_TEXT_LIMIT);
    if (breed === undefined) return undefined;
    patch.breed = breed;
  }
  if ("birthday" in record) {
    const birthday = record.birthday;
    if (birthday === null) patch.birthday = null;
    else if (isLocalDate(birthday)) patch.birthday = birthday;
    else return undefined;
  }
  if ("sex" in record) {
    const sex = record.sex;
    if (sex === null || sex === "male" || sex === "female") patch.sex = sex;
    else return undefined;
  }
  if ("targetWeightKg" in record) {
    const weight = record.targetWeightKg;
    if (weight === null) patch.targetWeightKg = null;
    else if (
      typeof weight === "number" &&
      Number.isFinite(weight) &&
      weight > 0 &&
      weight <= TARGET_WEIGHT_MAX_KG
    ) {
      patch.targetWeightKg = Math.round(weight * 100) / 100;
    } else return undefined;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}
