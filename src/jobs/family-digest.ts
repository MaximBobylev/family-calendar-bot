// Участник дома без своего Google получает сводку по общим календарям дома через аккаунт владельца.

import { whenOfAssignment } from "../bot/assign/view";
import { GoogleCalendarProvider } from "../calendar/google-provider";
import type { CalendarProvider } from "../calendar/model";
import { localToUtc, type Day } from "../dates/calendar";
import type { AppContext } from "../bot/context";
import { escapeHtml } from "../bot/format";
import { t } from "../bot/messages";
import { hasGoogleAccount } from "../db/accounts";
import { assignmentsDueBetween } from "../db/assignments";
import { membershipOf } from "../db/households";
import { privateScope } from "../bot/household/scope";
import type { User } from "../db/users";

export async function hasDigestSource(db: D1Database, userId: string): Promise<boolean> {
  return (await hasGoogleAccount(db, userId)) || (await membershipOf(db, userId)) !== null;
}

export async function digestProvider(ctx: AppContext, user: User): Promise<CalendarProvider | null> {
  const scope = await privateScope(ctx, user.id);
  if (scope) return scope.calendarIds.length ? new GoogleCalendarProvider(ctx.config, ctx.db, scope.ownerUserId, ctx.clock, scope.calendarIds) : null;
  return (await hasGoogleAccount(ctx.db, user.id)) ? new GoogleCalendarProvider(ctx.config, ctx.db, user.id, ctx.clock) : null;
}

export async function assignmentsBlock(
  ctx: AppContext,
  user: User,
  day: Day,
  title: "digestAssignments" | "digestAssignmentsTomorrow" = "digestAssignments",
): Promise<string | null> {
  const tz = user.tz;
  const list = await assignmentsDueBetween(ctx.db, user.id, localToUtc({ day, minutes: 0 }, tz), localToUtc({ day: day + 1, minutes: 0 }, tz));
  if (list.length === 0) return null;
  const now = ctx.clock.now();
  return [t(title, user.locale), ...list.map((a) => `• ${whenOfAssignment(a, now, tz, user.locale)} — ${escapeHtml(a.title)}`)].join("\n");
}
