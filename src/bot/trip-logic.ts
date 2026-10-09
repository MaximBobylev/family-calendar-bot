// US-07 (R2): когда спросить «Вернулись?» — чистая логика без ввода-вывода (юнит-тест test/trip-logic.test.ts).

import { localToUtc, parseLocal } from "../dates/calendar";
import { nextDailyAt } from "../dates/daily";

/** День окончания поездки — вопрос в 18:00 по её поясу `[допущение 2026-10-09]`. */
export const TRIP_CHECK_MINUTES = 18 * 60;
/** Без даты окончания и после «Ещё нет» — снова через неделю (US-07 AC). */
export const TRIP_RECHECK_MS = 7 * 86_400_000;

/** Момент вопроса: день окончания 18:00 (прошёл — ближайшие 18:00), без даты — через 7 дней. */
export function tripCheckAt(now: number, tz: string, until?: string): number {
  if (!until) return now + TRIP_RECHECK_MS;
  const at = localToUtc({ day: parseLocal(`${until}T00:00`).day, minutes: TRIP_CHECK_MINUTES }, tz);
  return at > now ? at : nextDailyAt(now, tz, TRIP_CHECK_MINUTES);
}
