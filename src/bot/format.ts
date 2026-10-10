// Одна реализация форматирования для всех сценариев — не копировать в create/modify/read (tech-debt #11).

import type { CalendarEvent } from "../calendar/model";
import { parts, type Day, type Moment } from "../dates/calendar";
import { t } from "./messages";

// Сообщения уходят с parse_mode=HTML
export const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export function telegramName(u: { first_name: string; last_name?: string; username?: string }): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return `${name}${u.username ? ` (@${u.username})` : ""}`.slice(0, 120);
}

const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export function dateLabel(day: Day, today: Day, locale: string): string {
  const { year, month, date } = parts(day);
  const withYear = year !== parts(today).year;
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "ru-RU", {
    weekday: "short",
    day: "numeric",
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date)));
}

export function spanLabel(start: Moment, end: Moment, today: Day, locale: string): string {
  if (start.day === end.day) return `${dateLabel(start.day, today, locale)}, ${hhmm(start.minutes)}–${hhmm(end.minutes)}`;
  return `${dateLabel(start.day, today, locale)}, ${hhmm(start.minutes)} — ${dateLabel(end.day, today, locale)}, ${hhmm(end.minutes)}`;
}

export function whenOf(e: { allDay: boolean; startDay: Day; endDay: Day; start?: Moment; end?: Moment }, today: Day, locale: string): string {
  if (e.allDay) {
    const range =
      e.startDay === e.endDay ? dateLabel(e.startDay, today, locale) : `${dateLabel(e.startDay, today, locale)} — ${dateLabel(e.endDay, today, locale)}`;
    return `${range}, ${t("allDayLower", locale)}`;
  }
  return spanLabel(e.start!, e.end!, today, locale);
}

export function eventLabel(e: CalendarEvent, today: Day, locale: string): string {
  return `${whenOf(e, today, locale)} — ${e.title}`;
}

// Он же порядок для «перенеси вторую» (US-60): номер в списке должен совпасть с показанным
export function orderForDisplay(events: CalendarEvent[], fromDay: Day): CalendarEvent[] {
  return [...events].sort(
    (a, b) =>
      Math.max(a.startDay, fromDay) - Math.max(b.startDay, fromDay) ||
      (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) ||
      (a.start?.minutes ?? 0) - (b.start?.minutes ?? 0) ||
      a.title.localeCompare(b.title),
  );
}
