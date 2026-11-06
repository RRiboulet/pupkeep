// The calendar extension: the agent's only way to read the appointments
// (PLAN §10.1, §10.3, §16 P4-02).
//
// The read is free: it answers the household's own calendar state and calls
// nothing else. The **write** tools — create, update, request-cancel — are
// deliberately absent until P4-07: an appointment is a schedule change, and the
// plan's confirmation rule (§9.3, §13.3) makes an agent-created or
// agent-cancelled appointment a human-confirmed action, not a direct commit. A
// tool that committed directly here would bypass the approval the plan
// promises, so the extension ships with reads only and P4-07 adds the proposal
// tools beside the approval document.
//
// The shape and validation live in `shared/calendar.ts`; this file is the thin
// translation the model reads, sharing `calendarView` with the HTTP route so the
// two cannot disagree about a range or a derived instant.

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  CALENDAR_WINDOW_RULE,
  parseCalendarWindow,
} from "../../shared/calendar.ts";
import { UnavailableError } from "../domain/errors.ts";
import { calendarView, readCalendar } from "../domain/calendar.ts";
import { readHousehold } from "../domain/household.ts";
import { localDateAt } from "../domain/time.ts";
import { calendarReportText } from "./calendar-text.ts";
import { refused, text } from "./tool-kit.ts";

/** The calendar tools, as one extension so a conversation selects them together. */
export function createCalendarTools(): Extension<ToolRegistration> {
  const listAppointments = defineTool({
    name: "list_appointments",
    description:
      "Read appointments in a household-local date range: date, start and end time, title, place, vet, note, " +
      "status and reminder offsets, plus the next scheduled appointment. Defaults to today and the next 90 days. " +
      "It reports state only and carries no advice.",
    parameters: Type.Object({
      from: Type.Optional(
        Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "First local date, YYYY-MM-DD." }),
      ),
      to: Type.Optional(
        Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Last local date, YYYY-MM-DD (inclusive)." }),
      ),
    }),
    execute: async (args, api, context: Context) => {
      const now = new Date(api.now());
      try {
        // One household read feeds the zone, the default range and the default
        // reminder offsets, so a timezone change cannot split the answer.
        const household = await readHousehold(api, context);
        const today = localDateAt(now, household.timezone);
        const window = parseCalendarWindow(args.from, args.to, today);
        if (!window) return refused(`${CALENDAR_WINDOW_RULE}. Nothing was read.`);
        const view = calendarView(household, await readCalendar(api, context), now, window);
        return text(calendarReportText(view));
      } catch (error) {
        // Not ready is a sentence, not a failed task (the feeding tools' rule).
        if (!(error instanceof UnavailableError)) throw error;
        return refused("The calendar is not available yet; retry after boot.");
      }
    },
  });

  return defineExtension({ name: "calendar", tools: [listAppointments] });
}
