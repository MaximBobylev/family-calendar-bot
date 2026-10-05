// Общее форматирование для сообщений бота: время, даты, интервалы, подписи событий, порядок вывода.
// Одна реализация вместо копий в create/modify/read (ревью 2026-10-05, tech-debt #11).

import type { CalendarEvent } from "../calendar/model";
import { parts, type Day, type Moment } from "../dates/calendar";
import { t } from "./messages";

/** Сообщения уходят с parse_mode=HTML — пользовательский и календарный текст экранируем. */
export const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** «чт, 8 октября»; год — только если отличается от текущего («пт, 1 января 2027 г.»). */
export function dateLabel(day: Day, today: Day, locale: string): string {
  const { year, month, date } = parts(day);
  const withYear = year !== parts(today).year;
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "ru-RU", {
    weekday: "short", day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date)));
}

/** «чт, 8 октября, 15:00–16:00» или через полночь «чт, 8 октября, 23:00 — пт, 9 октября, 01:00». */
export function spanLabel(start: Moment, end: Moment, today: Day, locale: string): string {
  if (start.day === end.day) return `${dateLabel(start.day, today, locale)}, ${hhmm(start.minutes)}–${hhmm(end.minutes)}`;
  return `${dateLabel(start.day, today, locale)}, ${hhmm(start.minutes)} — ${dateLabel(end.day, today, locale)}, ${hhmm(end.minutes)}`;
}

/** Время события для карточек и кнопок: интервал или «…, весь день». */
export function whenOf(e: { allDay: boolean; startDay: Day; endDay: Day; start?: Moment; end?: Moment }, today: Day, locale: string): string {
  if (e.allDay) {
    const range = e.startDay === e.endDay ? dateLabel(e.startDay, today, locale) : `${dateLabel(e.startDay, today, locale)} — ${dateLabel(e.endDay, today, locale)}`;
    return `${range}, ${t("allDayLower", locale)}`;
  }
  return spanLabel(e.start!, e.end!, today, locale);
}

/** Подпись события на кнопке выбора: «чт, 8 октября, 15:00–15:30 — Созвон с Петей». */
export function eventLabel(e: CalendarEvent, today: Day, locale: string): string {
  return `${whenOf(e, today, locale)} — ${e.title}`;
}

/** Порядок вывода списка — он же порядок для «перенеси вторую» (US-60): по дню, весь день сверху, по времени. */
export function orderForDisplay(events: CalendarEvent[], fromDay: Day): CalendarEvent[] {
  return [...events].sort((a, b) =>
    Math.max(a.startDay, fromDay) - Math.max(b.startDay, fromDay) ||
    (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) ||
    (a.start?.minutes ?? 0) - (b.start?.minutes ?? 0) ||
    a.title.localeCompare(b.title));
}
