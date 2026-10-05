// Ежедневные события по местному времени пользователя (дайджест US-70): ближайший момент «ЧЧ:ММ» после `nowUtc`.

import { localToUtc, utcToLocal } from "./calendar";

export const parseHhmm = (s: string): number | undefined => {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(s.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  return h < 24 && min < 60 ? h * 60 + min : undefined;
};

/** Ближайший момент UTC, когда в поясе `tz` будет `minutes` минут от полуночи; строго позже `nowUtc`. */
export function nextDailyAt(nowUtc: number, tz: string, minutes: number): number {
  const local = utcToLocal(nowUtc, tz);
  for (let d = 0; d < 3; d++) {
    const at = localToUtc({ day: local.day + d, minutes }, tz);
    if (at > nowUtc) return at;
  }
  throw new Error("unreachable");
}
