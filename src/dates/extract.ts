// Извлечение фрагментов дат из всего сообщения — детерминированно, без LLM.
// LLM (особенно маленькие модели) теряет части дат («завтра» из «завтра в 15:30») и не заполняет
// длительность, поэтому даты берём из исходного текста: самые длинные куски, которые разбирает парсер.
// Незнакомое слово («с Петей», «банк») обрывает кусок — названия в даты не попадают.

import { parseDateFragment } from "./index";
import { FILLERS, WEEKDAYS_PLURAL_DATIVE } from "./lexicon";
import type { ParseResult, ValueKind } from "./types";

export interface ExtractedSpans {
  /** Все куски-моменты по порядку, склеенные: «в пятницу» + «в 15» → «в пятницу в 15». */
  point?: string;
  /** Период для чтения расписания. */
  range?: string;
  duration?: string;
  /** Слова, вошедшие в даты, — чтобы убрать их из названия. */
  usedWords: Set<number>;
}

const isUsable = (r: ParseResult) => !("error" in r) || r.error === "in_past";

function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[«"(,.!?]+|[»"),.!?]+$/g, ""))
    .filter(Boolean);
}

export function extractDateSpans(text: string, now: string, tz: string, kind: "point" | "range"): ExtractedSpans {
  const ws = words(text);
  const points: string[] = [];
  const used = new Set<number>();
  let duration: string | undefined;

  const parses = (fragment: string, k: ValueKind) => isUsable(parseDateFragment({ text: fragment, kind: k, now, tz }));

  const isFiller = (w: string) => FILLERS.has(w.toLowerCase()) || w.toLowerCase() === "во";
  // Длительность — с числом или «на …» («на полчаса», «часа на три»), а не одиночное «день» из «дня рождения»
  const durationLike = (fragment: string) => fragment.split(" ").length > 1 || /^полчаса$/i.test(fragment);

  let i = 0;
  while (i < ws.length) {
    let matched = false;
    for (let j = ws.length; j > i; j--) {
      // Служебное слово в конце куска принадлежит следующему («в 15:30 на полчаса»)
      if (isFiller(ws[j - 1]!)) continue;
      const fragment = ws.slice(i, j).join(" ");
      if (!duration && kind === "point" && durationLike(fragment) && parses(fragment, "duration")) {
        duration = fragment;
      } else if (parses(fragment, kind)) {
        points.push(fragment);
      } else {
        continue;
      }
      for (let k = i; k < j; k++) used.add(k);
      i = j;
      matched = true;
      break;
    }
    if (!matched) i++;
  }

  const joined = points.length ? points.join(" ") : undefined;
  const out: ExtractedSpans = { usedWords: used };
  // Склейка нескольких кусков должна разбираться целиком, иначе берём первый
  if (joined) {
    const value = parses(joined, kind) ? joined : points[0]!;
    if (kind === "point") out.point = value;
    else out.range = value;
  }
  if (duration) out.duration = duration;
  return out;
}

/** Слова, по которым событие без времени считается событием на весь день (US-31). */
const ALL_DAY_PATTERNS = [
  /день рождени/i, /(?<!\p{L})др(?!\p{L})/iu, /годовщин/i, /юбиле/i, /отпуск/i, /праздник/i, /командировк/i, /выходн(ой|ые)/i, /весь день/i,
  /birthday/i, /anniversary/i, /vacation/i, /holiday/i, /all day/i, /day off/i,
];

export function looksAllDay(text: string): boolean {
  return ALL_DAY_PATTERNS.some((p) => p.test(text));
}

/** Название без слов, ушедших в даты; пустое или служебное («встреча») — нет названия. */
const GENERIC_TITLES = new Set(["встреча", "встречу", "событие", "мероприятие", "meeting", "event", "напоминание"]);

export function cleanTitle(title: string | undefined, dateFragments: string[]): string | undefined {
  if (!title) return undefined;
  let t = title;
  for (const f of dateFragments) t = t.replace(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  t = t.replace(/\s+/g, " ").trim().replace(/^[,.\-—]+|[,.\-—]+$/g, "").trim();
  if (!t || GENERIC_TITLES.has(t.toLowerCase())) return undefined;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// --- Изменение события (US-40, US-41) ----------------------------------------

export interface ModifySpans {
  /** Время/дата, по которым ищем само событие: «созвон **в 15**», «**в среду** встречу». */
  reference?: string;
  /** Новое время: «**на пятницу**», «**на 11**», «**на завтра в 15**». */
  target?: string;
  /** Сдвиг: «на час позже», «на день раньше». */
  shift?: string;
  /** Новая длительность: «сделай на полтора часа». */
  duration?: string;
}

/** «завтрашнюю встречу» → «завтра»: прилагательные-указатели дня. */
const DAY_ADJECTIVES: [RegExp, string][] = [
  [/^завтрашн/i, "завтра"],
  [/^сегодняшн/i, "сегодня"],
  [/^вчерашн/i, "вчера"],
  [/^послезавтрашн/i, "послезавтра"],
];

/** Глаголы, при которых «на полтора часа» — длительность, а не сдвиг. */
const DURATION_VERBS = /(сделай|сделать|продли|продлить|укороти|сократи|растяни|длительност|длиной|длится|продолжительност)/i;

const TARGET_PREFIXES = new Set(["на", "to", "for"]);

export function extractModifySpans(text: string, now: string, tz: string): ModifySpans {
  const ws = words(text).map((w) => DAY_ADJECTIVES.find(([re]) => re.test(w))?.[1] ?? w);
  const out: ModifySpans = {};
  const references: string[] = [];
  const wantsDuration = DURATION_VERBS.test(text);
  const ok = (fragment: string, kind: ValueKind) => isUsable(parseDateFragment({ text: fragment, kind, now, tz }));
  const isFiller = (w: string) => FILLERS.has(w.toLowerCase());

  let i = 0;
  while (i < ws.length) {
    let matched = false;
    for (let j = ws.length; j > i; j--) {
      if (isFiller(ws[j - 1]!) && j - i > 1) continue;
      // «во вторник на 11 утра» — «на …» начинает новое время: кусок про событие не заходит за него
      if (!TARGET_PREFIXES.has(ws[i]!.toLowerCase()) && ws.slice(i + 1, j).some((w) => TARGET_PREFIXES.has(w.toLowerCase()))) continue;
      const fragment = ws.slice(i, j).join(" ");
      if (j - i > 1 && !out.shift && !out.duration && ok(fragment, wantsDuration ? "duration" : "shift")) {
        if (wantsDuration) out.duration = fragment;
        else out.shift = fragment;
      } else if (ok(fragment, "point")) {
        const isTarget = TARGET_PREFIXES.has(ws[i]!.toLowerCase());
        if (isTarget && !out.target) out.target = fragment;
        else if (!isTarget) references.push(fragment);
        else continue;
      } else {
        continue;
      }
      i = j;
      matched = true;
      break;
    }
    if (!matched) i++;
  }
  // «завтрашнюю встречу в 15» — два куска про одно событие: склеиваем, если так разбирается
  if (references.length) {
    const joined = references.join(" ");
    out.reference = references.length > 1 && ok(joined, "point") ? joined : references[0]!;
  }
  return out;
}

// --- Повторения (US-32) -------------------------------------------------------

export interface RecurrenceSpan {
  /** «каждый понедельник в 10», «по будням до конца года». */
  span: string;
  /** Текст без правила — из него берутся длительность и название. */
  rest: string;
}

/**
 * Правило повторения в сообщении: самый длинный кусок, который разбирается как повторение и при этом
 * не разбирается как обычная дата — «в понедельник» остаётся разовой встречей, «каждый понедельник» и
 * «по понедельникам» — серией.
 */
/** Слово, без которого правила нет: «по 20 ноября» в «с 10 по 20 ноября» — не «каждый год 20 ноября». */
const RECURRENCE_MARKER = /^(кажд|ежедневн|еженедельн|ежемесячн|ежегодн|будн|выходным|every|each|daily|weekly|monthly|yearly|annually|weekdays|weekends|месяца$|month$|раз$)/i;
const isRecurrenceMarker = (w: string) => RECURRENCE_MARKER.test(w) || WEEKDAYS_PLURAL_DATIVE.has(w.toLowerCase());

export function extractRecurrenceSpan(text: string, now: string, tz: string): RecurrenceSpan | undefined {
  const ws = words(text);
  const isFiller = (w: string) => FILLERS.has(w.toLowerCase()) || w.toLowerCase() === "во";
  const ok = (fragment: string) =>
    fragment.split(" ").some(isRecurrenceMarker) &&
    "recurrence" in parseDateFragment({ text: fragment, kind: "recurrence", now, tz }) &&
    !isUsable(parseDateFragment({ text: fragment, kind: "point", now, tz }));
  for (let i = 0; i < ws.length; i++) {
    for (let j = ws.length; j > i; j--) {
      if (isFiller(ws[j - 1]!)) continue;
      const fragment = ws.slice(i, j).join(" ");
      if (ok(fragment)) return { span: fragment, rest: [...ws.slice(0, i), ...ws.slice(j)].join(" ") };
    }
  }
  return undefined;
}
