// Who made a care change (PLAN §7.1, §9.2).
//
// The label is resolved *inside* the commit that writes the change, from the
// household document the same transaction reads: a rename that landed since
// the caller's own read must not label the write with a name the household no
// longer has. HTTP already knows the member id; the agent tool has to find the
// speaker in the transcript, which is why the resolver takes the `tx`.
//
// `id: null` is the household fallback, and it always travels with the
// fallback label — see `HOUSEHOLD_FALLBACK_LABEL`.

import type { Tx } from "@earendil-works/pi-durable";
import type { Household } from "../../shared/domain.ts";

export type ActorRef = {
  /** Config member id, or `null` for the household fallback. */
  readonly id: string | null;
  readonly label: string;
};

export type ActorResolver = (tx: Tx, household: Household) => Promise<ActorRef>;
