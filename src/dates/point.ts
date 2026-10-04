// kind=point и kind=range: грамматика (токены → AST) и правила date-rules.md (AST → результат).
// Принцип: любое незнакомое слово → unparseable. Никаких догадок.

import {
  addMonths, addRealMinutes, compare, convertZone, daysInMonth, formatDate, formatMoment, isValidDate,
  makeDay, parts, startOfWeek, weekday, type Day, type Moment,
} from "./calendar";
import { readDuration } from "./duration";
import {
  DAY_PART_BOUNDS, DAY_PART_WORDS, FILLERS, MERIDIEM_WORDS, MONTHS, MONTHS_PREPOSITIONAL, TIMEZONE_WORDS, UNITS,
  WEEKDAY_INDEX, WEEKDAYS, type Meridiem,
} from "./lexicon";
import type { Token } from "./tokenize";
import type { DayPart, ParseError, ParseResult, ParseValue, Weekday } from "./types";

// --- AST -------------------------------------------------------------------

export interface TimeAst {
  h: number;
  m: number;
  mer?: Meridiem;
  special?: "noon" | "midnight";
}

export interface AbsAst {
  d: number;
  m?: number;
  y?: number;
}

type WeekdayMod = "none" | "this" | "next" | "nextWeek" | "plusWeek";

type DateAst =
  | { k: "rel"; days: number }
  | { k: "relMonths"; months: number }
  | { k: "wd"; wd: Weekday; mod: WeekdayMod }
  | { k: "abs"; abs: AbsAst; wd?: Weekday };

type Period =
  | { k: "week"; which: "this" | "next" }
  | { k: "weekend"; which: "this" | "next" }
  | { k: "month"; which: "this" | "next" | number }
  | { k: "nextDays"; n: number }
  | { k: "weeksAhead"; n: number };

interface Ast {
  date?: DateAst;
  time?: TimeAst;
  part?: DayPart;
  relMinutes?: number;
  tz?: string;
  interval?: { start: TimeAst; end: TimeAst };
  dateRange?: { from: AbsAst; to: AbsAst };
  period?: Period;
  week?: "this" | "next";
}

class Unparseable extends Error {
  constructor(readonly reason: ParseError = "unparseable") {
    super(reason);
  }
}

// --- Чтение времени --------------------------------------------------------

const word = (tok: Token | undefined) => (tok?.t === "word" ? tok.w : undefined);
const HOUR_WORDS = new Set(["часов", "часа", "час", "ч", "o'clock", "oclock"]);

function checkTime(t: TimeAst): TimeAst {
  if (t.h > 24 || t.m > 59 || t.h < 0) throw new Unparseable("invalid_time");
  if (t.h === 24 && t.m === 0) return { h: 0, m: 0, special: "midnight" };
  if (t.h === 24) throw new Unparseable("invalid_time");
  return t;
}

/** Хвост после числа: «часов», «утра», «pm». */
function readMeridiemTail(tokens: Token[], i: number): { mer?: Meridiem; n: number } {
  let n = 0;
  if (HOUR_WORDS.has(word(tokens[i]) ?? "")) n++;
  const tok = tokens[i + n];
  if (tok?.t === "mer") return { mer: tok.v, n: n + 1 };
  return { n };
}

/**
 * Время цифрами или словами: «15:30», «9», «пятнадцать тридцать», «восемнадцать 00», «3pm».
 * `context` — перед этим было «в»/«at», то есть одиночное число — это время, а не что-то другое.
 */
export function readClockTime(
  tokens: Token[],
  i: number,
  context: boolean,
): { time: TimeAst; n: number } | { error: ParseError } | null {
  const tok = tokens[i];
  try {
    if (tok?.t === "clock") {
      const tail = readMeridiemTail(tokens, i + 1);
      return { time: checkTime({ h: tok.h, m: tok.m, ...(tail.mer ? { mer: tail.mer } : {}) }), n: 1 + tail.n };
    }
    if (tok?.t === "num" && (tok.form === "digit" || tok.form === "card")) {
      let n = 1;
      let m = 0;
      // «пятнадцать тридцать», «восемнадцать 00» — второе число как минуты
      const next = tokens[i + 1];
      if (next?.t === "num" && (next.form === "card" || next.form === "digit") && next.v <= 59 && (tok.form === "card" || next.v === 0)) {
        m = next.v;
        n++;
      }
      const tail = readMeridiemTail(tokens, i + n);
      if (!context && !tail.mer && tail.n === 0) return null;
      return { time: checkTime({ h: tok.v, m, ...(tail.mer ? { mer: tail.mer } : {}) }), n: n + tail.n };
    }
  } catch (e) {
    if (e instanceof Unparseable) return { error: e.reason };
    throw e;
  }
  return null;
}

/** Разговорные формы: «полтретьего», «в половине третьего», «без пятнадцати три», «пять минут восьмого». */
function readSpokenTime(tokens: Token[], i: number): { time: TimeAst; n: number } | null {
  const w = word(tokens[i]);
  const t1 = tokens[i + 1];
  const t2 = tokens[i + 2];
  if ((w === "половине" || w === "пол") && t1?.t === "num" && t1.form === "ordGen" && t1.v <= 12) {
    return { time: { h: t1.v - 1, m: 30 }, n: 2 };
  }
  if (w === "без") {
    const minutes = word(t1) === "четверти" ? 15 : t1?.t === "num" && (t1.form === "gen" || t1.form === "digit") ? t1.v : undefined;
    let hourIdx = i + 2;
    if (minutes !== undefined && UNITS.get(word(t2) ?? "") === "minute") hourIdx++;
    const hourTok = tokens[hourIdx];
    if (minutes !== undefined && minutes < 60 && hourTok?.t === "num" && hourTok.v >= 1 && hourTok.v <= 12) {
      return { time: { h: hourTok.v - 1 || 12, m: 60 - minutes }, n: hourIdx - i + 1 };
    }
    return null;
  }
  // «half past three», «quarter past 9», «quarter to 5»
  if ((w === "half" || w === "quarter") && (word(t1) === "past" || word(t1) === "to") && t2?.t === "num" && t2.v >= 1 && t2.v <= 12) {
    const minutes = w === "half" ? 30 : 15;
    return word(t1) === "past"
      ? { time: { h: t2.v, m: minutes }, n: 3 }
      : { time: { h: t2.v - 1 || 12, m: 60 - minutes }, n: 3 };
  }
  const t0 = tokens[i];
  if (t0?.t === "num" && t0.form !== "ordGen" && UNITS.get(word(t1) ?? "") === "minute" && t2?.t === "num" && t2.form === "ordGen" && t2.v <= 12) {
    return { time: { h: t2.v - 1, m: t0.v }, n: 3 };
  }
  return null;
}

/** Любое время — для интервалов «с … до …». */
function readAnyTime(tokens: Token[], i: number): { time: TimeAst; n: number } | null {
  const spoken = readSpokenTime(tokens, i);
  if (spoken) return spoken;
  const tok = tokens[i];
  // «с часу до двух»: родительный падеж числа — тоже час
  if (tok?.t === "num" && tok.form === "gen") {
    const tail = readMeridiemTail(tokens, i + 1);
    return { time: { h: tok.v, m: 0, ...(tail.mer ? { mer: tail.mer } : {}) }, n: 1 + tail.n };
  }
  const clock = readClockTime(tokens, i, true);
  if (clock && "error" in clock) throw new Unparseable(clock.error);
  return clock;
}

// --- Правило часа без AM/PM (date-rules.md) --------------------------------

export interface ResolvedHour {
  hour: number;
  /** +1 день: полночь, «12 ночи». */
  dayOffset: number;
  /** Час без указания части суток 1…12. */
  bare: boolean;
  /** Утренний час 7…12 без части суток — у него есть «вечерняя» альтернатива. */
  hasPmAlternative: boolean;
}

export function resolveHour(t: TimeAst): ResolvedHour {
  const plain = { dayOffset: 0, bare: false, hasPmAlternative: false };
  if (t.special === "noon") return { hour: 12, ...plain };
  if (t.special === "midnight") return { hour: 0, ...plain, dayOffset: 1 };
  const { h, mer } = t;
  switch (mer) {
    case "am": return { hour: h === 12 ? 0 : h, ...plain };
    case "pm":
    case "day": return { hour: h < 12 ? h + 12 : h, ...plain };
    case "night":
      if (h === 12 || h === 0) return { hour: 0, ...plain, dayOffset: 1 };
      return { hour: h >= 9 ? h + 12 : h, ...plain };
  }
  if (h >= 1 && h <= 6) return { hour: h + 12, ...plain, bare: true };
  if (h >= 7 && h <= 12) return { hour: h, ...plain, bare: true, hasPmAlternative: true };
  return { hour: h, ...plain };
}

const PART_AS_MERIDIEM: Record<DayPart, Meridiem> = {
  morning: "am", day: "day", afternoon: "pm", evening: "pm", night: "night",
};

// --- Даты ------------------------------------------------------------------

/** Абсолютная дата без года/месяца → ближайшая будущая (включая сегодня). */
export function resolveAbsDate(abs: AbsAst, today: Day): { day: Day } | { error: ParseError } {
  const t = parts(today);
  if (abs.m !== undefined && abs.y !== undefined) {
    return isValidDate(abs.y, abs.m, abs.d) ? { day: makeDay(abs.y, abs.m, abs.d) } : { error: "invalid_date" };
  }
  if (abs.m !== undefined) {
    // Проверяем, бывает ли такая дата вообще (29 февраля — бывает).
    if (!isValidDate(2028, abs.m, abs.d)) return { error: "invalid_date" };
    for (let y = t.year; y <= t.year + 8; y++) {
      if (isValidDate(y, abs.m, abs.d) && makeDay(y, abs.m, abs.d) >= today) return { day: makeDay(y, abs.m, abs.d) };
    }
    return { error: "invalid_date" };
  }
  if (abs.d < 1 || abs.d > 31) return { error: "invalid_date" };
  for (let k = 0; k < 13; k++) {
    const first = addMonths(makeDay(t.year, t.month, 1), k);
    const p = parts(first);
    if (abs.d <= daysInMonth(p.year, p.month) && makeDay(p.year, p.month, abs.d) >= today) {
      return { day: makeDay(p.year, p.month, abs.d) };
    }
  }
  return { error: "invalid_date" };
}

/** Ближайший день недели строго после `today`. */
function nearest(wd: Weekday, today: Day): Day {
  const diff = (WEEKDAY_INDEX[wd] - weekday(today) + 7) % 7;
  return today + (diff === 0 ? 7 : diff);
}

// --- Грамматика ------------------------------------------------------------

const APPROX_WORDS = new Set(["где-то", "примерно", "приблизительно", "approximately", "roughly"]);
const THIS_WORDS = new Set(["эту", "этот", "это", "эта", "this", "эти", "этих"]);
const NEXT_WORDS = new Set(["следующую", "следующий", "следующее", "следующая", "следующих", "следующие", "next"]);

function readAbs(tokens: Token[], i: number): { abs: AbsAst; n: number } | null {
  const tok = tokens[i];
  const nextMonth = MONTHS.get(word(tokens[i + 1]) ?? "");
  const yearAfter = (k: number) => {
    const y = tokens[k];
    return y?.t === "num" && y.form === "digit" && y.v >= 1000 ? y.v : undefined;
  };
  if (tok?.t === "iso") return { abs: { d: tok.d, m: tok.m, y: tok.y }, n: 1 };
  if (tok?.t === "dayord" || (tok?.t === "num" && (tok.form === "ordGen" || tok.form === "digit") && nextMonth)) {
    if (nextMonth) {
      const y = yearAfter(i + 2);
      return { abs: { d: tok.v, m: nextMonth, ...(y ? { y } : {}) }, n: y ? 3 : 2 };
    }
    return { abs: { d: tok.v }, n: 1 };
  }
  if (tok?.t === "num" && tok.form === "ordGen") return { abs: { d: tok.v }, n: 1 };
  // «Oct 14»
  const month = MONTHS.get(word(tok) ?? "");
  const dayTok = tokens[i + 1];
  if (month && (dayTok?.t === "num" || dayTok?.t === "dayord")) {
    const y = yearAfter(i + 2);
    return { abs: { d: dayTok.v, m: month, ...(y ? { y } : {}) }, n: y ? 3 : 2 };
  }
  return null;
}

function parseAst(tokens: Token[]): Ast {
  const ast: Ast = {};
  let i = 0;
  let timeContext = false;
  let pendingMod: WeekdayMod = "none";

  const setDate = (d: DateAst) => {
    if (!ast.date) return void (ast.date = d);
    // «в среду 14-го» — день недели вместе с числом
    if (ast.date.k === "wd" && d.k === "abs") return void (ast.date = { k: "abs", abs: d.abs, wd: ast.date.wd });
    if (ast.date.k === "abs" && d.k === "wd") return void (ast.date = { ...ast.date, wd: d.wd });
    throw new Unparseable();
  };
  const setTime = (t: TimeAst) => {
    if (ast.time) throw new Unparseable();
    ast.time = t;
  };

  while (i < tokens.length) {
    const tok = tokens[i]!;
    const w = word(tok);
    const w1 = word(tokens[i + 1]);
    const ctx = timeContext;
    timeContext = false;

    if (w === "в" || w === "во" || w === "at") { timeContext = true; i++; continue; }

    // Приблизительное время = точное: «где-то в 3», «примерно в 11», «часов в 5», «около трёх»
    if (w && APPROX_WORDS.has(w)) { timeContext = true; i++; continue; }
    if (w === "часов" && word(tokens[i + 1]) === "в") { i++; continue; }
    if (w === "около" || w === "around" || w === "about") {
      const t = tokens[i + 1];
      if (t?.t === "num" && t.form === "gen" && t.v <= 12) {
        const tail = readMeridiemTail(tokens, i + 2);
        setTime({ h: t.v, m: 0, ...(tail.mer ? { mer: tail.mer } : {}) });
        i += 2 + tail.n;
        continue;
      }
      timeContext = true;
      i++;
      continue;
    }

    // «в обед» = 13:00 — только после «в»/«at»: само слово «Обед» обычно название события
    if (ctx && (w === "обед" || w === "lunch" || w === "lunchtime")) { setTime({ h: 13, m: 0 }); i++; continue; }

    // Явный пояс: «по Москве», «по московскому времени», «мск»
    if (w === "по" && w1 && TIMEZONE_WORDS.has(w1)) {
      ast.tz = TIMEZONE_WORDS.get(w1)!;
      i += word(tokens[i + 2]) === "времени" ? 3 : 2;
      continue;
    }
    if (w && TIMEZONE_WORDS.has(w)) { ast.tz = TIMEZONE_WORDS.get(w)!; i++; continue; }

    // Интервалы: «с часу до двух», «from 1 to 2pm», «с 10 по 20 ноября»
    if (w === "с" || w === "from") {
      const startT = readAnyTime(tokens, i + 1);
      if (startT && ["до", "to", "-", "till", "until"].includes(word(tokens[i + 1 + startT.n]) ?? "")) {
        const endT = readAnyTime(tokens, i + 2 + startT.n);
        if (!endT) throw new Unparseable();
        ast.interval = { start: startT.time, end: endT.time };
        i += 2 + startT.n + endT.n;
        continue;
      }
      // «с 10 по 20 ноября» — у начала диапазона месяц может быть не назван
      const bareDay = tokens[i + 1];
      const startD =
        readAbs(tokens, i + 1) ??
        (bareDay?.t === "num" && bareDay.form === "digit" && ["по", "до", "-"].includes(word(tokens[i + 2]) ?? "")
          ? { abs: { d: bareDay.v }, n: 1 }
          : null);
      if (startD && ["по", "до", "to", "-"].includes(word(tokens[i + 1 + startD.n]) ?? "")) {
        const endD = readAbs(tokens, i + 2 + startD.n);
        if (!endD) throw new Unparseable();
        ast.dateRange = { from: { ...startD.abs, m: startD.abs.m ?? endD.abs.m }, to: endD.abs };
        i += 2 + startD.n + endD.n;
        continue;
      }
      throw new Unparseable();
    }

    // «через час», «через 2 дня», «in 2 hours», «через неделю»
    if (w === "через" || w === "in") {
      const dur = readDuration(tokens, i + 1);
      if (dur) {
        if (dur.d.minutes) ast.relMinutes = dur.d.minutes;
        else if (dur.d.months) setDate({ k: "relMonths", months: dur.d.months });
        else if (dur.d.days === 7 && ast.date?.k === "wd") ast.date.mod = "plusWeek";
        else setDate({ k: "rel", days: dur.d.days });
        i += 1 + dur.n;
        continue;
      }
      if (w === "in") { i++; continue; } // «in the morning»
      throw new Unparseable();
    }
    // «a week from today»
    if (w === "a" || w === "an") {
      const dur = readDuration(tokens, i);
      if (dur && word(tokens[i + dur.n]) === "from" && word(tokens[i + dur.n + 1]) === "today") {
        setDate({ k: "rel", days: dur.d.days });
        i += dur.n + 2;
        continue;
      }
      throw new Unparseable();
    }

    // Полдень / полночь
    if (w === "полдень" || w === "noon") { setTime({ h: 12, m: 0, special: "noon" }); i++; continue; }
    if (w === "полночь" || w === "midnight") { setTime({ h: 0, m: 0, special: "midnight" }); i++; continue; }

    const spoken = readSpokenTime(tokens, i);
    if (spoken) {
      const tail = readMeridiemTail(tokens, i + spoken.n);
      setTime({ ...spoken.time, ...(tail.mer ? { mer: tail.mer } : {}) });
      i += spoken.n + tail.n;
      continue;
    }

    // «14.10» — дата, «в 15.30» — время
    if (tok.t === "dm") {
      const asTime = !tok.y && tok.a <= 24 && tok.b <= 59 && (ctx || tok.b > 12);
      if (asTime) {
        const tail = readMeridiemTail(tokens, i + 1);
        setTime(checkTime({ h: tok.a, m: tok.b, ...(tail.mer ? { mer: tail.mer } : {}) }));
        i += 1 + tail.n;
      } else {
        setDate({ k: "abs", abs: { d: tok.a, m: tok.b, ...(tok.y ? { y: tok.y } : {}) } });
        i++;
      }
      continue;
    }

    const abs = readAbs(tokens, i);
    if (abs) { setDate({ k: "abs", abs: abs.abs }); i += abs.n; continue; }

    const clock = readClockTime(tokens, i, ctx);
    if (clock) {
      if ("error" in clock) throw new Unparseable(clock.error);
      setTime(clock.time);
      i += clock.n;
      continue;
    }

    // Относительные дни
    const relDay: Record<string, number> = { сегодня: 0, today: 0, завтра: 1, tomorrow: 1, послезавтра: 2, вчера: -1, yesterday: -1, позавчера: -2 };
    if (w && w in relDay) { setDate({ k: "rel", days: relDay[w]! }); i++; continue; }
    if (w === "day" && w1 === "after" && word(tokens[i + 2]) === "tomorrow") { setDate({ k: "rel", days: 2 }); i += 3; continue; }

    // Неделя / выходные / месяц с модификатором
    const isThis = w !== undefined && THIS_WORDS.has(w);
    const isNext = w !== undefined && NEXT_WORDS.has(w);
    if ((isThis || isNext) && w1) {
      const which = isNext ? "next" : "this";
      if (/^(неделе|неделю|неделя|week)$/.test(w1)) { ast.week = which; i += 2; continue; }
      if (/^(выходные|выходных|weekend)$/.test(w1)) { ast.period = { k: "weekend", which }; i += 2; continue; }
      if (/^(месяце|месяц|month)$/.test(w1)) { ast.period = { k: "month", which }; i += 2; continue; }
      if (w1 === "morning" && isThis) { setDate({ k: "rel", days: 0 }); ast.part = "morning"; i += 2; continue; }
      if (WEEKDAYS.has(w1)) { pendingMod = which; i++; continue; }
      throw new Unparseable();
    }
    if (w === "этой" && w1 === "неделе") { ast.week = "this"; i += 2; continue; }
    if (w === "следующей" && w1 === "неделе") { ast.week = "next"; i += 2; continue; }
    if (w === "этом" && w1 === "месяце") { ast.period = { k: "month", which: "this" }; i += 2; continue; }
    if (w === "следующем" && w1 === "месяце") { ast.period = { k: "month", which: "next" }; i += 2; continue; }

    if (w && WEEKDAYS.has(w)) {
      setDate({ k: "wd", wd: WEEKDAYS.get(w)!, mod: pendingMod });
      pendingMod = "none";
      i++;
      continue;
    }

    // Части суток
    if (w && DAY_PART_WORDS.has(w)) { ast.part = DAY_PART_WORDS.get(w)!; i++; continue; }
    if (w === "после" && w1 === "обеда") { ast.part = "afternoon"; i += 2; continue; }
    if (tok.t === "mer" && !ast.time) {
      const part: Partial<Record<Meridiem, DayPart>> = { am: "morning", day: "day", pm: "evening", night: "night" };
      ast.part = part[tok.v]!;
      i++;
      continue;
    }

    // Периоды для чтения
    if (w && /^(выходные|выходных|weekend)$/.test(w)) { ast.period = { k: "weekend", which: "this" }; i++; continue; }
    if (w && /^(неделю|неделя|week)$/.test(w)) { ast.week = "this"; i++; continue; }
    if (w && MONTHS_PREPOSITIONAL.has(w)) { ast.period = { k: "month", which: MONTHS.get(w)! }; i++; continue; }
    if (w === "до" && w1 === "конца") {
      const what = word(tokens[i + 2]);
      if (what === "недели") { ast.week = "this"; i += 3; continue; }
      if (what === "месяца") { ast.period = { k: "month", which: "this" }; i += 3; continue; }
      throw new Unparseable();
    }
    if (w === "ближайшие" || w === "next") {
      const dur = readDuration(tokens, i + 1);
      if (dur?.d.days) { ast.period = { k: "nextDays", n: dur.d.days }; i += 1 + dur.n; continue; }
      throw new Unparseable();
    }
    if (tok.t === "num") {
      const dur = readDuration(tokens, i);
      if (dur?.d.days && /^(вперед|ahead)$/.test(word(tokens[i + dur.n]) ?? "")) {
        ast.period = { k: "weeksAhead", n: dur.d.days / 7 };
        i += dur.n + 1;
        continue;
      }
    }

    if (w && FILLERS.has(w)) { i++; continue; }
    if (tok.t === "mer") throw new Unparseable();
    throw new Unparseable();
  }

  if (ast.week && ast.date?.k === "wd") {
    if (ast.week === "next") ast.date.mod = "nextWeek";
    delete ast.week;
  }
  return ast;
}

// --- Разрешение по правилам ------------------------------------------------

const at = (day: Day, minutes: number): Moment => ({ day, minutes });
const dt = (m: Moment): ParseValue => ({ datetime: formatMoment(m) });

function dateValue(day: Day, part?: DayPart): ParseValue {
  return { date: part ? { date: formatDate(day), part } : formatDate(day) };
}

function effectiveTime(ast: Ast): TimeAst | undefined {
  if (!ast.time) return undefined;
  if (ast.part && !ast.time.mer && !ast.time.special) return { ...ast.time, mer: PART_AS_MERIDIEM[ast.part] };
  return ast.time;
}

/** Кандидаты дат из AST (1 или 2 — для неоднозначных). */
function resolveDays(date: DateAst, now: Moment, time: ResolvedHour | undefined, minutes: number): Day[] {
  const today = now.day;
  switch (date.k) {
    case "rel": return [today + date.days];
    case "relMonths": return [addMonths(today, date.months)];
    case "abs": {
      const res = resolveAbsDate(date.abs, today);
      if ("error" in res) throw new Unparseable(res.error);
      if (!date.wd || weekday(res.day) === WEEKDAY_INDEX[date.wd]) return [res.day];
      // День недели не совпал с числом — оба варианта (число; тот же день недели в той же неделе)
      return [res.day, startOfWeek(res.day) + WEEKDAY_INDEX[date.wd]];
    }
    case "wd": {
      const isToday = weekday(today) === WEEKDAY_INDEX[date.wd];
      switch (date.mod) {
        case "this": return [isToday ? today : nearest(date.wd, today)];
        case "next": {
          const n = nearest(date.wd, today);
          return [n, n + 7];
        }
        case "nextWeek": return [startOfWeek(today) + 7 + WEEKDAY_INDEX[date.wd]];
        case "plusWeek": return [nearest(date.wd, today) + 7];
        case "none":
          if (!isToday) return [nearest(date.wd, today)];
          if (!time) return [today, today + 7];
          return compare(at(today + time.dayOffset, time.hour * 60 + minutes), now) > 0 ? [today, today + 7] : [today + 7];
      }
    }
  }
}

function resolvePoint(ast: Ast, now: Moment, tz: string): ParseResult {
  if (ast.relMinutes !== undefined) {
    if (ast.date || ast.time) throw new Unparseable();
    return dt(addRealMinutes(now, ast.relMinutes, tz));
  }

  if (ast.dateRange) {
    const from = resolveAbsDate(ast.dateRange.from, now.day);
    const to = resolveAbsDate(ast.dateRange.to, now.day);
    if ("error" in from) return from;
    if ("error" in to) return to;
    return { range: { from: formatDate(from.day), to: formatDate(to.day) } };
  }

  if (ast.interval) {
    const s = resolveHour(ast.interval.start.mer || !ast.interval.end.mer ? ast.interval.start : { ...ast.interval.start, mer: ast.interval.end.mer });
    const e = resolveHour(ast.interval.end);
    const day = ast.date ? resolveDays(ast.date, now, s, ast.interval.start.m)[0]! : now.day;
    const start = at(day + s.dayOffset, s.hour * 60 + ast.interval.start.m);
    // Конец — ближайшее подходящее время после начала (с учётом «2» = 02:00 или 14:00)
    const endCandidates = [e.hour, ...(e.bare && e.hour < 12 ? [e.hour + 12] : []), ...(e.bare && e.hour >= 12 ? [e.hour - 12] : [])];
    let best: Moment | undefined;
    for (const h of endCandidates) {
      for (const dayShift of [0, 1]) {
        const cand = at(start.day + dayShift, h * 60 + ast.interval.end.m);
        if (compare(cand, start) > 0 && (!best || compare(cand, best) < 0)) best = cand;
      }
    }
    return { interval: { start: formatMoment(start), end: formatMoment(best!) } };
  }

  if (ast.period || ast.week) return resolveRange(ast, now);

  const time = effectiveTime(ast);
  const rh = time ? resolveHour(time) : undefined;
  const minutes = time?.m ?? 0;

  // Только время, без дня
  if (!ast.date) {
    if (!rh) {
      if (ast.part) return dateValue(now.day, ast.part);
      throw new Unparseable();
    }
    const cand = at(now.day + rh.dayOffset, rh.hour * 60 + minutes);
    if (compare(cand, now) > 0) return dt(cand);
    if (rh.hasPmAlternative) {
      const alt = rh.hour === 12 ? at(now.day + 1, minutes) : at(now.day, (rh.hour + 12) * 60 + minutes);
      const tomorrow = at(now.day + 1, rh.hour * 60 + minutes);
      return compare(alt, now) > 0 ? { ambiguous: [dt(alt), dt(tomorrow)] } : dt(tomorrow);
    }
    return dt(at(now.day + 1 + rh.dayOffset, rh.hour * 60 + minutes));
  }

  const days = resolveDays(ast.date, now, rh, minutes);
  const values = days.map((day): ParseValue | ParseError => {
    if (!rh) return day < now.day ? "in_past" : dateValue(day, ast.part);
    const cand = at(day + rh.dayOffset, rh.hour * 60 + minutes);
    if (compare(cand, now) > 0) return dt(cand);
    // День — сегодня, утреннее время прошло → вечер того же дня
    if (day === now.day && rh.hasPmAlternative && rh.hour < 12) {
      const alt = at(day, (rh.hour + 12) * 60 + minutes);
      if (compare(alt, now) > 0) return dt(alt);
    }
    return "in_past";
  });
  const ok = values.filter((v): v is ParseValue => typeof v !== "string");
  if (ok.length === 0) return { error: values[0] as ParseError };
  return ok.length === 1 ? ok[0]! : { ambiguous: ok };
}

function rangeOfDays(from: Day, to: Day): ParseValue {
  return { range: { from: formatDate(from), to: formatDate(to) } };
}

function resolveRange(ast: Ast, now: Moment): ParseResult {
  const today = now.day;
  const p = ast.period;

  if (ast.week) {
    const mon = startOfWeek(today);
    return ast.week === "this" ? rangeOfDays(today, mon + 6) : rangeOfDays(mon + 7, mon + 13);
  }
  if (p?.k === "weekend") {
    const wd = weekday(today);
    const sat = wd === 6 ? today - 1 : today + (5 - wd);
    const thisWeekend = rangeOfDays(Math.max(sat, today), sat + 1);
    if (p.which === "this") return thisWeekend;
    return { ambiguous: [thisWeekend, rangeOfDays(sat + 7, sat + 8)] };
  }
  if (p?.k === "month") {
    const t = parts(today);
    const monthRange = (y: number, m: number) => rangeOfDays(makeDay(y, m, 1), makeDay(y, m, daysInMonth(y, m)));
    if (p.which === "this" || p.which === t.month) return rangeOfDays(today, makeDay(t.year, t.month, daysInMonth(t.year, t.month)));
    if (p.which === "next") {
      const n = parts(addMonths(makeDay(t.year, t.month, 1), 1));
      return monthRange(n.year, n.month);
    }
    return monthRange(p.which > t.month ? t.year : t.year + 1, p.which);
  }
  if (p?.k === "nextDays") return rangeOfDays(today, today + p.n - 1);
  if (p?.k === "weeksAhead") return rangeOfDays(today, today + p.n * 7 - 1);

  // День (+ часть суток)
  const days = ast.date ? resolveDays(ast.date, { day: today, minutes: -1 }, undefined, 0) : [today];
  const toValue = (day: Day): ParseValue => {
    if (!ast.part) return rangeOfDays(day, day);
    const [s, e] = DAY_PART_BOUNDS[ast.part];
    return { range: { from: formatMoment(at(day, s)), to: formatMoment(at(day, e)) } };
  };
  return days.length === 1 ? toValue(days[0]!) : { ambiguous: days.map(toValue) };
}

// --- Вход ------------------------------------------------------------------

export function parsePointOrRange(tokens: Token[], kind: "point" | "range", now: Moment, tz: string): ParseResult {
  try {
    const ast = parseAst(tokens);
    // Одни служебные слова («в», «на») — не дата
    if (!ast.date && !ast.time && !ast.part && !ast.period && !ast.week && !ast.interval && !ast.dateRange && ast.relMinutes === undefined) {
      throw new Unparseable();
    }
    if (kind === "range" && !ast.time && !ast.interval && ast.relMinutes === undefined) return resolveRange(ast, now);

    if (!ast.tz || ast.tz === tz) return resolvePoint(ast, now, tz);
    // Явно названный пояс: считаем в нём и переводим результат в пояс пользователя
    const res = resolvePoint(ast, convertZone(now, tz, ast.tz), ast.tz);
    if ("datetime" in res) {
      return { datetime: formatMoment(convertZone(parseLocalMoment(res.datetime), ast.tz, tz)) };
    }
    return res;
  } catch (e) {
    if (e instanceof Unparseable) return { error: e.reason };
    throw e;
  }
}

function parseLocalMoment(s: string): Moment {
  const [d, t] = s.split("T");
  const [y, m, day] = d!.split("-").map(Number);
  const [h, min] = t!.split(":").map(Number);
  return { day: makeDay(y!, m!, day!), minutes: h! * 60 + min! };
}
