// Чьи календари в разговоре: свои или общие календари дома через аккаунт владельца.

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

// Решение владельца 2026-10-06 (QA-08): подключение своего Google не отнимает дом — свои календари у участника, только если
// все общие календари дома расшарены и в его Google.
export async function privateScope(ctx: AppContext, userId: string): Promise<CalendarScope | undefined> {
  const m = await membershipOf(ctx.db, userId);
  if (!m || m.role === "owner") return undefined;
  if ((await hasGoogleAccount(ctx.db, userId)) && (await sharedVisibleInOwnGoogle(ctx.db, userId, m.household.id))) return undefined;
  return householdScope(ctx.db, m.household);
}

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

export async function creatorNote(ctx: AppContext, userId: string, key: "homeCreatedBy" | "homeCreatedByDone", locale: string): Promise<string> {
  if (!ctx.calendarScope) return "";
  const m = await membershipOf(ctx.db, userId);
  return m?.displayName ? `\n\n${t(key, locale, { name: escapeHtml(m.displayName) })}` : "";
}

export async function noteCreator(ctx: AppContext, ref: EventRef, userId: string): Promise<void> {
  if (ctx.calendarScope) await recordEventCreator(ctx.db, ref, userId);
}
