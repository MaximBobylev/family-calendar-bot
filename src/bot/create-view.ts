// Чистые функции: текст и кнопки карточки по готовым вариантам, без ввода-вывода.

import { localToUtc, parts, utcToLocal, type Day, type Moment } from "../dates/calendar";
import type { InlineKeyboardButton } from "../telegram/types";
import type { CreateOption } from "./create-logic";
import { dateLabel, escapeHtml, hhmm, whenOf } from "./format";
import { callbackData } from "./keyboards";
import { t } from "./messages";

export const whenLabel = (o: CreateOption, today: Day, locale: string) => whenOf(o, today, locale);

export function cardBody(o: CreateOption, today: Day, locale: string, showCalendar: boolean, yearly?: boolean): string {
  const lines = [`<b>${escapeHtml(o.title)}</b>`];
  if (o.series) {
    const time = o.allDay ? t("allDayLower", locale) : `${hhmm(o.start!.minutes)}–${hhmm(o.end!.minutes)}`;
    lines.push(`🔁 ${escapeHtml(o.series.text)}, ${time}`);
    lines.push(`📅 ${t("seriesNext", locale, { list: o.series.next.map((d) => dateLabel(d, today, locale)).join(" · ") })}`);
  } else {
    lines.push(`🕒 ${whenLabel(o, today, locale)}${yearly ? `, ${t("multiEveryYear", locale)}` : ""}`);
    const zone = zoneLine(o, locale);
    if (zone) lines.push(zone);
  }
  if (o.location) lines.push(`📍 ${escapeHtml(o.location)}`);
  if (o.description) lines.push(`📝 ${escapeHtml(firstLine(o.description))}`);
  if (showCalendar) lines.push(`🗓 ${escapeHtml(o.calendarTitle)}`);
  return lines.join("\n");
}

export function createCard(
  options: CreateOption[],
  actionId: string,
  today: Day,
  locale: string,
  showCalendar: boolean,
  overlaps: string[],
  /** undefined — не день рождения, кнопки повтора нет. */
  yearly?: boolean,
): { text: string; buttons: InlineKeyboardButton[][] } {
  let text: string;
  let buttons: InlineKeyboardButton[][];
  if (options.length === 1) {
    const o = options[0]!;
    text = `${t(o.series ? "createSeriesConfirm" : "createConfirm", locale)}\n\n${cardBody(o, today, locale, showCalendar, yearly)}`;
    if (overlaps.length) text += `\n\n${t("overlap", locale, { list: overlaps.join(", ") })}`;
    buttons = [
      ...(yearly === undefined ? [] : [[{ text: t(yearly ? "multiYearlyOn" : "multiYearlyOff", locale), callback_data: callbackData(actionId, "y") }]]),
      [
        { text: t("createButton", locale), callback_data: callbackData(actionId, "c0") },
        { text: t("cancelButton", locale), callback_data: callbackData(actionId, "x") },
      ],
    ];
  } else if (options[0]!.series?.shortMonths) {
    // Серия на 29–31 число: как быть с короткими месяцами (US-32)
    const [skip, last] = options as [CreateOption, CreateOption];
    const time = skip.allDay ? t("allDayLower", locale) : `${hhmm(skip.start!.minutes)}–${hhmm(skip.end!.minutes)}`;
    const dates = (o: CreateOption) => o.series!.next.map((d) => dateLabel(d, today, locale)).join(" · ");
    const day = String(parts(skip.series!.next[0]!).date);
    text = [
      t("createSeriesConfirm", locale),
      "",
      `<b>${escapeHtml(skip.title)}</b>`,
      `🔁 ${t("seriesMonthly", locale, { day })}, ${time}`,
      ...(showCalendar ? [`🗓 ${escapeHtml(skip.calendarTitle)}`] : []),
      "",
      t("seriesShortMonthsQuestion", locale, { day }),
      `• ${t("seriesSkipOption", locale)}: ${dates(skip)}`,
      `• ${t("seriesLastDayOption", locale)}: ${dates(last)}`,
    ].join("\n");
    buttons = [
      [
        { text: t("seriesSkipButton", locale), callback_data: callbackData(actionId, "c0") },
        { text: t("seriesLastDayButton", locale), callback_data: callbackData(actionId, "c1") },
      ],
      [{ text: t("cancelButton", locale), callback_data: callbackData(actionId, "x") }],
    ];
  } else {
    const first = options[0]!;
    text = `${t("createChoose", locale)}\n\n<b>${escapeHtml(first.title)}</b>${showCalendar ? `\n🗓 ${escapeHtml(first.calendarTitle)}` : ""}`;
    buttons = [
      ...options.map((o, i) => [{ text: whenLabel(o, today, locale), callback_data: callbackData(actionId, `c${i}`) }]),
      [{ text: t("cancelButton", locale), callback_data: callbackData(actionId, "x") }],
    ];
  }
  return { text, buttons };
}

export function zoneLine(o: CreateOption, locale: string): string | undefined {
  if (!o.start || o.allDay) return undefined;
  if (!o.zone) return o.calendarTz ? calendarZoneLine(o.start, o.tz, o.calendarTz, locale) : undefined;
  const there = utcToLocal(localToUtc(o.start, o.tz), o.zone.tz);
  if (there.day === o.start.day && there.minutes === o.start.minutes) return undefined;
  return t("zoneNote", locale, {
    time: hhmm(there.minutes),
    zone: escapeHtml(locale === "en" ? o.zone.en : o.zone.ru),
    myTime: hhmm(o.start.minutes),
    tz: o.tz,
  });
}

export function calendarZoneLine(start: Moment, tz: string, calendarTz: string, locale: string): string | undefined {
  const there = utcToLocal(localToUtc(start, tz), calendarTz);
  if (there.day === start.day && there.minutes === start.minutes) return undefined;
  return t("calendarZoneNote", locale, {
    tz: calendarTz,
    time: there.day === start.day ? hhmm(there.minutes) : `${dateLabel(there.day, start.day, locale)}, ${hhmm(there.minutes)}`,
  });
}

const firstLine = (s: string) => {
  const line = s.split("\n")[0]!.trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};
