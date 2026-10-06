// US-30 / US-32: чистая логика создания — черновик → варианты события (даты, длительность, серия, календарь).
// Без ввода-вывода: только парсер дат и правила, поэтому покрывается юнит-тестами (tech-debt #10).

import { findCalendarByName } from "../calendar/match";
import type { CalendarInfo, EventRef } from "../calendar/model";
import { addMinutes, formatMoment, parseLocal, type Day, type Moment } from "../dates/calendar";
import { durationToMinutes } from "../dates/duration";
import { parseDateFragment, type ParseValue, type Recurrence } from "../dates";
import { describeRecurrence, occurrences, toRRule } from "../dates/rrule";
import type { CreateEventIntent } from "../nlu/intents";
import { t } from "./messages";

/** Черновик создания: то, что сказал пользователь (фрагменты), — до разрешения дат. */
export interface CreateDraft {
  startText?: string;
  /** Правило повторения как сказано: «каждый понедельник в 10» (US-32). */
  recurrenceText?: string;
  title?: string;
  durationText?: string;
  allDay?: boolean;
  calendar?: string;
  location?: string;
}

/** Разрешённый вариант события — хранится в карточке. */
export interface CreateOption {
  calendarId: string;
  calendarTitle: string;
  title: string;
  titleGiven: boolean;
  tz: string;
  allDay: boolean;
  startDay: Day;
  endDay: Day;
  start?: Moment;
  end?: Moment;
  location?: string;
  series?: SeriesInfo;
}

/** Повторение: готовый RRULE и то, что показываем в карточке. */
export interface SeriesInfo {
  rrule: string;
  /** «Каждый понедельник». */
  text: string;
  /** Ближайшие даты, начиная с первой (она же начало серии). */
  next: Day[];
  /** Вариант для 29–31 числа (выбирается кнопкой): пропускать короткие месяцы или ставить на последний день. */
  shortMonths?: "skip" | "last_day";
}

export interface CreateCardPayload {
  chatId: number;
  options: CreateOption[];
}

export interface TitleQuestionPayload {
  ref: EventRef;
  /** Текущее название — чтобы переименование можно было отменить (US-61). */
  title: string;
}

export function draftFromIntent(i: CreateEventIntent): CreateDraft {
  return {
    ...(i.start ? { startText: i.start } : {}),
    ...(i.title ? { title: i.title } : {}),
    ...(i.duration ? { durationText: i.duration } : {}),
    ...(i.allDay ? { allDay: true } : {}),
    ...(i.calendar ? { calendar: i.calendar } : {}),
    ...(i.location ? { location: i.location } : {}),
  };
}

// --- Разрешение черновика --------------------------------------------------

export type Resolution =
  | { kind: "options"; options: CreateOption[] }
  | { kind: "ask"; question: "askWhen" | "askTime" | "inPast"; keepStart: boolean }
  | { kind: "reply"; text: string };

export function resolveCalendar(calendars: CalendarInfo[], name: string | undefined): CalendarInfo | { error: "notFound" | "readOnly"; name: string } {
  if (name) {
    const cal = findCalendarByName(calendars, name);
    if (!cal) return { error: "notFound", name };
    if (!cal.writable) return { error: "readOnly", name: cal.title };
    return cal;
  }
  return calendars.find((c) => c.isDefault && c.writable) ?? calendars.find((c) => c.writable) ?? { error: "notFound", name: "" };
}

export function resolveDraft(draft: CreateDraft, now: Moment, tz: string, cal: CalendarInfo, locale: string, defaultDuration: number): Resolution {
  if (draft.recurrenceText) return resolveSeries(draft, draft.recurrenceText, now, tz, cal, locale, defaultDuration);
  if (!draft.startText) return { kind: "ask", question: "askWhen", keepStart: false };

  const length = resolveLength(draft, now, tz, locale, defaultDuration);
  if ("kind" in length) return length;
  const { duration, allDay } = length;
  const base = optionBase(draft, cal, tz, locale);

  const toOption = (v: ParseValue): CreateOption | "needTime" | null => {
    if ("datetime" in v) {
      const start = parseLocal(v.datetime);
      const end = addMinutes(start, duration);
      return { ...base, allDay: false, start, end, startDay: start.day, endDay: end.day };
    }
    if ("interval" in v) {
      const start = parseLocal(v.interval.start);
      const end = parseLocal(v.interval.end);
      return { ...base, allDay: false, start, end, startDay: start.day, endDay: end.day };
    }
    if ("date" in v) {
      if (typeof v.date !== "string" || !allDay) return "needTime";
      const day = parseLocal(`${v.date}T00:00`).day;
      return { ...base, allDay: true, startDay: day, endDay: day };
    }
    if ("range" in v && !v.range.from.includes("T")) {
      return { ...base, allDay: true, startDay: parseLocal(`${v.range.from}T00:00`).day, endDay: parseLocal(`${v.range.to}T00:00`).day };
    }
    return null;
  };

  const parsed = parseDateFragment({ text: draft.startText, kind: "point", now: formatMoment(now), tz });
  if ("error" in parsed) {
    if (parsed.error === "in_past") return { kind: "ask", question: "inPast", keepStart: false };
    return { kind: "ask", question: "askWhen", keepStart: false };
  }
  const values = "ambiguous" in parsed ? parsed.ambiguous : [parsed];
  const options = values.map(toOption);
  if (options.includes("needTime")) return { kind: "ask", question: "askTime", keepStart: true };
  const ok = options.filter((o): o is CreateOption => o !== null && o !== "needTime");
  if (ok.length === 0) return { kind: "ask", question: "askWhen", keepStart: false };
  return { kind: "options", options: ok };
}

/** Длительность и «весь день» из черновика. */
function resolveLength(
  draft: CreateDraft,
  now: Moment,
  tz: string,
  locale: string,
  defaultDuration: number,
): { duration: number; allDay: boolean } | Resolution {
  let duration = defaultDuration;
  let allDay = draft.allDay ?? false;
  if (draft.durationText) {
    const d = parseDateFragment({ text: draft.durationText, kind: "duration", now: formatMoment(now), tz });
    if ("error" in d || !("duration" in d)) return { kind: "reply", text: t("durationUnparseable", locale) };
    if (d.duration === "all_day") allDay = true;
    else {
      const minutes = durationToMinutes(d.duration);
      // «на месяц» и т.п. — не длительность встречи
      if (!minutes || minutes <= 0) return { kind: "reply", text: t("durationUnparseable", locale) };
      duration = minutes;
    }
  }
  return { duration, allDay };
}

function optionBase(draft: CreateDraft, cal: CalendarInfo, tz: string, locale: string) {
  return {
    calendarId: cal.id,
    calendarTitle: cal.title,
    title: draft.title ?? t("defaultTitle", locale),
    titleGiven: !!draft.title,
    tz,
    ...(draft.location ? { location: draft.location } : {}),
  };
}

const SERIES_PREVIEW = 3;

/** Серия (US-32): первая дата правила не раньше «сейчас» — начало серии; время — из правила. */
function resolveSeries(draft: CreateDraft, text: string, now: Moment, tz: string, cal: CalendarInfo, locale: string, defaultDuration: number): Resolution {
  const parsed = parseDateFragment({ text, kind: "recurrence", now: formatMoment(now), tz });
  if (!("recurrence" in parsed)) return { kind: "ask", question: "askWhen", keepStart: false };
  const r: Recurrence = parsed.recurrence;
  const length = resolveLength(draft, now, tz, locale, defaultDuration);
  if ("kind" in length) return length;
  const { duration, allDay } = length;
  if (!r.time && !allDay) return { kind: "ask", question: "askTime", keepStart: true };

  const minutes = r.time ? Number(r.time.slice(0, 2)) * 60 + Number(r.time.slice(3)) : 0;
  // Сегодняшнее вхождение — только если его время ещё не прошло
  const from = allDay || minutes > now.minutes ? now.day : now.day + 1;
  const next = occurrences(r, from, SERIES_PREVIEW);
  if (next.length === 0) return { kind: "reply", text: t("seriesNoDates", locale) };

  const base = optionBase(draft, cal, tz, locale);
  const option = (rule: Recurrence, dates: Day[]): CreateOption => {
    const first = dates[0]!;
    const start: Moment = { day: first, minutes };
    const end = addMinutes(start, duration);
    const series: SeriesInfo = {
      rrule: toRRule(rule, start, tz, allDay),
      text: describeRecurrence(rule, first, locale),
      next: dates,
      ...(rule.short_months ? { shortMonths: rule.short_months } : {}),
    };
    return allDay
      ? { ...base, allDay: true, startDay: first, endDay: first, series }
      : { ...base, allDay: false, start, end, startDay: start.day, endDay: end.day, series };
  };
  // 29–31 число: в коротких месяцах такого дня нет — спрашиваем, пропускать или ставить на последний день
  if (r.warning === "skips_short_months" && !r.count && !r.until) {
    const variants = (["skip", "last_day"] as const).map((short_months) => ({ ...r, short_months }));
    return { kind: "options", options: variants.map((v) => option(v, occurrences(v, from, SERIES_PREVIEW))) };
  }
  return { kind: "options", options: [option(r, next)] };
}
