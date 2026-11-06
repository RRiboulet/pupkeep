// Host-local notifications through Termux:API (PLAN §12.5, §16 P4-06).
//
// The host phone runs the server; on the daily Tailscale path it has no Web Push
// (HTTP), so its v1 transport is `termux-notification`. The plan's P0-08
// measurements fix the details:
//
//   * the channel is created **once** with `termux-notification-channel <id>
//     <name>`; an invalid channel id is dropped by Android while the command
//     still exits 0, so the outbox only passes `--channel` after creation
//     succeeded (`channelReady`).
//   * `--id` is stable per `(category, subject)` — the dedupe key hashed — so a
//     repeated reminder replaces the notification instead of stacking a second.
//   * the title is the category catalog text and the content is generic: a
//     lock-screen notification is a system surface, so no care text (§14.3).
//
// The exec is injectable so a test never spawns anything. Outside Termux the
// transport is absent, which leaves the intent pending — in-app is still there.

import { createHash } from "node:crypto";
import type { NotificationIntentCategory } from "../../shared/notifications.ts";
import { NOTIFICATION_PRIORITY, NOTIFICATION_TITLES } from "../../shared/notifications.ts";

export const TERMUX_CHANNEL_ID = "pupkeep";
export const TERMUX_CHANNEL_NAME = "Pupkeep";
export const TERMUX_CONTENT = "Open Pupkeep for details.";
export const TERMUX_TIMEOUT_MS = 5_000;

/** `execFile(file, args)` resolving when the command exits 0. */
export type ExecFile = (file: string, args: readonly string[]) => Promise<void>;

/** True on the host phone's Termux (the env var Termux sets in every session). */
export function termuxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.TERMUX_VERSION === "string" && env.TERMUX_VERSION !== "";
}

/** Priority copy: feeds and vet visits are the ones a caregiver must not miss. */
export function termuxPriority(category: NotificationIntentCategory): "default" | "high" {
  return NOTIFICATION_PRIORITY[category];
}

/** A stable Android notification id derived from the server's dedupe key. */
export function termuxNotificationId(dedupeKey: string): string {
  return createHash("sha1").update(dedupeKey).digest("hex").slice(0, 16);
}

/**
 * Create the channel once. Returns whether the notification command may pass
 * `--channel`; a failure is not fatal, the notification can still be posted
 * without a channel (the default channel), just with less grouping.
 */
export async function ensureTermuxChannel(exec: ExecFile): Promise<boolean> {
  try {
    await exec("termux-notification-channel", [TERMUX_CHANNEL_ID, TERMUX_CHANNEL_NAME]);
    return true;
  } catch {
    return false;
  }
}

export type TermuxNotification = {
  readonly dedupeKey: string;
  readonly category: NotificationIntentCategory;
};

/**
 * Post one notification. `channelReady` comes from `ensureTermuxChannel` at
 * boot: only then is `--channel` passed, so a missing channel cannot make
 * Android drop the notification silently.
 */
export async function sendTermux(
  exec: ExecFile,
  notification: TermuxNotification,
  channelReady: boolean,
): Promise<boolean> {
  const args = [
    "--id",
    termuxNotificationId(notification.dedupeKey),
    "--title",
    NOTIFICATION_TITLES[notification.category],
    "--content",
    TERMUX_CONTENT,
    "--priority",
    termuxPriority(notification.category),
    ...(channelReady ? ["--channel", TERMUX_CHANNEL_ID] : []),
  ];
  try {
    await exec("termux-notification", args);
    return true;
  } catch {
    return false;
  }
}
