// /settings: подписи значений — длительность, напоминания «за 1 ч», «накануне в 9:00» (US-04, US-42).
// Чистые функции; beforeLabel использует и карточка изменения (modify-view.ts).

import { hhmm } from "../format";
import { t } from "../messages";

const DAY_MIN = 24 * 60;

export function durationLabel(min: number, locale: string): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (locale === "en") return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
  return [h ? `${h} ч` : "", m ? `${m} мин` : ""].filter(Boolean).join(" ");
}

/** «за 1 ч», «за 2 дн.» — напоминание до начала. */
export function beforeLabel(min: number, locale: string): string {
  if (min % DAY_MIN === 0) return t("reminderBefore", locale, { value: locale === "en" ? `${min / DAY_MIN} d` : `${min / DAY_MIN} дн.` });
  return t("reminderBefore", locale, { value: durationLabel(min, locale) });
}

function allDayLabel(min: number, locale: string): string {
  const days = Math.ceil(min / DAY_MIN);
  const time = hhmm(days * DAY_MIN - min).replace(/^0/, "");
  return days === 1 ? t("reminderDayBefore", locale, { time }) : t("reminderDaysBefore", locale, { days: String(days), time });
}

export function remindersLabel(r: number[] | undefined, locale: string): string {
  if (r === undefined) return t("remindersGoogle", locale);
  if (r.length === 0) return t("remindersNone", locale);
  return r.map((m) => beforeLabel(m, locale)).join(", ");
}

export function allDayRemindersLabel(r: number[] | undefined, locale: string): string {
  if (!r || r.length === 0) return t("remindersNone", locale);
  return r.map((m) => allDayLabel(m, locale)).join(", ");
}
