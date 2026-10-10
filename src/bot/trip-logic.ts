// Когда спросить «Вернулись?» — без ввода-вывода.

import { localToUtc, parseLocal } from "../dates/calendar";
import { nextDailyAt } from "../dates/daily";

// Допущение, не замер: в день окончания поездки — 18:00 по её поясу
export const TRIP_CHECK_MINUTES = 18 * 60;
export const TRIP_RECHECK_MS = 7 * 86_400_000;

export function tripCheckAt(now: number, tz: string, until?: string): number {
  if (!until) return now + TRIP_RECHECK_MS;
  const at = localToUtc({ day: parseLocal(`${until}T00:00`).day, minutes: TRIP_CHECK_MINUTES }, tz);
  return at > now ? at : nextDailyAt(now, tz, TRIP_CHECK_MINUTES);
}
