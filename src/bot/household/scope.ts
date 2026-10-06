// Чьи календари в этом разговоре (US-90, US-94): свои — у пользователя с Google в личном чате; общие календари дома
// через аккаунт владельца — у участника без Google и в групповом чате дома. «Кто создал» в карточке и EventMeta.

import type { EventRef } from "../../calendar/model";
import { hasGoogleAccount } from "../../db/accounts";
import { type Household, householdCalendarIds, membershipOf, recordEventCreator } from "../../db/households";
import { escapeHtml } from "../format";
import { t } from "../messages";
import type { AppContext, CalendarScope } from "../context";

export async function householdScope(db: D1Database, household: Household): Promise<CalendarScope> {
  return {
    householdId: household.id,
    householdName: household.name,
    ownerUserId: household.ownerUserId,
    calendarIds: await householdCalendarIds(db, household.id),
  };
}

/**
 * Личный чат: свой Google — свои календари (общие календари обычно и так расшарены в Google); без Google — общие
 * календари дома ([решение 2026-10-06]). Не в доме и без Google — undefined (дальше — «Подключить»).
 */
export async function privateScope(ctx: AppContext, userId: string): Promise<CalendarScope | undefined> {
  if (await hasGoogleAccount(ctx.db, userId)) return undefined;
  const m = await membershipOf(ctx.db, userId);
  return m ? householdScope(ctx.db, m.household) : undefined;
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
