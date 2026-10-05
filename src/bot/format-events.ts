// Список событий для Telegram (US-20): по дням, события на весь день сверху, метка календаря,
// разбиение на сообщения по лимиту Telegram.

import type { CalendarEvent } from "../calendar/model";
import { parts, type Day } from "../dates/calendar";
import { escapeHtml, hhmm, orderForDisplay } from "./format";
import { t } from "./messages";

const TELEGRAM_LIMIT = 4000; // запас до 4096
const pad = (n: number) => String(n).padStart(2, "0");
export { escapeHtml };

export function dayTitle(day: Day, today: Day, locale: string): string {
  const { year, month, date } = parts(day);
  const label = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "ru-RU", {
    weekday: "short",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date)));
  if (day === today) return `${t("today", locale)}, ${label}`;
  if (day === today + 1) return `${t("tomorrow", locale)}, ${label}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function eventLine(e: CalendarEvent, day: Day, showCalendar: boolean, locale: string): string {
  let time: string;
  if (e.allDay) {
    time = t("allDay", locale);
    if (e.endDay > day) {
      const { date, month } = parts(e.endDay);
      time += ` (${t("until", locale)} ${pad(date)}.${pad(month)})`;
    }
  } else {
    time = `${hhmm(e.start!.minutes)}–${hhmm(e.end!.minutes)}`;
    if (e.end!.day > e.start!.day) time += ` (${t("nextDayShort", locale)})`;
  }
  let line = `• ${time}  ${escapeHtml(e.title)}`;
  if (showCalendar) line += ` · ${escapeHtml(e.calendarTitle)}`;
  if (e.free) line += ` · ${t("free", locale)}`;
  if (e.location) line += `\n   📍 ${escapeHtml(e.location)}`;
  if (e.conferenceUrl) line += `\n   🔗 ${escapeHtml(e.conferenceUrl)}`;
  return line;
}

/**
 * Тексты сообщений со списком событий периода [fromDay, toDay].
 * `showCalendarFor` — для каких календарей показывать метку (не по умолчанию, если календарей > 1).
 */
/** Приписать к последнему сообщению, какие календари не загрузились. */
export function appendFailedNote(messages: string[], failed: { title: string }[], locale: string): void {
  if (failed.length === 0 || messages.length === 0) return;
  const list = failed.map((f) => `«${escapeHtml(f.title)}»`).join(", ");
  messages[messages.length - 1] += `\n\n${t(failed.length === 1 ? "calendarFailed" : "calendarsFailed", locale, { list })}`;
}

export function formatEvents(
  events: CalendarEvent[],
  fromDay: Day,
  toDay: Day,
  today: Day,
  locale: string,
  showCalendarFor: (calendarId: string) => boolean,
): string[] {
  const byDay = new Map<Day, CalendarEvent[]>();
  for (const e of events) {
    if (e.endDay < fromDay) continue;
    const day = Math.max(e.startDay, fromDay);
    if (day > toDay) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }

  if (byDay.size === 0) {
    const period = fromDay === toDay ? dayTitle(fromDay, today, locale) : `${dayTitle(fromDay, today, locale)} — ${dayTitle(toDay, today, locale)}`;
    return [`${period}\n${t("noEvents", locale)}`];
  }

  const blocks = [...byDay.keys()]
    .sort((a, b) => a - b)
    .map((day) => {
      const list = orderForDisplay(byDay.get(day)!, fromDay);
      return [`<b>${dayTitle(day, today, locale)}</b>`, ...list.map((e) => eventLine(e, day, showCalendarFor(e.ref.calendarId), locale))].join("\n");
    });

  // Разбиение по лимиту Telegram; дни не режем
  const messages: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > TELEGRAM_LIMIT) {
      messages.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) messages.push(current);
  return messages;
}
