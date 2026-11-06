// ntfy delivery for the partner's daily path (PLAN §12.3, §2.1, §16 P4-06).
//
// Tailscale is HTTP, so the partner's iPhone cannot receive Web Push on the
// daily path. ntfy is the recommended transport there: a public relay topic that
// is a bearer secret (in `~/.pupkeep`, `0600`, never logged), carrying the
// **category title only**. No care text, no body, no click URL (there is no
// public origin to point at; P4-09's runbook explains the tap-through).
//
// The request is injectable so tests never touch ntfy.sh. A 403 usually means a
// reserved or revoked topic and a 429 is a rate limit; both are failures the
// outbox retries with its backoff. There is no "gone" for ntfy: a member can
// always set a new topic.

import type { NotificationIntentCategory } from "../../shared/notifications.ts";
import { NOTIFICATION_PRIORITY, NOTIFICATION_TITLES } from "../../shared/notifications.ts";

export const NTFY_BASE_URL = "https://ntfy.sh";
export const NTFY_TIMEOUT_MS = 10_000;

export type NtfyTransport = (url: string, init: RequestInit) => Promise<Response>;

export type NtfySendResult =
  | { kind: "sent"; status: number }
  | { kind: "failed"; status: number | null; error?: string };

export type NtfyOptions = {
  /** Test seam; ntfy.sh otherwise. */
  readonly transport?: NtfyTransport;
};

/**
 * Publish one category title to a topic. The body is the same title: ntfy shows
 * the body, and the plan allows the title and category text only.
 */
export async function sendNtfy(
  topic: string,
  category: NotificationIntentCategory,
  options: NtfyOptions = {},
): Promise<NtfySendResult> {
  const transport = options.transport ?? ((url, init) => fetch(url, init));
  const title = NOTIFICATION_TITLES[category];
  try {
    const response = await transport(`${NTFY_BASE_URL}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: NOTIFICATION_PRIORITY[category],
      },
      body: title,
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
    return response.status >= 200 && response.status < 300
      ? { kind: "sent", status: response.status }
      : { kind: "failed", status: response.status };
  } catch (error) {
    return { kind: "failed", status: null, error: (error as Error).message };
  }
}
