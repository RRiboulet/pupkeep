// The tool the P5-01 mid-turn kill runs (PLAN §7.4, §15.2).
//
// A kill during an agent turn has to land *between* two commits — the tool
// intent (committed before `execute()` runs) and the tool result (committed
// after it) — and a real care tool commits in milliseconds, so the window is
// too small to hit on purpose. This tool makes that window explicit: it performs
// a real, replay-safe care write through the same domain function the product
// uses, then writes a marker and (when asked) never resolves. The parent kills
// the process once the marker appears, which is exactly "the write committed, the
// result did not".
//
// What makes the rerun safe is not this file: `logFeed` is idempotent on the
// tool task id, which is the property `log_feeding` relies on in production. The
// probe exists to prove the *process* can die in that window and come back to
// one write, not to test a second implementation of idempotency.

import { rename, writeFile } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { speakerSeam, text } from "../agent/tool-kit.ts";
import { logFeed } from "../domain/feeding.ts";

/** The note every probe event carries, so a test can find its own write. */
export const KILL_PROBE_NOTE = "kill-probe";

/** The one tool name; the child and the reopened app must declare the same one. */
export const KILL_PROBE_TOOL = "log_kill_probe";

export interface KillProbeOptions {
  /**
   * Write this marker once the care write is committed. Write-then-rename: the
   * parent polls with `stat().isFile()`, and a plain write would let it see a
   * half-written file.
   */
  markerPath?: string;
  /** Never resolve after the marker, so the tool result is never committed. */
  hang?: boolean;
  /** Pinned clock, so the committed `localDate` is deterministic on both sides. */
  now?: Date;
}

export function createKillProbe(options: KillProbeOptions = {}) {
  const probe = defineTool({
    name: KILL_PROBE_TOOL,
    description: "Log an ad-hoc probe feeding. Used by the kill/restart matrix, not by caregivers.",
    parameters: Type.Object({}),
    // The same policy every care tool has: the domain write is idempotent on
    // `api.taskId`, so a rerun after a crash returns the recorded event.
    replay: "safe",
    execute: async (_args: unknown, api, context: Context) => {
      const speaker = await speakerSeam(api, context);
      const outcome = await logFeed(api, context, {
        actor: speaker.actor,
        actionId: `tool:${api.taskId}`,
        slotId: null,
        note: KILL_PROBE_NOTE,
        source: "agent",
        ...(options.now ? { now: options.now } : {}),
      });
      if (options.markerPath !== undefined) {
        const staged = `${options.markerPath}.partial`;
        await writeFile(staged, `${outcome.kind}\n`, { mode: 0o600 });
        await rename(staged, options.markerPath);
      }
      // After the commit, as a real tool does: the memo shortens the rerun's
      // speaker scan and is never fatal.
      await speaker.remember();
      if (options.hang === true) return new Promise<never>(() => undefined);
      return text(`Logged a probe feeding (${outcome.kind}).`);
    },
  });
  return defineExtension({ name: "kill-probe", tools: [probe] });
}
