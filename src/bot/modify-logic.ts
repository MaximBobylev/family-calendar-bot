// US-40 / US-41 / US-43: чистый расчёт изменения события по фрагментам из текста (перенос, длительность, детали).
// Без ввода-вывода (tech-debt #10); карточка — modify-view.ts, сценарий — modify-event.ts.

import type { CalendarEvent, EventRef, EventReminders } from "../calendar/model";
import { parseDateFragment } from "../dates";
import { addMinutes, formatMoment, minutesBetween, parseLocal, type Moment } from "../dates/calendar";
import { durationToMinutes } from "../dates/duration";
import { fragmentParts } from "../dates/point";
import { tokenize } from "../dates/tokenize";
import type { EventRequest } from "./find-event";

export type ModifyRequest = EventRequest;

/** Вариант изменения — хранится в карточке. */
export interface Change {
  start?: Moment;
  end?: Moment;
  title?: string;
  /** "" — убрать. */
  location?: string;
  /** "" — убрать. */
  description?: string;
  reminders?: EventReminders;
}

/** Нет напоминаний у события в Google — значит, как в календаре. */
export const DEFAULT_REMINDERS: EventReminders = { useDefault: true, overrides: [] };

export interface ModifyCardPayload {
  chatId: number;
  tz: string;
  ref: EventRef;
  seriesId?: string;
  etag?: string;
  title: string;
  oldLocation?: string;
  oldDescription?: string;
  oldReminders?: EventReminders;
  oldStart: Moment;
  oldEnd: Moment;
  notify: boolean;
  options: Change[];
  /** Кнопки «только эту / все» вместо «подтвердить». */
  askScope: boolean;
}

const plus = addMinutes;
const diff = minutesBetween;

// --- Расчёт изменений ---------------------------------------------------------

export type ChangeResult = { options: Change[] } | { error: "nothingToChange" | "notUnderstood" | "inPast" | "allDayTime" };

export function computeChange(e: CalendarEvent, req: ModifyRequest, nowLocal: Moment, tz: string): ChangeResult {
  const s = req.spans;
  // «Добавь описание» дописывает к существующему, «измени описание» — заменяет (US-41)
  const description =
    req.newDescription !== undefined && req.appendDescription && e.description && req.newDescription
      ? `${e.description}\n${req.newDescription}`
      : req.newDescription;
  const base: Change = {
    ...(req.newTitle ? { title: req.newTitle } : {}),
    ...(req.newLocation !== undefined ? { location: req.newLocation } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(req.reminders ? { reminders: req.reminders } : {}),
  };
  const wantsTime = !!(s.shift || s.target || s.duration);
  if (!wantsTime) return Object.keys(base).length ? { options: [base] } : { error: "nothingToChange" };
  if (e.allDay) return { error: "allDayTime" };

  const start = e.start!;
  const end = e.end!;
  const length = diff(end, start);
  const options: Change[] = [];

  if (s.shift) {
    const parsed = parseDateFragment({ text: s.shift, kind: "shift", now: formatMoment(nowLocal), tz });
    const minutes = "shift" in parsed ? durationToMinutes(parsed.shift) : null;
    if (minutes === null) return { error: "notUnderstood" };
    options.push({ ...base, start: plus(start, minutes), end: plus(end, minutes) });
  } else if (s.target) {
    const parts = fragmentParts(tokenize(s.target));
    if (!parts) return { error: "notUnderstood" };
    // Только время («на 11») — тот же день события; только дата («на пятницу») — то же время
    const now = parts.hasDate ? formatMoment(nowLocal) : formatMoment({ day: start.day, minutes: 0 });
    const parsed = parseDateFragment({ text: s.target, kind: "point", now, tz });
    if ("error" in parsed) return { error: parsed.error === "in_past" ? "inPast" : "notUnderstood" };
    for (const v of "ambiguous" in parsed ? parsed.ambiguous : [parsed]) {
      if ("datetime" in v) {
        const ns = parseLocal(v.datetime);
        options.push({ ...base, start: ns, end: plus(ns, length) });
      } else if ("interval" in v) {
        options.push({ ...base, start: parseLocal(v.interval.start), end: parseLocal(v.interval.end) });
      } else if ("date" in v) {
        const day = parseLocal(`${typeof v.date === "string" ? v.date : v.date.date}T00:00`).day;
        const ns = { day, minutes: start.minutes };
        options.push({ ...base, start: ns, end: plus(ns, length) });
      }
    }
    if (!options.length) return { error: "notUnderstood" };
  } else {
    options.push({ ...base, start, end });
  }

  if (s.duration) {
    const parsed = parseDateFragment({ text: s.duration, kind: "duration", now: formatMoment(nowLocal), tz });
    const minutes = "duration" in parsed && parsed.duration !== "all_day" ? durationToMinutes(parsed.duration) : null;
    if (!minutes) return { error: "notUnderstood" };
    for (const o of options) o.end = plus(o.start!, minutes);
  }
  if (options.every((o) => o.start && diff(o.start, nowLocal) <= 0)) return { error: "inPast" };
  return { options: options.filter((o) => !o.start || diff(o.start, nowLocal) > 0) };
}
