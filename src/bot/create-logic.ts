// US-30 / US-32: чистая логика создания — черновик → варианты события (даты, длительность, серия, календарь).
// Без ввода-вывода: только парсер дат и правила, поэтому покрывается юнит-тестами (tech-debt #10).

import { findCalendarByName } from "../calendar/match";
import type { CalendarInfo, EventRef } from "../calendar/model";
import { addMinutes, formatMoment, parseLocal, type Day, type Moment } from "../dates/calendar";
import { durationToMinutes } from "../dates/duration";
import { parseDateFragment, type ParseResult, type ParseValue, type Recurrence } from "../dates";
import { describeRecurrence, occurrences, toRRule } from "../dates/rrule";
import { type DateStructure, resolveDateStructure, structureHasValue } from "../dates/structured";
import { namedZone, type NamedZone, zoneByTz } from "../dates/zone";
import type { CreateEventIntent } from "../nlu/intents";
import type { EventFamily } from "./assign/logic";
import { t } from "./messages";

/** Черновик создания: то, что сказал пользователь (фрагменты), — до разрешения дат. */
export interface CreateDraft {
  startText?: string;
  /** Дата словами LLM (`start`), если она не совпадает с найденной в тексте: второе мнение — варианты кнопками. */
  altStartText?: string;
  /** Структура даты от LLM (`when`, разрешает наш код): второе мнение вместо `start`, когда модель её дала (ревью дат, шаг 4). */
  altWhen?: DateStructure;
  /** Пересланное и фото (шаг 5): дата модели — первым вариантом, наш парсер — проверка (расходятся — оба кнопками). */
  llmFirst?: true;
  /** Правило повторения как сказано: «каждый понедельник в 10» (US-32). */
  recurrenceText?: string;
  title?: string;
  durationText?: string;
  allDay?: boolean;
  calendar?: string;
  location?: string;
  /** Откуда событие: пересланное, фото (US-65, US-66) — пишется в описание. */
  description?: string;
  /** Ответственный и «для кого» (US-92) — в event_meta после создания. */
  family?: EventFamily;
  /** Пояс, которого мы не знаем («по Варне»): даты нет — спрашиваем время по своему поясу (tech-debt #26). */
  unknownZone?: string;
  /** Откуда дата и как она сошлась с LLM — для метрики правок даты `date_fix` (tech-debt #26). */
  dateCheck?: DateCheckInfo;
}

/** Источник даты в карточке: команда (текст/голос), пересланное, фото. */
export type DateSource = "message" | "forward" | "image";
export interface DateCheckInfo {
  source: DateSource;
  agreement: StartAgreement;
  /** Чем было второе мнение LLM: структура `when` или строка `start` (нет — none). */
  llm?: LlmDateSide;
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
  description?: string;
  series?: SeriesInfo;
  /** Время сказано в другом поясе («в 15 по Киеву») — в карточке показываем и его (tech-debt #26). */
  zone?: NamedZone;
  /** Вариант из `start` от LLM (второе мнение), а не из нашего куска — выбор его = наш парсер ошибся (date_fix). */
  fromLlm?: true;
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
  /** Календарь назван другим именем (алиасом), а не названием — учёт функций (US-64). */
  viaAlias?: boolean;
  /** Ответственный и «для кого» (US-92). */
  family?: EventFamily;
  /** Источник даты и исход сверки с LLM — для метрики date_fix (tech-debt #26). */
  dateCheck?: DateCheckInfo;
}

/** Календарь найден по алиасу: по одним названиям (без алиасов) это имя его не находит. */
export function namedByAlias(cal: CalendarInfo, name: string | undefined): boolean {
  return !!name && cal.aliases.length > 0 && !findCalendarByName([{ ...cal, aliases: [] }], name);
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

const normWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}:.]+/u)
    .map((w) => w.replace(/^[.:]+|[.:]+$/g, ""))
    .filter(Boolean);

/**
 * Дата из текста (наш парсер) и дата словами от LLM (`start`) — сверка (ревью 2026-10-08, шаг 1). Наш кусок —
 * основной; `start` — второе мнение, если он скопирован из текста (каждое слово есть в тексте — не выдумка) и
 * не часть нашего куска («в 15» при «завтра в 15»). Нашего куска нет — `start`, как раньше (ADR-0005 п.3).
 */
export function pickStart(text: string, point: string | undefined, llmStart: string | undefined): Pick<CreateDraft, "startText" | "altStartText"> {
  return startCheck(text, point, llmStart).pick;
}

/**
 * Как сошлись наш кусок и LLM — для лога `date_check` (ревью 2026-10-08, шаг 3: доля расхождений). llm_unsure — модель
 * сама сказала «не выражается / не разобрал» в структуре `when`.
 */
export type StartAgreement = "none" | "ours_only" | "llm_only" | "agree" | "llm_invented" | "differ" | "llm_unsure";
export type LlmDateSide = "when" | "start" | "none";

/** Значения результата как множество — для «совпали ли» наш кусок и структура. */
const valueKeys = (r: ParseResult) => ("error" in r ? [] : "ambiguous" in r ? r.ambiguous : [r]).map((v) => JSON.stringify(v)).sort();

/**
 * Сверка с LLM (ревью дат, шаги 4–5): есть структура `when` — она второе мнение (даты считает наш код, ADR-0005 п.3);
 * нет (бесплатная модель её не дала или испортила) — как раньше, строка `start` (startCheck). Сравниваются итоговые даты,
 * а не слова. llmFirst — пересланное и фото: дата модели первой, наш парсер проверяет.
 */
export function llmDateCheck(
  text: string,
  point: string | undefined,
  llm: { start?: string; when?: DateStructure },
  now: Moment,
  tz: string,
  llmFirst = false,
): { pick: Pick<CreateDraft, "startText" | "altStartText" | "altWhen" | "llmFirst">; agreement: StartAgreement; llm: LlmDateSide } {
  const when = llm.when;
  if (!when) {
    const c = startCheck(text, point, llm.start);
    return { ...c, llm: llm.start?.trim() ? "start" : "none" };
  }
  const own = point ? { startText: point } : {};
  if (!structureHasValue(when)) return { pick: own, agreement: point ? "llm_unsure" : "none", llm: "when" };
  const first = llmFirst ? { llmFirst: true as const } : {};
  if (!point) return { pick: { altWhen: when, ...first }, agreement: "llm_only", llm: "when" };
  const ours = parseDateFragment({ text: point, kind: "point", now: formatMoment(now), tz });
  const theirs = resolveDateStructure(when, "point", now, tz);
  const same = !("error" in theirs) && valueKeys(ours).join() === valueKeys(theirs).join();
  if (same) return { pick: own, agreement: "agree", llm: "when" };
  return { pick: { ...own, altWhen: when, ...first }, agreement: "differ", llm: "when" };
}

export function startCheck(
  text: string,
  point: string | undefined,
  llmStart: string | undefined,
): { pick: Pick<CreateDraft, "startText" | "altStartText">; agreement: StartAgreement } {
  const llm = llmStart?.trim() || undefined;
  if (!point) return llm ? { pick: { startText: llm }, agreement: "llm_only" } : { pick: {}, agreement: "none" };
  if (!llm) return { pick: { startText: point }, agreement: "ours_only" };
  const inText = new Set(normWords(text));
  const llmWords = normWords(llm);
  const ours = new Set(normWords(point));
  if (!llmWords.length || !llmWords.every((w) => inText.has(w))) return { pick: { startText: point }, agreement: "llm_invented" };
  if (llmWords.every((w) => ours.has(w))) return { pick: { startText: point }, agreement: "agree" };
  return { pick: { startText: point, altStartText: llm }, agreement: "differ" };
}

/** Больше вариантов в карточке не показываем: дальше это уже не выбор, а шум. */
const MAX_OPTIONS = 4;

export type Resolution =
  | { kind: "options"; options: CreateOption[] }
  /** startText — что сохранить в черновике для ответа (дата из структуры LLM словами «02.11.2026»), если не исходный кусок. */
  | { kind: "ask"; question: "askWhen" | "askTime" | "inPast" | "askZoneTime"; keepStart: boolean; startText?: string }
  | { kind: "reply"; text: string };

export type CalendarResolution = CalendarInfo | { error: "notFound" | "readOnly"; name: string } | { error: "noWritable" };

/** Календарь для создания: по имени/алиасу или по умолчанию. noWritable — записать некуда (все только для чтения). */
export function resolveCalendar(calendars: CalendarInfo[], name: string | undefined): CalendarResolution {
  const fallback = calendars.find((c) => c.isDefault && c.writable) ?? calendars.find((c) => c.writable);
  if (name) {
    const cal = findCalendarByName(calendars, name);
    if (cal && !cal.writable) return { error: "readOnly", name: cal.title };
    if (cal) return cal;
    // Не нашли, а предложить нечего — без пустого списка «Ваши календари: .»
    return fallback ? { error: "notFound", name } : { error: "noWritable" };
  }
  return fallback ?? { error: "noWritable" };
}

export function resolveDraft(draft: CreateDraft, now: Moment, tz: string, cal: CalendarInfo, locale: string, defaultDuration: number): Resolution {
  if (draft.recurrenceText) return resolveSeries(draft, draft.recurrenceText, now, tz, cal, locale, defaultDuration);
  if (!draft.startText && !draft.altWhen) return { kind: "ask", question: draft.unknownZone ? "askZoneTime" : "askWhen", keepStart: false };

  const length = resolveLength(draft, now, tz, locale, defaultDuration);
  if ("kind" in length) return length;
  const { duration, allDay } = length;
  const base = optionBase(draft, cal, tz, locale);

  const toOption = (v: ParseValue, extra: Pick<CreateOption, "zone" | "fromLlm">): CreateOption | "needTime" | null => {
    if ("datetime" in v) {
      const start = parseLocal(v.datetime);
      const end = addMinutes(start, duration);
      return { ...base, ...extra, allDay: false, start, end, startDay: start.day, endDay: end.day };
    }
    if ("interval" in v) {
      const start = parseLocal(v.interval.start);
      const end = parseLocal(v.interval.end);
      return { ...base, ...extra, allDay: false, start, end, startDay: start.day, endDay: end.day };
    }
    if ("date" in v) {
      if (typeof v.date !== "string" || !allDay) return "needTime";
      const day = parseLocal(`${v.date}T00:00`).day;
      return { ...base, ...(extra.fromLlm ? { fromLlm: true } : {}), allDay: true, startDay: day, endDay: day };
    }
    if ("range" in v && !v.range.from.includes("T")) {
      const days = { startDay: parseLocal(`${v.range.from}T00:00`).day, endDay: parseLocal(`${v.range.to}T00:00`).day };
      return { ...base, ...(extra.fromLlm ? { fromLlm: true } : {}), allDay: true, ...days };
    }
    return null;
  };

  const fromParsed = (parsed: ParseResult, zone: NamedZone | undefined, fromLlm: boolean): Resolution => {
    const extra = { ...(zone && zone.tz !== tz ? { zone } : {}), ...(fromLlm ? { fromLlm: true as const } : {}) };
    if ("error" in parsed) {
      if (parsed.error === "in_past") return { kind: "ask", question: "inPast", keepStart: false };
      return { kind: "ask", question: "askWhen", keepStart: false };
    }
    const values = "ambiguous" in parsed ? parsed.ambiguous : [parsed];
    const options = values.map((v) => toOption(v, extra));
    if (options.includes("needTime")) {
      // Дата только из структуры LLM: ответ «в 10» дополнит её словами (dialog.ts склеивает текст), иначе день потеряется
      const days = values.flatMap((v) => ("date" in v ? [typeof v.date === "string" ? v.date : v.date.date] : []));
      if (!fromLlm) return { kind: "ask", question: "askTime", keepStart: true };
      if (days.length !== 1) return { kind: "ask", question: "askWhen", keepStart: false };
      const [y, m, d] = days[0]!.split("-");
      return { kind: "ask", question: "askTime", keepStart: true, startText: `${d}.${m}.${y}` };
    }
    const ok = options.filter((o): o is CreateOption => o !== null && o !== "needTime");
    if (ok.length === 0) return { kind: "ask", question: "askWhen", keepStart: false };
    return { kind: "options", options: ok };
  };
  const fromText = (text: string, fromLlm: boolean) =>
    fromParsed(parseDateFragment({ text, kind: "point", now: formatMoment(now), tz }), namedZone(text), fromLlm);

  const ours: Resolution = draft.startText ? fromText(draft.startText, false) : { kind: "ask", question: "askWhen", keepStart: false };
  // Второе мнение LLM: структура `when` (резолвит наш код), иначе строка `start`
  const alt = draft.altWhen
    ? fromParsed(resolveDateStructure(draft.altWhen, "point", now, tz), draft.altWhen.timezone ? zoneByTz(draft.altWhen.timezone) : undefined, true)
    : draft.altStartText
      ? fromText(draft.altStartText, true)
      : undefined;
  // У нас нет полного момента, а у LLM есть — берём его; оба есть и разные — оба кнопками (пересланное и фото — LLM первой)
  if (!alt) return ours;
  if (alt.kind !== "options") return draft.startText ? ours : alt;
  if (ours.kind !== "options") return alt;
  const [first, second] = draft.llmFirst ? [alt.options, ours.options] : [ours.options, alt.options];
  const key = (o: CreateOption) => JSON.stringify([o.allDay, o.startDay, o.start, o.endDay]);
  const seen = new Set(first.map(key));
  return { kind: "options", options: [...first, ...second.filter((o) => !seen.has(key(o)))].slice(0, MAX_OPTIONS) };
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
    ...(draft.description ? { description: draft.description } : {}),
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
