// US-30 / US-32: отображение карточки создания — тело события, варианты дат кнопками, выбор для 29–31 числа.
// Чистые функции: текст и кнопки по готовым вариантам, без ввода-вывода (tech-debt #10).

import { parts, type Day } from "../dates/calendar";
import type { InlineKeyboardButton } from "../telegram/types";
import type { CreateOption } from "./create-logic";
import { dateLabel, escapeHtml, hhmm, whenOf } from "./format";
import { callbackData } from "./keyboards";
import { t } from "./messages";

export const whenLabel = (o: CreateOption, today: Day, locale: string) => whenOf(o, today, locale);

export function cardBody(o: CreateOption, today: Day, locale: string, showCalendar: boolean): string {
  const lines = [`<b>${escapeHtml(o.title)}</b>`];
  if (o.series) {
    const time = o.allDay ? t("allDayLower", locale) : `${hhmm(o.start!.minutes)}–${hhmm(o.end!.minutes)}`;
    lines.push(`🔁 ${escapeHtml(o.series.text)}, ${time}`);
    lines.push(`📅 ${t("seriesNext", locale, { list: o.series.next.map((d) => dateLabel(d, today, locale)).join(" · ") })}`);
  } else {
    lines.push(`🕒 ${whenLabel(o, today, locale)}`);
  }
  if (o.location) lines.push(`📍 ${escapeHtml(o.location)}`);
  if (showCalendar) lines.push(`🗓 ${escapeHtml(o.calendarTitle)}`);
  return lines.join("\n");
}

/** Карточка подтверждения: один вариант (+ пересечения), серия на 29–31 число или выбор из нескольких дат. */
export function createCard(
  options: CreateOption[],
  actionId: string,
  today: Day,
  locale: string,
  showCalendar: boolean,
  overlaps: string[],
): { text: string; buttons: InlineKeyboardButton[][] } {
  let text: string;
  let buttons: InlineKeyboardButton[][];
  if (options.length === 1) {
    const o = options[0]!;
    text = `${t(o.series ? "createSeriesConfirm" : "createConfirm", locale)}\n\n${cardBody(o, today, locale, showCalendar)}`;
    if (overlaps.length) text += `\n\n${t("overlap", locale, { list: overlaps.join(", ") })}`;
    buttons = [
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
    // Неоднозначная дата: вместо «Создать» — кнопка на каждый вариант (US-30)
    const first = options[0]!;
    text = `${t("createChoose", locale)}\n\n<b>${escapeHtml(first.title)}</b>${showCalendar ? `\n🗓 ${escapeHtml(first.calendarTitle)}` : ""}`;
    buttons = [
      ...options.map((o, i) => [{ text: whenLabel(o, today, locale), callback_data: callbackData(actionId, `c${i}`) }]),
      [{ text: t("cancelButton", locale), callback_data: callbackData(actionId, "x") }],
    ];
  }
  return { text, buttons };
}
