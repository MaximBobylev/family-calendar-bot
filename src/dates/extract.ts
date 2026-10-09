// Извлечение фрагментов дат из всего сообщения — детерминированно, без LLM.
// LLM (особенно маленькие модели) теряет части дат («завтра» из «завтра в 15:30») и не заполняет
// длительность, поэтому даты берём из исходного текста: самые длинные куски, которые разбирает парсер.
// Незнакомое слово («с Петей», «банк») обрывает кусок — названия в даты не попадают.

import { parseDateFragment } from "./index";
import { FILLERS, MONTHS, WEEKDAYS, WEEKDAYS_PLURAL_DATIVE } from "./lexicon";
import type { ParseResult, ValueKind } from "./types";

export interface ExtractedSpans {
  /** Все куски-моменты по порядку, склеенные: «в пятницу» + «в 15» → «в пятницу в 15». */
  point?: string;
  /** Куски, из которых собран point, по отдельности: в тексте они могут стоять не подряд («в субботу … к 11») —
   * из названия их вырезают по одному (QA R1 NLU, класс G). */
  pointParts?: string[];
  /** Период для чтения расписания. */
  range?: string;
  duration?: string;
  /** Дата сказана, но кусками, которые вместе не разбираются («через две недели … во вторник в 9»), или в конструкции,
   * которую парсер не знает («в первый понедельник ноября»): point не даём — лучше спросить, чем угадать (ревью 2026-10-08). */
  unsure?: true;
  /** Время с поясом, которого мы не знаем («в 15 по Варне», «3pm Lagos time»): не отбрасываем молча, а спрашиваем
   * время по своему поясу (tech-debt #26). Вместе с ним всегда `unsure`. */
  unknownZone?: string;
  /** Слова, вошедшие в даты, — чтобы убрать их из названия. */
  usedWords: Set<number>;
}

const isUsable = (r: ParseResult) => !("error" in r) || r.error === "in_past";

/** «не в пятницу, а в субботу», «not Friday» — отрицаемый кусок не дата события. */
const NEGATION = /^(не|not)$/i;
/** Порядковое перед днём недели: «в первый понедельник ноября», «last Friday of the month» — парсер этого не знает. */
const ORDINAL = /^(перв|втор|трет|четв[её]рт|пят(ый|ая|ую|ое|ой)$|последн|first$|second$|third$|fourth$|fifth$|last$)/i;
/** «16–28 июня», «6-20 JULY» — дни месяца диапазоном, а не время 16:28 (вёрстка афиш, tech-debt #28). */
const DAY_SPAN = /^\d{1,2}\s*[–—-]\s*\d{1,2}$/;
/** «7TH STREET», «2nd floor» — порядковое в адресе, а не число месяца. */
const ADDRESS_ORDINAL = /^\d{1,3}(st|nd|rd|th)$/i;
const ADDRESS_WORDS = /^(street|st|avenue|ave|av|floor|fl|road|rd|boulevard|blvd|lane|ln|place|pl|row|grade|precinct|district)$/i;

const notEventDate = (fragment: string, last: string, after: string, len: number) =>
  (len === 1 && DAY_SPAN.test(fragment) && MONTHS.has(after.toLowerCase())) || (ADDRESS_ORDINAL.test(last) && ADDRESS_WORDS.test(after));

/** «через неделю после дня рождения» — сдвиг от неизвестного события, а не от сегодня. */
const RELATIVE_START = /^(через|спустя|in)$/i;
const ANCHOR_AFTER = /^(после|after|before)$/i;
/** «по Зуму», «по Скайпу» — канал, а не город: с заглавной, но не пояс. */
const NOT_PLACES =
  /^(зум|zoom|скайп|skype|телеграм|telegram|ватсап|вотсап|whatsapp|вайбер|viber|телефон|видео|meet|teams|тимс|гугл|google|discord|дискорд|слак|slack|вк|vk)/i;

/**
 * Пояс, которого нет в словаре, сразу после куска-момента: «… в 15 по Варне», «по пражскому времени» (известные пояса
 * парсер уже включил в кусок), «по времени Варны», «3pm Lagos time». Город узнаём по заглавной букве — «по работе»,
 * «по проекту» не пояс.
 */
function unknownZoneAt(ws: string[], j: number): string | undefined {
  const a = ws[j];
  const b = ws[j + 1];
  if (!a || !b) return undefined;
  if (a.toLowerCase() === "по") {
    if (b.toLowerCase() === "времени" && ws[j + 2]) return ws.slice(j, j + 3).join(" ");
    if (ws[j + 2]?.toLowerCase() === "времени") return ws.slice(j, j + 3).join(" ");
    // «по Ленинградскому проспекту» — прилагательное без «времени» не пояс
    return /^\p{Lu}/u.test(b) && !NOT_PLACES.test(b) && !/(ому|ему)$/i.test(b) ? `${a} ${b}` : undefined;
  }
  return /^\p{Lu}/u.test(a) && b.toLowerCase() === "time" ? `${a} ${b}` : undefined;
}

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
  let unsure = false;
  let unknownZone: string | undefined;

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
        const before = ws[i - 1] ?? "";
        const after = ws[j] ?? "";
        if (kind === "point" && ORDINAL.test(before) && WEEKDAYS.has(ws[i]!.toLowerCase())) unsure = true;
        else if (kind === "point" && RELATIVE_START.test(ws[i]!) && ANCHOR_AFTER.test(after)) unsure = true;
        // Отрицаемый кусок, дни диапазоном перед месяцем, порядковое в адресе — не дата события: слова съедаем молча
        else if (!NEGATION.test(before) && !(kind === "point" && notEventDate(fragment, ws[j - 1]!, after, j - i))) {
          points.push(fragment);
          const zone = kind === "point" ? unknownZoneAt(ws, j) : undefined;
          if (zone) {
            unknownZone ??= zone;
            unsure = true;
          }
        }
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
  if (joined) {
    const whole = parses(joined, kind);
    if (kind === "point") {
      // Куски момента, которые вместе не разбираются, — противоречие или незнакомая конструкция: не угадываем
      // первый («через две недели» из «через две недели во вторник в 9»), а отдаём решение LLM / вопросу
      if (whole && !unsure) {
        out.point = joined;
        out.pointParts = points;
      } else unsure = true;
    } else out.range = whole ? joined : points[0]!;
  }
  if (unsure && kind === "point") out.unsure = true;
  if (unknownZone) out.unknownZone = unknownZone;
  if (duration) out.duration = duration;
  return out;
}

/** Слова, по которым событие без времени считается событием на весь день (US-31). */
const ALL_DAY_PATTERNS = [
  /день рождени/i,
  /(?<!\p{L})др(?!\p{L})/iu,
  /годовщин/i,
  /юбиле/i,
  /отпуск/i,
  /праздник/i,
  /командировк/i,
  /выходной/i,
  /весь день/i,
  /birthday/i,
  /anniversary/i,
  /vacation/i,
  /holiday/i,
  /all day/i,
  /day off/i,
];

export function looksAllDay(text: string): boolean {
  return ALL_DAY_PATTERNS.some((p) => p.test(text));
}

/** Название без слов, ушедших в даты; пустое или служебное («встреча») — нет названия. */
const GENERIC_TITLES = new Set(["встреча", "встречу", "событие", "мероприятие", "meeting", "event", "напоминание"]);

/**
 * Вырезать куски дат из текста, каждый по отдельности (первое вхождение, без регистра). Кусок, который уже вошёл в
 * вырезанный ранее («в субботу» после «в субботу к 11»), пропускаем — не задеть такое же слово в другом месте.
 */
export function removeFragments(text: string, fragments: (string | undefined)[]): string {
  let t = text;
  const removed: string[] = [];
  for (const f of fragments) {
    if (!f?.trim() || removed.some((r) => r.toLowerCase().includes(f.toLowerCase()))) continue;
    const re = new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (!re.test(t)) continue;
    t = t.replace(re, " ");
    removed.push(f);
  }
  return t;
}

export function cleanTitle(title: string | undefined, dateFragments: string[]): string | undefined {
  if (!title) return undefined;
  let t = removeFragments(title, dateFragments);
  t = t
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,.\-—]+|[,.\-—]+$/g, "")
    .trim();
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
  /** «каждый понедельник в 10», «по будням до конца года» — правило для парсера (kind=recurrence). */
  span: string;
  /** Слова сообщения, вошедшие в правило, — убрать из названия (если span собран, а не вырезан как есть). */
  remove?: string[];
  /** Текст без правила — из него берутся длительность и название. */
  rest: string;
}

/**
 * Правило повторения в сообщении: самый длинный кусок, который разбирается как повторение и при этом
 * не разбирается как обычная дата — «в понедельник» остаётся разовой встречей, «каждый понедельник» и
 * «по понедельникам» — серией.
 */
/** Слово, без которого правила нет: «по 20 ноября» в «с 10 по 20 ноября» — не «каждый год 20 ноября». */
const RECURRENCE_MARKER =
  /^(кажд|ежедневн|еженедельн|ежемесячн|ежегодн|будн|выходным|every|each|daily|weekly|monthly|yearly|annually|weekdays|weekends|месяца$|month$|раз$)/i;
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
  return regularWeekday(text, now, tz);
}

/** «регулярную», «повторяющуюся», «еженедельную» встречу — признак серии, хотя день назван разово. */
const REGULAR = /(?<!\p{L})(регулярн\p{L}*|повторяющ\p{L}*|еженедельн\p{L}*|recurring|regular|weekly)(?!\p{L})/iu;

/**
 * «Создай регулярную встречу на понедельник в 3 часа дня» (голос, 2026-10-05): маркер серии отдельно от даты.
 * Если дата — день недели (с временем или без), правило = «каждый <день> …». Иначе не угадываем.
 */
function regularWeekday(text: string, now: string, tz: string): RecurrenceSpan | undefined {
  const marker = REGULAR.exec(text)?.[1];
  if (!marker) return undefined;
  const point = extractDateSpans(text.replace(marker, " "), now, tz, "point").point;
  // Две проверки, а не `!point?.split(…)`: так TypeScript сужает point до string для строк ниже
  if (!point) return undefined;
  if (!point.split(/\s+/).some((w) => WEEKDAYS.has(w.toLowerCase()))) return undefined;
  const span = `каждый ${point.replace(/^(на|в|во|on)\s+/i, "")}`;
  if (!("recurrence" in parseDateFragment({ text: span, kind: "recurrence", now, tz }))) return undefined;
  const rest = text.replace(marker, " ").replace(point, " ").replace(/\s+/g, " ").trim();
  return { span, rest, remove: [marker, point] };
}
