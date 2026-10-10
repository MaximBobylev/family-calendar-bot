// Чистые функции: текст и кнопки карточки «Было → Стало», без ввода-вывода.

import type { CalendarEvent, EventReminders } from "../calendar/model";
import type { Day } from "../dates/calendar";
import type { InlineKeyboardButton } from "../telegram/types";
import { calendarZoneLine } from "./create-view";
import { escapeHtml, spanLabel } from "./format";
import { callbackData } from "./keyboards";
import { t } from "./messages";
import { type Change, DEFAULT_REMINDERS, type ModifyCardPayload, type ModifyRequest } from "./modify-logic";
import { beforeLabel } from "./settings/labels";

const MAX_SHOWN_DESCRIPTION = 200;

export function modifyCard(
  e: CalendarEvent,
  options: Change[],
  payload: ModifyCardPayload,
  scope: ModifyRequest["scope"],
  id: string,
  today: Day,
  locale: string,
): { text: string; buttons: InlineKeyboardButton[][] } {
  const o = options[0]!;
  const lines = [`${t(o.start ? "modifyMoveConfirm" : "modifyConfirm", locale)}`, "", `<b>${escapeHtml(e.title)}</b>`];
  if (options.length === 1 && o.start) {
    lines.push(
      `${t("was", locale)}: ${spanLabel(payload.oldStart, payload.oldEnd, today, locale)}`,
      `${t("now", locale)}: ${spanLabel(o.start, o.end!, today, locale)}`,
    );
    const zone = payload.calendarTz ? calendarZoneLine(o.start, payload.tz, payload.calendarTz, locale) : undefined;
    if (zone) lines.push(zone);
  }
  if (o.title) lines.push(`${t("newTitle", locale)}: <b>${escapeHtml(o.title)}</b>`);
  lines.push(...detailLines(o, payload, locale));
  if (e.recurring && !payload.askScope && scope !== "all") lines.push(t("onlyThisOccurrence", locale));
  if (payload.notify) lines.push("", t("attendeesNotified", locale));

  let buttons: InlineKeyboardButton[][];
  if (options.length > 1) {
    buttons = [
      ...options.map((x, i) => [{ text: spanLabel(x.start!, x.end!, today, locale), callback_data: callbackData(id, `c${i}`) }]),
      [{ text: t("cancelButton", locale), callback_data: callbackData(id, "x") }],
    ];
  } else if (payload.askScope) {
    buttons = [
      [
        { text: t("onlyThis", locale), callback_data: callbackData(id, "c0") },
        { text: t("wholeSeries", locale), callback_data: callbackData(id, "all") },
      ],
      [{ text: t("cancelButton", locale), callback_data: callbackData(id, "x") }],
    ];
  } else {
    buttons = [
      [
        { text: t("confirmButton", locale), callback_data: callbackData(id, scope === "all" ? "all" : "c0") },
        { text: t("cancelButton", locale), callback_data: callbackData(id, "x") },
      ],
    ];
  }
  return { text: lines.join("\n"), buttons };
}

export function modifiedDetails(o: Change, p: ModifyCardPayload, wholeSeries: boolean, today: Day, locale: string): string[] {
  const details = [`<b>${escapeHtml(o.title ?? p.title)}</b>`];
  if (o.start) details.push(`🕒 ${spanLabel(o.start, o.end!, today, locale)}`);
  if (o.location) details.push(`📍 ${escapeHtml(o.location)}`);
  if (o.description) details.push(`📝 ${escapeHtml(clip(o.description))}`);
  if (o.reminders) details.push(`🔔 ${remindersText(o.reminders, locale)}`);
  if (wholeSeries) details.push(t("wholeSeriesChanged", locale));
  return details;
}

const clip = (s: string) => (s.length > MAX_SHOWN_DESCRIPTION ? `${s.slice(0, MAX_SHOWN_DESCRIPTION)}…` : s);

function remindersText(r: EventReminders, locale: string): string {
  if (r.useDefault) return t("remindersCalendarDefault", locale);
  if (r.overrides.length === 0) return t("remindersNone", locale);
  return [...r.overrides]
    .sort((a, b) => a.minutes - b.minutes)
    .map((x) => `${beforeLabel(x.minutes, locale)}${x.method === "email" ? ` ${t("reminderByEmail", locale)}` : ""}`)
    .join(", ");
}

function detailLines(o: Change, p: ModifyCardPayload, locale: string): string[] {
  const lines: string[] = [];
  const none = "—";
  const wasNow = (was: string | undefined, now: string) => (was ? `${was} → ${now}` : now);
  if (o.location !== undefined) {
    lines.push(`📍 ${t("placeLabel", locale)}: ${wasNow(p.oldLocation && escapeHtml(p.oldLocation), o.location ? escapeHtml(o.location) : none)}`);
  }
  if (o.description !== undefined) {
    const was = p.oldDescription ? `«${escapeHtml(clip(p.oldDescription))}»` : undefined;
    lines.push(`📝 ${t("descriptionLabel", locale)}: ${wasNow(was, o.description ? `«${escapeHtml(clip(o.description))}»` : none)}`);
  }
  if (o.reminders) {
    lines.push(`🔔 ${t("remindersLabel", locale)}: ${remindersText(p.oldReminders ?? DEFAULT_REMINDERS, locale)} → ${remindersText(o.reminders, locale)}`);
  }
  return lines;
}
