// Appending notification intents inside a care commit (PLAN §12.3, §14.3).
//
// One helper for every writer: the feeding service, the feed reminder task and
// the appointment reminder task all commit intents with the care action (or the
// terminal reminder decision), with the server's dedupe key authoritative and
// the category-only title from the frozen catalog. The appended list is parsed
// as a backstop before it is stored — a committed document the parser refuses
// would fail the next boot — so a bad body or a too-long list rolls the whole
// action back rather than corrupting `app.notifications`.
//
// `now` is the caller's server clock: the same instant stamps `createdAt` and
// the first `createdAt` of a document that reached a write without boot.

import type { Tx } from "@earendil-works/pi-durable";
import type { NotificationIntent } from "../../shared/domain.ts";
import { appendIntents, parseNotificationIntents } from "../../shared/notifications.ts";
import { NotificationsDoc } from "../domain/docs.ts";
import { DomainConflictError } from "../domain/errors.ts";

/** The one refusal for an intent list the document parser would not accept. */
export const NOTIFICATION_WRITE_RULE =
  "that change could not notify the household; the notification text is too long";

/**
 * Append intents in the caller's transaction, dropping ones the household
 * already has (by dedupe key) and enforcing the retention rule. Returns whether
 * the document changed, so a caller can report it; throws a domain sentence if
 * the resulting list would not parse.
 */
export async function appendNotificationIntents(
  tx: Tx,
  intents: readonly NotificationIntent[],
  now: Date,
): Promise<boolean> {
  if (intents.length === 0) return false;
  const notifications = await tx.doc(NotificationsDoc);
  if (notifications.createdAt === "") notifications.createdAt = now.toISOString();
  const items = appendIntents(notifications.items, intents);
  if (!parseNotificationIntents(items)) throw new DomainConflictError(NOTIFICATION_WRITE_RULE);
  notifications.items = items;
  return true;
}
