// Чьи календари в этом разговоре (US-90, US-94): свои — у пользователя с Google в личном чате; общие календари дома
// через аккаунт владельца — у участника без Google и в групповом чате дома. «Кто создал» в карточке и EventMeta.

import type { EventRef } from "../../calendar/model";
import { hasGoogleAccount } from "../../db/accounts";
import { type Household, householdCalendarIds, householdDefaultCalendar, membershipOf, recordEventCreator } from "../../db/households";
import { escapeHtml } from "../format";
import { t } from "../messages";
import type { AppContext, CalendarScope } from "../context";

export async function householdScope(db: D1Database, household: Household): Promise<CalendarScope> {
  const [calendarIds, defaultCalendarId] = await Promise.all([householdCalendarIds(db, household.id), householdDefaultCalendar(db, household.id)]);
  return {
    householdId: household.id,
    householdName: household.name,
    ownerUserId: household.ownerUserId,
    calendarIds,
    ...(defaultCalendarId ? { defaultCalendarId } : {}),
  };
}

/**
 * Личный чат ([решение 2026-10-06, уточнено по QA-08]): владелец и пользователь не в доме — свои календари; участник дома без
 * Google — общие календари дома через Google владельца; участник со своим Google — свои календари, только если все общие
 * календари дома есть и в его Google (расшарены ему), иначе — по-прежнему общие календари дома: подключение своего Google
 * не отнимает дом. Не в доме и без Google — undefined (дальше — «Подключить»).
 */
export async function privateScope(ctx: AppContext, userId: string): Promise<CalendarScope | undefined> {
  const m = await membershipOf(ctx.db, userId);
  if (!m || m.role === "owner") return undefined;
  if ((await hasGoogleAccount(ctx.db, userId)) && (await sharedVisibleInOwnGoogle(ctx.db, userId, m.household.id))) return undefined;
  return householdScope(ctx.db, m.household);
}

/** Все общие календари дома есть и в своём Google участника (тот же календарь провайдера). */
async function sharedVisibleInOwnGoogle(db: D1Database, userId: string, householdId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT count(*) AS missing
       FROM household_calendars hc
       JOIN calendars c ON c.id = hc.calendar_id
       WHERE hc.household_id = ?1
         AND NOT EXISTS (SELECT 1 FROM calendars oc JOIN provider_accounts pa ON pa.id = oc.account_id
                         WHERE pa.user_id = ?2 AND oc.provider_calendar_id = c.provider_calendar_id)`,
    )
    .bind(householdId, userId)
    .first<{ missing: number }>();
  return (row?.missing ?? 0) === 0;
}

/** Строка «👤 Добавляет: Аня» для карточки создания в календарях дома (US-90: в карточке видно, кто создал). */
export async function creatorNote(ctx: AppContext, userId: string, key: "homeCreatedBy" | "homeCreatedByDone", locale: string): Promise<string> {
  if (!ctx.calendarScope) return "";
  const m = await membershipOf(ctx.db, userId);
  return m?.displayName ? `\n\n${t(key, locale, { name: escapeHtml(m.displayName) })}` : "";
}

/** Запомнить автора события в календаре дома (EventMeta) — участники видят, кто добавил. */
export async function noteCreator(ctx: AppContext, ref: EventRef, userId: string): Promise<void> {
  if (ctx.calendarScope) await recordEventCreator(ctx.db, ref, userId);
}
