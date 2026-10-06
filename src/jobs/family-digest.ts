// US-93: семейная часть дайджеста — чьи календари (участник без Google получает сводку по общим календарям дома через
// Google владельца) и блок «Ваши дела сегодня» (поручения участнику, US-91). Подписи «для кого / отводит» — familyLabeler.

import { whenOfAssignment } from "../bot/assign/view";
import { GoogleCalendarProvider } from "../calendar/google-provider";
import type { CalendarProvider } from "../calendar/model";
import { localToUtc, type Day } from "../dates/calendar";
import type { AppContext } from "../bot/context";
import { escapeHtml } from "../bot/format";
import { t } from "../bot/messages";
import { hasGoogleAccount } from "../db/accounts";
import { assignmentsDueBetween } from "../db/assignments";
import { householdCalendarIds, membershipOf } from "../db/households";
import type { User } from "../db/users";

/** Есть из чего собрать сводку: свой Google или дом (общие календари владельца). */
export async function hasDigestSource(db: D1Database, userId: string): Promise<boolean> {
  return (await hasGoogleAccount(db, userId)) || (await membershipOf(db, userId)) !== null;
}

/** Календари для сводки: свои — с Google; участник без Google — общие календари дома через аккаунт владельца. */
export async function digestProvider(ctx: AppContext, user: User): Promise<CalendarProvider | null> {
  if (await hasGoogleAccount(ctx.db, user.id)) return new GoogleCalendarProvider(ctx.config, ctx.db, user.id, ctx.clock);
  const m = await membershipOf(ctx.db, user.id);
  if (!m) return null;
  const ids = await householdCalendarIds(ctx.db, m.household.id);
  return ids.length ? new GoogleCalendarProvider(ctx.config, ctx.db, m.household.ownerUserId, ctx.clock, ids) : null;
}

/** «📌 Ваши дела сегодня:» — открытые поручения участнику со сроком в этот день; нет — null. */
export async function assignmentsBlock(ctx: AppContext, user: User, day: Day): Promise<string | null> {
  const tz = user.home_tz;
  const list = await assignmentsDueBetween(ctx.db, user.id, localToUtc({ day, minutes: 0 }, tz), localToUtc({ day: day + 1, minutes: 0 }, tz));
  if (list.length === 0) return null;
  const now = ctx.clock.now();
  return [t("digestAssignments", user.locale), ...list.map((a) => `• ${whenOfAssignment(a, now, tz, user.locale)} — ${escapeHtml(a.title)}`)].join("\n");
}
