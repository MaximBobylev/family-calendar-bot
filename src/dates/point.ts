// kind=point и kind=range: грамматика (токены → AST) и правила date-rules.md (AST → результат).
// Принцип: любое незнакомое слово → unparseable. Никаких догадок.

import {
  addMonths, addRealMinutes, compare, convertZone, daysInMonth, formatDate, formatMoment, isValidDate,
  makeDay, parts, startOfWeek, weekday, type Day, type Moment,
} from "./calendar";
import { readDuration } from "./duration";
import {
  DAY_PART_BOUNDS, DAY_PART_WORDS, FILLERS, MONTHS, MONTHS_PREPOSITIONAL, UNITS,
  WEEKDAY_INDEX, WEEKDAYS, type Meridiem,
} from "./lexicon";
import type { Token } from "./tokenize";
import type { DayPart, ParseError, ParseResult, ParseValue, Weekday } from "./types";
import { readZone } from "./zone";

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

export type WeekdayMod = "none" | "this" | "next" | "nextWeek" | "plusWeek";

export type DateAst =
  | { k: "rel"; days: number }
  | { k: "relMonths"; months: number }
  | { k: "wd"; wd: Weekday; mod: WeekdayMod }
  | { k: "abs"; abs: AbsAst; wd?: Weekday };

export type Period =
  | { k: "week"; which: "this" | "next" }
  | { k: "weekend"; which: "this" | "next" }
  | { k: "month"; which: "this" | "next" | number }
  | { k: "nextDays"; n: number }
  /** «в начале месяца», «в конце следующей недели», «в середине ноября». */
  | { k: "segment"; unit: "week" | "month"; seg: Segment; which: "auto" | "this" | "next" | number };

export type Segment = "begin" | "middle" | "end";

export interface Ast {
  date?: DateAst;
  time?: TimeAst;
  part?: DayPart;
  relMinutes?: number;
  tz?: string;
  interval?: { start: TimeAst; end: TimeAst };
  dateRange?: { from: AbsAst; to: AbsAst };
  period?: Period;
  week?: "this" | "next";
  /** «на неделе»: для чтения — эта неделя, для события — один день в середине оставшихся будних. */
  vagueWeek?: boolean;
  /** «к пятнице»: дата без времени → 09:00 того же дня. */
  byDate?: boolean;
  /** «в 9-15»: кроме интервала 9–15 — вариант «9:15» (показывается первым). */
  altTime?: TimeAst;
}

class Unparseable extends Error {
  constructor(readonly reason: ParseError = "unparseable") {
    super(reason);
  }
}

const word = (tok: Token | undefined) => (tok?.t === "word" ? tok.w : undefined);
// «часам» — дательный после «к»: «к 6 часам» (решение владельца)
const HOUR_WORDS = new Set(["часов", "часа", "час", "часам", "ч", "o'clock", "oclock"]);

function checkTime(t: TimeAst): TimeAst {
  if (t.h > 24 || t.m > 59 || t.h < 0) throw new Unparseable("invalid_time");
  if (t.h === 24 && t.m === 0) return { h: 0, m: 0, special: "midnight" };
  if (t.h === 24) throw new Unparseable("invalid_time");
  return t;
}

function readMeridiemTail(tokens: Token[], i: number): { mer?: Meridiem; n: number } {
  let n = 0;
  if (HOUR_WORDS.has(word(tokens[i]) ?? "")) n++;
  const tok = tokens[i + n];
  if (tok?.t === "mer") return { mer: tok.v, n: n + 1 };
  return { n };
}

/** `context` — перед этим было «в»/«at»: одиночное число — это время, а не что-то другое. */
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
      // «пятнадцать тридцать», «восемнадцать 00», «в 15 30» — второе число как минуты
      // (цифрами — только после «в» и двузначное: «в 5 15 ноября» сюда не попадает из-за месяца)
      const next = tokens[i + 1];
      const digitMinutes = context && tok.form === "digit" && next?.t === "num" && next.form === "digit" && next.v >= 10 &&
        !MONTHS.has(word(tokens[i + 2]) ?? "") && !UNITS.has(word(tokens[i + 2]) ?? "");
      if (next?.t === "num" && (next.form === "card" || next.form === "digit") && next.v <= 59 && (tok.form === "card" || next.v === 0 || digitMinutes)) {
        m = next.v;
        n++;
      }
      // «в 18 часов 30 минут», «в 7 ч 15 мин утра» — минуты словом после часов (так пишут афиши)
      const mt = tokens[i + n + 1];
      if (m === 0 && HOUR_WORDS.has(word(tokens[i + n]) ?? "") && mt?.t === "num" && (mt.form === "digit" || mt.form === "card") && mt.v <= 59 &&
        UNITS.get(word(tokens[i + n + 2]) ?? "") === "minute") {
        const tail = readMeridiemTail(tokens, i + n + 3);
        return { time: checkTime({ h: tok.v, m: mt.v, ...(tail.mer ? { mer: tail.mer } : {}) }), n: n + 3 + tail.n };
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
  if ((w === "половине" || w === "половину" || w === "пол") && t1?.t === "num" && t1.form === "ordGen" && t1.v <= 12) {
    return { time: { h: t1.v - 1, m: 30 }, n: 2 };
  }
  // «четверть восьмого» = 7:15
  if (w === "четверть" && t1?.t === "num" && t1.form === "ordGen" && t1.v <= 12) {
    return { time: { h: t1.v - 1, m: 15 }, n: 2 };
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
  morning: "am", day: "day", afternoon: "pm", late_afternoon: "pm", evening: "pm", night: "night",
};

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

/** «к двум», «к трём», «к четырём» — дательный, которого нет среди родительных NUMBER_WORDS. */
const BY_DATIVE_HOURS = new Map([["двум", 2], ["трем", 3], ["четырем", 4]]);
const APPROX_WORDS = new Set(["где-то", "примерно", "приблизительно", "approximately", "roughly"]);
const THIS_WORDS = new Set([
  "эту", "этот", "это", "эта", "this", "эти", "этих",
  "ближайшую", "ближайший", "ближайшее", "ближайшая", "ближайшие", "ближайших",
]);
const NEXT_WORDS = new Set([
  "следующую", "следующий", "следующее", "следующая", "следующих", "следующие", "next",
  "будущую", "будущий", "будущее", "будущая", "будущие", "будущих", "след",
]);
const THIS_PREP = new Set(["этой", "этом", "текущей", "текущем", "ближайшей"]);
const NEXT_PREP = new Set(["следующей", "следующем", "будущей", "будущем", "след"]);
/** Часть суток в именительном/винительном: «на вечер», «завтрашнее утро» — только после дня или «на». */
const DAY_PART_NOMINATIVE = new Map<string, DayPart>([["утро", "morning"], ["вечер", "evening"], ["ночь", "night"]]);
const EN_DAY_PARTS = new Set(["morning", "afternoon", "evening"]);

const SEGMENT_WORDS = new Map<string, Segment>([
  ["начале", "begin"], ["середине", "middle"], ["конце", "end"],
  ["beginning", "begin"], ["start", "begin"], ["middle", "middle"], ["end", "end"],
  ["early", "begin"], ["mid", "middle"], ["late", "end"],
]);
const THIS_GEN = new Set(["этого", "этой", "текущего", "текущей", "this"]);
const NEXT_GEN = new Set(["следующего", "следующей", "будущего", "будущей", "след", "next"]);

/** «в первой / во второй половине дня» → утро / день. */
function halfOfDay(tokens: Token[], i: number): { part: DayPart; n: number } | null {
  const tok = tokens[i];
  const w = word(tok);
  const ord = tok?.t === "num" && tok.form === "ordNom" ? tok.v : w === "первой" || w === "первая" ? 1 : w === "вторая" ? 2 : undefined;
  if (ord !== 1 && ord !== 2) return null;
  if (!/^(половине|половину|половина)$/.test(word(tokens[i + 1]) ?? "")) return null;
  const day = tokens[i + 2];
  if (!(day?.t === "mer" && day.v === "day")) return null;
  return { part: ord === 1 ? "morning" : "day", n: 3 };
}

/** Целые сутки в длительности: «ближайшие сутки» = 1 день. */
const wholeDays = (d: { minutes: number; days: number; months: number }) =>
  d.months ? 0 : d.days ? (d.minutes ? 0 : d.days) : d.minutes % 1440 === 0 ? d.minutes / 1440 : 0;

function readAbs(tokens: Token[], i: number): { abs: AbsAst; n: number } | null {
  const tok = tokens[i];
  const of = word(tokens[i + 1]) === "of" && MONTHS.has(word(tokens[i + 2]) ?? "") ? 1 : 0;
  const nextMonth = MONTHS.get(word(tokens[i + 1 + of]) ?? "");
  const yearAfter = (k: number): { y: number; n: number } | undefined => {
    const y = tokens[k];
    if (!(y?.t === "num" && y.form === "digit" && y.v >= 1000)) return undefined;
    return { y: y.v, n: /^(года|год|г)$/.test(word(tokens[k + 1]) ?? "") ? 2 : 1 };
  };
  if (tok?.t === "iso") return { abs: { d: tok.d, m: tok.m, y: tok.y }, n: 1 };
  const ordNomDay = tok?.t === "num" && tok.form === "ordNom" && tok.v > 0;
  if (tok?.t === "dayord" || (tok?.t === "num" && (tok.form === "ordGen" || tok.form === "digit" || ordNomDay) && nextMonth)) {
    if (nextMonth) {
      const y = yearAfter(i + 2 + of);
      return { abs: { d: tok.v, m: nextMonth, ...(y ? { y: y.y } : {}) }, n: 2 + of + (y?.n ?? 0) };
    }
    return { abs: { d: tok.v }, n: 1 };
  }
  if (tok?.t === "num" && tok.form === "ordGen") return { abs: { d: tok.v }, n: 1 };
  const month = MONTHS.get(word(tok) ?? "");
  const dayTok = tokens[i + 1];
  if (month && (dayTok?.t === "num" || dayTok?.t === "dayord")) {
    const y = yearAfter(i + 2);
    return { abs: { d: dayTok.v, m: month, ...(y ? { y: y.y } : {}) }, n: 2 + (y?.n ?? 0) };
  }
  return null;
}

function parseAst(tokens: Token[]): Ast {
  const ast: Ast = {};
  let i = 0;
  let timeContext = false;
  let pendingMod: WeekdayMod = "none";

  const setDate = (d: DateAst) => {
    if (!ast.date) ast.date = d;
    else if (ast.date.k === "wd" && d.k === "abs") ast.date = { k: "abs", abs: d.abs, wd: ast.date.wd };
    else if (ast.date.k === "abs" && d.k === "wd") ast.date = { ...ast.date, wd: d.wd };
    // «через неделю в понедельник» = «в понедельник через неделю»
    else if (ast.date.k === "rel" && ast.date.days === 7 && d.k === "wd" && d.mod === "none") ast.date = { ...d, mod: "plusWeek" };
    else throw new Unparseable();
  };
  const setTime = (t: TimeAst) => {
    if (ast.time) throw new Unparseable();
    ast.time = t;
  };

  while (i < tokens.length) {
    const tok = tokens[i]!;
    const w = word(tok);
    const w1 = word(tokens[i + 1]);
    const prev = word(tokens[i - 1]);
    const ctx = timeContext;
    timeContext = false;

    if (w === "в" || w === "во" || w === "at") { timeContext = true; i++; continue; }
    // «перенеси на 11», «поставь на 15» — «на» перед числом тоже вводит время
    // («на две недели», «на 10 минут» — это длительность/период, не время)
    if (w === "на" && tokens[i + 1]?.t === "num" && !UNITS.has(word(tokens[i + 2]) ?? "") && tokens[i + 2]?.t !== "mer") {
      timeContext = true;
      i++;
      continue;
    }

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

    // «к пятнице» — дата без времени станет 09:00 того дня; «к 18» — этот час по правилам «в 18»; «к вечеру» = «ближе к вечеру».
    // «к обеду», «к концу недели», «by end of day» — сроки (R1): дальше не разберутся
    if (w === "к" || w === "by") {
      ast.byDate = true;
      if (w === "к" && w1 === "вечеру") { ast.part = "late_afternoon"; i += 2; continue; }
      const t = tokens[i + 1];
      if (!readAbs(tokens, i + 1)) {
        // «к шести», «к двум», «к часу» — числительное в дательном (у 5–20 совпадает с родительным)
        const h = BY_DATIVE_HOURS.get(word(t) ?? "") ?? (t?.t === "num" && t.form === "gen" && t.v <= 12 ? t.v : undefined);
        if (h !== undefined) {
          const tail = readMeridiemTail(tokens, i + 2);
          setTime({ h, m: 0, ...(tail.mer ? { mer: tail.mer } : {}) });
          i += 2 + tail.n;
          continue;
        }
        if (t?.t === "clock" || (t?.t === "num" && (t.form === "digit" || t.form === "card"))) timeContext = true;
      }
      i++;
      continue;
    }

    if (w === "ближе" && w1 === "к" && word(tokens[i + 2]) === "вечеру") { ast.part = "late_afternoon"; i += 3; continue; }
    if ((w === "под" && w1 === "вечер") || (w === "late" && w1 === "afternoon")) { ast.part = "late_afternoon"; i += 2; continue; }
    {
      const half = halfOfDay(tokens, i);
      if (half) { ast.part = half.part; i += half.n; continue; }
    }
    if ((tok.t === "num" && tok.form === "ordNom" && tok.v === 1 && w1 === "thing") || (w === "первым" && w1 === "делом")) {
      setTime({ h: 9, m: 0, mer: "am" });
      i += 2;
      continue;
    }

    // «в обед» = 13:00 — только после «в»/«at»: само слово «Обед» обычно название события
    if (ctx && (w === "обед" || w === "lunch" || w === "lunchtime")) { setTime({ h: 13, m: 0 }); i++; continue; }
    if (ctx && w === "час") {
      const tail = readMeridiemTail(tokens, i + 1);
      setTime({ h: 1, m: 0, ...(tail.mer ? { mer: tail.mer } : {}) });
      i += 1 + tail.n;
      continue;
    }
    const t1 = tokens[i + 1];
    if (w === "с" && t1?.t === "mer" && t1.v === "am" && word(tokens[i + 2]) === "пораньше") { setTime({ h: 9, m: 0, mer: "am" }); i += 3; continue; }
    if (w === "с" && t1?.t === "mer" && t1.v === "am") { ast.part = "morning"; i += 2; continue; }

    {
      const zone = readZone(tokens, i);
      if (zone) {
        if (zone.zone !== "local") ast.tz = zone.zone.tz;
        i += zone.n;
        continue;
      }
    }

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
    if (w === "a" || w === "an") {
      const dur = readDuration(tokens, i);
      if (dur && word(tokens[i + dur.n]) === "from" && word(tokens[i + dur.n + 1]) === "today") {
        setDate({ k: "rel", days: dur.d.days });
        i += dur.n + 2;
        continue;
      }
      throw new Unparseable();
    }

    if (w === "полдень" || w === "noon") { setTime({ h: 12, m: 0, special: "noon" }); i++; continue; }
    if (w === "полночь" || w === "midnight") { setTime({ h: 0, m: 0, special: "midnight" }); i++; continue; }

    // «в 10-12» — с 10 до 12; «в 9-15» — ещё и 9:15 (вариант первым); «в 16-15» — 16:15 (решение владельца)
    {
      const b = tokens[i + 2];
      if (
        tok.t === "num" && tok.form === "digit" && w1 === "-" && b?.t === "num" && b.form === "digit" &&
        tok.v <= 24 && b.v <= 24 && !MONTHS.has(word(tokens[i + 3]) ?? "")
      ) {
        const tail = readMeridiemTail(tokens, i + 3);
        const mer = tail.mer ? { mer: tail.mer } : {};
        if (b.v <= tok.v && b.v >= 10) setTime(checkTime({ h: tok.v, m: b.v, ...mer }));
        // «в 9-15 вечера» — часть суток не подходит к концу «15»: только время 21:15
        else if (tail.mer && b.v > 12) {
          if (b.v !== 15) throw new Unparseable();
          setTime({ h: tok.v, m: 15, ...mer });
        } else {
          if (ast.interval) throw new Unparseable();
          ast.interval = { start: { h: tok.v, m: 0 }, end: { h: b.v, m: 0, ...mer } };
          if (b.v === 15) ast.altTime = { h: tok.v, m: 15, ...mer };
        }
        i += 3 + tail.n;
        continue;
      }
    }

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

    const relDay: Record<string, number> = { сегодня: 0, today: 0, завтра: 1, tomorrow: 1, послезавтра: 2, вчера: -1, yesterday: -1, позавчера: -2 };
    if (w && w in relDay) { setDate({ k: "rel", days: relDay[w]! }); i++; continue; }
    if (w === "после" && w1 === "завтра") { setDate({ k: "rel", days: 2 }); i += 2; continue; }
    if (w === "day" && w1 === "after" && word(tokens[i + 2]) === "tomorrow") { setDate({ k: "rel", days: 2 }); i += 3; continue; }

    {
      const seg = w ? SEGMENT_WORDS.get(w) : undefined;
      if (seg) {
        let k = i + 1;
        if (word(tokens[k]) === "of") k++;
        if (word(tokens[k]) === "the") k++;
        let which: "auto" | "this" | "next" | number = "auto";
        if (THIS_GEN.has(word(tokens[k]) ?? "")) { which = "this"; k++; }
        else if (NEXT_GEN.has(word(tokens[k]) ?? "")) { which = "next"; k++; }
        const u = word(tokens[k]) ?? "";
        const month = MONTHS.get(u);
        let unit: "week" | "month";
        if (/^(месяца|month)$/.test(u)) unit = "month";
        else if (/^(недели|week)$/.test(u) && seg !== "middle") unit = "week";
        else if (month && which === "auto") { unit = "month"; which = month; }
        else throw new Unparseable();
        ast.period = { k: "segment", unit, seg, which };
        i = k + 1;
        continue;
      }
    }

    const isThis = w !== undefined && THIS_WORDS.has(w);
    const isNext = w !== undefined && NEXT_WORDS.has(w);
    if ((isThis || isNext) && w1) {
      const which = isNext ? "next" : "this";
      // «на эту неделю», «this week» при создании — как «на неделе» (решение владельца)
      if (/^(неделе|неделю|неделя|week)$/.test(w1)) { ast.week = which; ast.vagueWeek = which === "this"; i += 2; continue; }
      if (/^(выходные|выходных|weekend)$/.test(w1)) { ast.period = { k: "weekend", which }; i += 2; continue; }
      if (/^(месяце|месяц|month)$/.test(w1)) { ast.period = { k: "month", which }; i += 2; continue; }
      if (EN_DAY_PARTS.has(w1) && isThis) { setDate({ k: "rel", days: 0 }); ast.part = DAY_PART_WORDS.get(w1)!; i += 2; continue; }
      if (WEEKDAYS.has(w1)) { pendingMod = which; i++; continue; }
      throw new Unparseable();
    }
    if (w && (THIS_PREP.has(w) || NEXT_PREP.has(w))) {
      const which = THIS_PREP.has(w) ? "this" : "next";
      if (w1 === "неделе") { ast.week = which; ast.vagueWeek = which === "this"; i += 2; continue; }
      if (w1 === "месяце") { ast.period = { k: "month", which }; i += 2; continue; }
    }

    if (w && WEEKDAYS.has(w)) {
      setDate({ k: "wd", wd: WEEKDAYS.get(w)!, mod: pendingMod });
      pendingMod = "none";
      i++;
      continue;
    }

    // Английское «night» — только после дня или «at night»: «Jazz Night», «Movie night» на афише — название
    if (w === "night" && !ast.date && prev !== "at") throw new Unparseable();
    if (w && DAY_PART_WORDS.has(w)) { ast.part = DAY_PART_WORDS.get(w)!; i++; continue; }
    if (w && DAY_PART_NOMINATIVE.has(w) && (ast.date || prev === "на")) { ast.part = DAY_PART_NOMINATIVE.get(w)!; i++; continue; }
    if (w === "после" && (w1 === "обеда" || w1 === "полудня")) { ast.part = "afternoon"; i += 2; continue; }
    if (tok.t === "mer" && !ast.time) {
      const part: Partial<Record<Meridiem, DayPart>> = { am: "morning", day: "day", pm: "evening", night: "night" };
      ast.part = part[tok.v]!;
      i++;
      continue;
    }

    // «на две недели вперёд», «на неделю вперёд» — N дней, включая сегодня
    {
      const dur = readDuration(tokens, i);
      if (dur && wholeDays(dur.d) && /^(вперед|ahead)$/.test(word(tokens[i + dur.n]) ?? "")) {
        ast.period = { k: "nextDays", n: wholeDays(dur.d) };
        i += dur.n + 1;
        continue;
      }
    }
    {
      let k = i;
      if (w === "rest" && w1 === "of") k += 2;
      else if ((w === "until" || w === "till") && /^(end|the)$/.test(w1 ?? "")) {
        k += 1;
        if (word(tokens[k]) === "the") k++;
        if (word(tokens[k]) === "end" && word(tokens[k + 1]) === "of") k += 2;
        else k = i;
      }
      if (k > i) {
        if (word(tokens[k]) === "the") k++;
        const what = word(tokens[k]);
        if (what === "week") { ast.week = "this"; i = k + 1; continue; }
        if (what === "month") { ast.period = { k: "month", which: "this" }; i = k + 1; continue; }
        throw new Unparseable();
      }
    }
    if (w && /^(выходные|выходных|weekend)$/.test(w)) { ast.period = { k: "weekend", which: "this" }; i++; continue; }
    if (w && /^(неделю|неделя|week)$/.test(w)) { ast.week = "this"; i++; continue; }
    if (w === "неделе" && prev === "на") { ast.week = "this"; ast.vagueWeek = true; i++; continue; }
    if (w && MONTHS_PREPOSITIONAL.has(w)) { ast.period = { k: "month", which: MONTHS.get(w)! }; i++; continue; }
    if (w === "до" && w1 === "конца") {
      const what = word(tokens[i + 2]);
      if (what === "недели") { ast.week = "this"; i += 3; continue; }
      if (what === "месяца") { ast.period = { k: "month", which: "this" }; i += 3; continue; }
      throw new Unparseable();
    }
    if (w === "ближайшие" || w === "следующие" || w === "next") {
      const dur = readDuration(tokens, i + 1);
      if (dur && wholeDays(dur.d)) { ast.period = { k: "nextDays", n: wholeDays(dur.d) }; i += 1 + dur.n; continue; }
      throw new Unparseable();
    }

    if (w && FILLERS.has(w)) { i++; continue; }
    if (tok.t === "mer") throw new Unparseable();
    throw new Unparseable();
  }

  if (ast.week && ast.date?.k === "wd") {
    if (ast.week === "next") ast.date.mod = "nextWeek";
    delete ast.week;
    delete ast.vagueWeek;
  }
  return ast;
}

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
        // «в понедельник через неделю», сказанное в понедельник, — через 7 дней, а не через 14
        case "plusWeek": return [(isToday ? today : nearest(date.wd, today)) + 7];
        case "none":
          if (!isToday) return [nearest(date.wd, today)];
          if (!time) return [today, today + 7];
          return compare(at(today + time.dayOffset, time.hour * 60 + minutes), now) > 0 ? [today, today + 7] : [today + 7];
      }
    }
  }
}

/** «на неделе» при создании: середина оставшихся будних [завтра … пятница], из двух средних — более ранний; с пятницы по воскресенье — среда следующей недели. */
export function midWeekDay(today: Day): Day {
  const mon = startOfWeek(today);
  const from = today + 1;
  const to = mon + 4;
  if (from > to) return mon + 7 + 2;
  return from + Math.floor((to - from) / 2);
}

/** Ночь после названного дня: «завтра ночью» = 00–06 послезавтра; без часа или с часом из «ночью». */
const nightAfter = (ast: Ast) => ast.part === "night" && !ast.time?.mer && !ast.time?.special;

/** Час «ночи» 1–5 при названном дне — в ночь после этого дня (00–06 следующей даты). */
const afterNamedDay = (t: TimeAst | undefined, rh: ResolvedHour) => t?.mer === "night" && rh.dayOffset === 0 && rh.hour < 6;

/** Дни ближайших выходных, начиная с сегодня: в субботу — сегодня и завтра, в воскресенье — только сегодня. */
function weekendDays(today: Day): Day[] {
  const wd = weekday(today);
  const sat = wd === 6 ? today - 1 : today + (5 - wd);
  return [sat, sat + 1].filter((d) => d >= today);
}

function anyOf(asts: Ast[], now: Moment, tz: string): ParseResult {
  const results = asts.map((a): ParseResult => {
    try {
      return resolvePoint(a, now, tz);
    } catch (e) {
      if (e instanceof Unparseable) return { error: e.reason };
      throw e;
    }
  });
  const values = results.flatMap((r) => ("error" in r ? [] : "ambiguous" in r ? r.ambiguous : [r]));
  if (values.length === 0) return results.find((r) => "error" in r) ?? { error: "unparseable" };
  return values.length === 1 ? values[0]! : { ambiguous: values };
}

function resolvePoint(input: Ast, now: Moment, tz: string): ParseResult {
  let ast = input;
  if (ast.relMinutes !== undefined) {
    // «через сутки в 10» — целые сутки с названным часом: календарные дни
    if (!ast.date && ast.time && ast.relMinutes > 0 && ast.relMinutes % 1440 === 0) {
      const { relMinutes, ...rest } = ast;
      ast = { ...rest, date: { k: "rel", days: relMinutes / 1440 } };
    } else {
      if (ast.date || ast.time) throw new Unparseable();
      return dt(addRealMinutes(now, ast.relMinutes, tz));
    }
  }

  if (ast.altTime && ast.interval) {
    const { altTime, interval: _interval, ...rest } = ast;
    return anyOf([{ ...rest, time: altTime }, { ...ast, altTime: undefined }], now, tz);
  }

  // Период при создании события — не дата: переспросить. «к следующей неделе» — срок (R1)
  if (ast.period?.k === "segment") throw new Unparseable();
  if (ast.byDate && !ast.date && (ast.period || ast.week)) throw new Unparseable();

  // «в выходные» при создании — варианты: суббота, затем воскресенье (оставшиеся дни ближайших выходных)
  if (ast.period?.k === "weekend" && ast.period.which === "this" && !ast.date) {
    const { period: _period, ...rest } = ast;
    return anyOf(weekendDays(now.day).map((day) => ({ ...rest, date: { k: "rel", days: day - now.day } })), now, tz);
  }

  if (ast.vagueWeek && !ast.date && !ast.period) {
    const { week: _week, vagueWeek: _vague, ...rest } = ast;
    ast = { ...rest, date: { k: "rel", days: midWeekDay(now.day) - now.day } };
  }
  if (ast.byDate && ast.date && !ast.time && !ast.part && !ast.interval) ast = { ...ast, time: { h: 9, m: 0, mer: "am" } };

  if (ast.dateRange) {
    const from = resolveAbsDate(ast.dateRange.from, now.day);
    const to = resolveAbsDate(ast.dateRange.to, now.day);
    if ("error" in from) return from;
    if ("error" in to) return to;
    return { range: { from: formatDate(from.day), to: formatDate(to.day) } };
  }

  if (ast.interval) {
    const startT = ast.interval.start.mer || !ast.interval.end.mer ? ast.interval.start : { ...ast.interval.start, mer: ast.interval.end.mer };
    let s = resolveHour(startT);
    // «завтра с 1 до 3 ночи» — ночь после названного дня, как «завтра в 1 ночи»
    if (ast.date && afterNamedDay(startT, s)) s = { ...s, dayOffset: 1 };
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
    // Без дня интервал, который уже целиком кончился («с 10 до 12» в 23:30), — завтра; идущий сейчас — сегодня
    const shift = !ast.date && compare(best!, now) <= 0 ? 1 : 0;
    return { interval: { start: formatMoment(at(start.day + shift, start.minutes)), end: formatMoment(at(best!.day + shift, best!.minutes)) } };
  }

  if (ast.period || ast.week) return resolveRange(ast, now);

  const time = effectiveTime(ast);
  let rh = time ? resolveHour(time) : undefined;
  const minutes = time?.m ?? 0;
  const night = nightAfter(ast);
  // «завтра ночью в 2» — час после полуночи относится к следующему дню
  if (rh && night && ast.date && rh.hour < 12 && rh.dayOffset === 0) rh = { ...rh, dayOffset: 1 };
  // «завтра в 2 ночи» = «завтра ночью в 2» (решение владельца); без дня — правило часа
  if (rh && ast.date && afterNamedDay(time, rh)) rh = { ...rh, dayOffset: 1 };

  if (!ast.date) {
    if (!rh) {
      // Часть суток уже кончилась («утром» в 23:30) — ближайшая такая же, завтра
      if (ast.part) return dateValue(now.day + (night || now.minutes >= DAY_PART_BOUNDS[ast.part][1] ? 1 : 0), ast.part);
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
    if (!rh) return day < now.day ? "in_past" : dateValue(day + (night ? 1 : 0), ast.part);
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
    // «на следующих выходных» в сб/вс — как «в следующую пятницу» в пятницу: ближайшие выходные после текущих
    const first = wd >= 5 ? sat + 7 : sat;
    return { ambiguous: [wd >= 5 ? rangeOfDays(first, first + 1) : thisWeekend, rangeOfDays(first + 7, first + 8)] };
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
  if (p?.k === "segment") return resolveSegment(p, today);

  const days = ast.date ? resolveDays(ast.date, { day: today, minutes: -1 }, undefined, 0) : [today];
  const toValue = (day: Day): ParseValue => {
    if (!ast.part) return rangeOfDays(day, day);
    const [s, e] = DAY_PART_BOUNDS[ast.part];
    const d = day + (nightAfter(ast) ? 1 : 0);
    return { range: { from: formatMoment(at(d, s)), to: formatMoment(at(d, e)) } };
  };
  return days.length === 1 ? toValue(days[0]!) : { ambiguous: days.map(toValue) };
}

/** Начало / середина / конец: месяц — 1–10 / 11–20 / 21–конец, неделя — пн–ср / чт–вс. */
function segmentDays(unit: "week" | "month", seg: Segment, first: Day): [Day, Day] {
  if (unit === "week") return seg === "begin" ? [first, first + 2] : [first + 3, first + 6];
  const { year, month } = parts(first);
  const [a, b] = seg === "begin" ? [1, 10] : seg === "middle" ? [11, 20] : [21, daysInMonth(year, month)];
  return [makeDay(year, month, a), makeDay(year, month, b)];
}

/** Текущий месяц/неделя — с сегодня до конца части; часть уже прошла — та же часть следующего («этого/этой» — in_past). */
function resolveSegment(p: Extract<Period, { k: "segment" }>, today: Day): ParseValue {
  const t = parts(today);
  const current = (first: Day): ParseValue | null => {
    const [s, e] = segmentDays(p.unit, p.seg, first);
    return e < today ? null : rangeOfDays(Math.max(s, today), e);
  };
  const whole = (first: Day): ParseValue => rangeOfDays(...segmentDays(p.unit, p.seg, first));
  const thisFirst = p.unit === "week" ? startOfWeek(today) : makeDay(t.year, t.month, 1);
  const nextFirst = p.unit === "week" ? thisFirst + 7 : addMonths(thisFirst, 1);
  switch (p.which) {
    case "next": return whole(nextFirst);
    case "auto": return current(thisFirst) ?? whole(nextFirst);
    case "this": {
      const v = current(thisFirst);
      if (!v) throw new Unparseable("in_past");
      return v;
    }
    default:
      if (p.which === t.month) return current(thisFirst) ?? whole(makeDay(t.year + 1, p.which, 1));
      return whole(makeDay(p.which > t.month ? t.year : t.year + 1, p.which, 1));
  }
}

export function parsePointOrRange(tokens: Token[], kind: "point" | "range", now: Moment, tz: string): ParseResult {
  let ast: Ast;
  try {
    ast = parseAst(tokens);
  } catch (e) {
    if (e instanceof Unparseable) return { error: e.reason };
    throw e;
  }
  return resolvePointOrRange(ast, kind, now, tz);
}

/** Отдельно от грамматики: по этим же правилам разрешается структура даты от LLM (structured.ts). */
export function resolvePointOrRange(ast: Ast, kind: "point" | "range", now: Moment, tz: string): ParseResult {
  try {
    // Одни служебные слова («в», «на») — не дата
    if (!ast.date && !ast.time && !ast.part && !ast.period && !ast.week && !ast.interval && !ast.dateRange && ast.relMinutes === undefined) {
      throw new Unparseable();
    }
    // «к следующей неделе», «by the end of the week» — сроки (R1), и для чтения тоже
    if (ast.byDate && !ast.date && (ast.period || ast.week)) throw new Unparseable();
    if (kind === "range" && !ast.time && !ast.interval && ast.relMinutes === undefined) return resolveRange(ast, now);

    if (!ast.tz || ast.tz === tz) return resolvePoint(ast, now, tz);
    // Явно названный пояс: считаем в нём («сегодня» — по его часам) и переводим моменты в пояс пользователя
    const zoneTz = ast.tz;
    const toUser = (s: string) => formatMoment(convertZone(parseLocalMoment(s), zoneTz, tz));
    const convert = (v: ParseValue): ParseValue =>
      "datetime" in v ? { datetime: toUser(v.datetime) } : "interval" in v ? { interval: { start: toUser(v.interval.start), end: toUser(v.interval.end) } } : v;
    const res = resolvePoint(ast, convertZone(now, tz, zoneTz), zoneTz);
    if ("ambiguous" in res) return { ambiguous: res.ambiguous.map(convert) };
    return "error" in res ? res : convert(res);
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

export function fragmentParts(tokens: Token[]): { hasDate: boolean; hasTime: boolean; relative: boolean } | null {
  try {
    const ast = parseAst(tokens);
    return {
      hasDate: !!(ast.date || ast.dateRange || ast.period || ast.week || ast.vagueWeek),
      hasTime: !!(ast.time || ast.interval || ast.relMinutes !== undefined),
      relative: ast.relMinutes !== undefined,
    };
  } catch {
    return null;
  }
}
