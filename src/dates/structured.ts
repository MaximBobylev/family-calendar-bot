// Структура даты от LLM («LLM структурирует, резолвит наш код», ревью парсера дат, шаг 4): строгая проверка и разрешение
// теми же правилами, что и грамматика (resolvePointOrRange, date-rules.md). Модель только «читает» фразу — даты считает код
// (ADR-0005 п.3). Любое неверное поле — структура отбрасывается целиком: лучше переспросить, чем молча ошибиться.

import { addMonths, daysInMonth, makeDay, type Moment, parseLocal, parts, weekday } from "./calendar";
import { type Ast, type DateAst, type Period, resolvePointOrRange, type TimeAst, type WeekdayMod } from "./point";
import type { DayPart, ParseError, ParseResult, ParseValue, Weekday } from "./types";

export const STRUCT_WEEKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const STRUCT_PARTS: readonly DayPart[] = ["morning", "day", "afternoon", "late_afternoon", "evening", "night"];
export const STRUCT_ERRORS = ["unparseable", "unsupported", "empty", "invalid_time"] as const;
export const STRUCT_WHICH = ["none", "this", "next", "next_week", "plus_week"] as const;

export interface StructTime {
  hour: number;
  minute: number;
  meridiem?: "am" | "pm" | "day" | "night";
  special?: "noon" | "midnight";
}

export interface StructAbs {
  day: number;
  month?: number;
  year?: number;
}

/** offset_days — сдвиг в днях от этого дня: «за день до 15 ноября» → -1, «через неделю после 3-го» → 7. */
export type StructDay = (
  | { type: "relative_days"; days: number }
  | { type: "relative_months"; months: number }
  | { type: "weekday"; weekday: Weekday; which?: (typeof STRUCT_WHICH)[number] }
  | { type: "date"; day: number; month?: number; year?: number; weekday?: Weekday }
  /** «первый понедельник ноября», «last Friday of the month»: n 1…5 или -1 (последний); без месяца — этот месяц. */
  | { type: "nth_weekday"; n: number; weekday: Weekday; month?: number }
  /** «в последний день месяца»; «N-й с конца» — last_day + offset_days. */
  | { type: "last_day"; month?: number }
) & { offset_days?: number };

export interface StructPeriod {
  type: "week" | "weekend" | "month" | "next_days" | "segment";
  which?: "this" | "next" | "auto";
  month?: number;
  days?: number;
  unit?: "week" | "month";
  segment?: "begin" | "middle" | "end";
}

/** Одна трактовка фразы. */
export interface DateStructureOne {
  error?: (typeof STRUCT_ERRORS)[number];
  day?: StructDay;
  time?: StructTime;
  part_of_day?: DayPart;
  in_minutes?: number;
  interval?: { start: StructTime; end: StructTime };
  alt_time?: StructTime;
  date_range?: { from: StructAbs; to: StructAbs };
  period?: StructPeriod;
  by?: boolean;
  timezone?: string;
}

/** Структура от модели: трактовка + другие трактовки, если фраза двусмысленна («в среду или в четверг»). */
export interface DateStructure extends DateStructureOne {
  alternatives?: DateStructureOne[];
}

// --- Строгая проверка ------------------------------------------------------

const MAX_ALTERNATIVES = 3;

class Bad extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
/** null от модели — то же, что «поле не задано». */
const present = (o: Obj, k: string) => o[k] !== undefined && o[k] !== null;

function int(o: Obj, k: string, min: number, max: number): number | undefined {
  if (!present(o, k)) return undefined;
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Bad(k);
  return v;
}
function need<T>(v: T | undefined, k: string): T {
  if (v === undefined) throw new Bad(k);
  return v;
}
function oneOf<T extends string>(o: Obj, k: string, values: readonly T[]): T | undefined {
  if (!present(o, k)) return undefined;
  if (!values.includes(o[k] as T)) throw new Bad(k);
  return o[k] as T;
}
/** Незнакомое поле — модель выражает то, чего в схеме нет (сдвиг не там, свой «kind»): отбрасываем, а не теряем смысл молча. */
function strict(o: Obj, allowed: string[], where: string) {
  for (const k of Object.keys(o)) if (present(o, k) && !allowed.includes(k)) throw new Bad(`${where}.${k}`);
}
function obj(o: Obj, k: string): Obj | undefined {
  if (!present(o, k)) return undefined;
  if (!isObj(o[k])) throw new Bad(k);
  return o[k] as Obj;
}
const opt = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : ({ [k]: v } as { [P in K]: V }));

// Числа «как сказаны»: час 25 и минута 75 пропускаем — это invalid_time по правилам, а не мусор модели
function time(o: Obj | undefined, k: string): StructTime | undefined {
  if (!o) return undefined;
  strict(o, ["hour", "minute", "meridiem", "special"], k);
  return {
    hour: need(int(o, "hour", 0, 99), `${k}.hour`),
    minute: int(o, "minute", 0, 99) ?? 0,
    ...opt("meridiem", oneOf(o, "meridiem", ["am", "pm", "day", "night"] as const)),
    ...opt("special", oneOf(o, "special", ["noon", "midnight"] as const)),
  };
}

function abs(o: Obj | undefined, k: string): StructAbs | undefined {
  if (!o) return undefined;
  strict(o, ["day", "month", "year"], k);
  return { day: need(int(o, "day", 1, 31), `${k}.day`), ...opt("month", int(o, "month", 1, 12)), ...opt("year", int(o, "year", 2000, 2100)) };
}

function day(o: Obj | undefined): StructDay | undefined {
  if (!o) return undefined;
  const base = dayBase(o);
  const offset = int(o, "offset_days", -366, 366);
  return offset ? { ...base, offset_days: offset } : base;
}

const DAY_KEYS: Record<string, string[]> = {
  relative_days: ["days"],
  relative_months: ["months"],
  weekday: ["weekday", "which"],
  date: ["day", "month", "year", "weekday"],
  nth_weekday: ["n", "weekday", "month"],
  last_day: ["month"],
};

function dayBase(o: Obj): StructDay {
  // Поле не того вида дня («days» у даты, «month» у дня недели) — модель путает виды: не угадываем
  strict(o, ["type", "offset_days", ...(DAY_KEYS[String(o.type)] ?? [])], "day");
  switch (o.type) {
    case "relative_days":
      return { type: "relative_days", days: need(int(o, "days", -366, 3660), "days") };
    case "relative_months":
      return { type: "relative_months", months: need(int(o, "months", -24, 120), "months") };
    case "weekday":
      return { type: "weekday", weekday: need(oneOf(o, "weekday", STRUCT_WEEKDAYS), "weekday"), ...opt("which", oneOf(o, "which", STRUCT_WHICH)) };
    case "date":
      return {
        type: "date",
        day: need(int(o, "day", 1, 31), "day"),
        ...opt("month", int(o, "month", 1, 12)),
        ...opt("year", int(o, "year", 2000, 2100)),
        ...opt("weekday", oneOf(o, "weekday", STRUCT_WEEKDAYS)),
      };
    case "nth_weekday": {
      const n = need(int(o, "n", -1, 5), "n");
      if (n === 0) throw new Bad("n");
      return { type: "nth_weekday", n, weekday: need(oneOf(o, "weekday", STRUCT_WEEKDAYS), "weekday"), ...opt("month", int(o, "month", 1, 12)) };
    }
    case "last_day":
      return { type: "last_day", ...opt("month", int(o, "month", 1, 12)) };
    default:
      throw new Bad("day.type");
  }
}

function period(o: Obj | undefined): StructPeriod | undefined {
  if (!o) return undefined;
  strict(o, ["type", "which", "month", "days", "unit", "segment"], "period");
  return {
    type: need(oneOf(o, "type", ["week", "weekend", "month", "next_days", "segment"] as const), "period.type"),
    ...opt("which", oneOf(o, "which", ["this", "next", "auto"] as const)),
    ...opt("month", int(o, "month", 1, 12)),
    ...opt("days", int(o, "days", 1, 366)),
    ...opt("unit", oneOf(o, "unit", ["week", "month"] as const)),
    ...opt("segment", oneOf(o, "segment", ["begin", "middle", "end"] as const)),
  };
}

function validZone(z: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

const ONE_KEYS = ["error", "day", "time", "part_of_day", "in_minutes", "interval", "alt_time", "date_range", "period", "by", "timezone"];

function one(o: Obj, top: boolean): DateStructureOne {
  strict(o, top ? [...ONE_KEYS, "alternatives"] : ONE_KEYS, "structure");
  const iv = obj(o, "interval");
  const dr = obj(o, "date_range");
  if (present(o, "by") && typeof o.by !== "boolean") throw new Bad("by");
  const tzName = present(o, "timezone") ? o.timezone : undefined;
  if (tzName !== undefined && (typeof tzName !== "string" || !validZone(tzName))) throw new Bad("timezone");
  const s: DateStructureOne = {
    ...opt("error", oneOf(o, "error", STRUCT_ERRORS)),
    ...opt("day", day(obj(o, "day"))),
    ...opt("time", time(obj(o, "time"), "time")),
    ...opt("part_of_day", oneOf(o, "part_of_day", STRUCT_PARTS)),
    ...opt("in_minutes", int(o, "in_minutes", 1, 527_040)),
    ...(iv ? { interval: { start: need(time(obj(iv, "start"), "start"), "interval.start"), end: need(time(obj(iv, "end"), "end"), "interval.end") } } : {}),
    ...opt("alt_time", time(obj(o, "alt_time"), "alt_time")),
    ...(dr ? { date_range: { from: need(abs(obj(dr, "from"), "from"), "date_range.from"), to: need(abs(obj(dr, "to"), "to"), "date_range.to") } } : {}),
    ...opt("period", period(obj(o, "period"))),
    ...(o.by === true ? { by: true } : {}),
    ...(typeof tzName === "string" && tzName ? { timezone: tzName } : {}),
  };
  return s;
}

const isEmpty = (s: DateStructureOne) => Object.keys(s).length === 0;

/**
 * Ответ модели → структура. undefined — нет структуры или она испорчена (любое неверное поле, неизвестный тип):
 * бесплатные модели пропускают и путают поля — тогда второго мнения просто нет.
 */
export function parseDateStructure(raw: unknown): DateStructure | undefined {
  let v = raw;
  // Часть моделей кладёт объект строкой JSON
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!isObj(v)) return undefined;
  try {
    const main = one(v, true);
    let alternatives: DateStructureOne[] | undefined;
    if (present(v, "alternatives")) {
      if (!Array.isArray(v.alternatives) || v.alternatives.length > MAX_ALTERNATIVES || !v.alternatives.every(isObj)) return undefined;
      alternatives = v.alternatives.map((a) => one(a as Obj, false)).filter((a) => !isEmpty(a));
    }
    if (isEmpty(main) && !alternatives?.length) return undefined;
    return { ...main, ...(alternatives?.length ? { alternatives } : {}) };
  } catch (e) {
    if (e instanceof Bad) return undefined;
    throw e;
  }
}

// --- Разрешение ------------------------------------------------------------

class Invalid extends Error {
  constructor(readonly reason: ParseError) {
    super(reason);
  }
}

function timeAst(t: StructTime): TimeAst {
  if (t.special === "noon") return { h: 12, m: 0, special: "noon" };
  if (t.special === "midnight") return { h: 0, m: 0, special: "midnight" };
  // Как checkTime в point.ts: 24:00 — полночь, иначе вне часов — invalid_time
  if (t.hour > 24 || t.minute > 59 || (t.hour === 24 && t.minute !== 0)) throw new Invalid("invalid_time");
  if (t.hour === 24) return { h: 0, m: 0, special: "midnight" };
  return { h: t.hour, m: t.minute, ...(t.meridiem ? { mer: t.meridiem } : {}) };
}

const absAst = (a: StructAbs) => ({ d: a.day, ...(a.month ? { m: a.month } : {}), ...(a.year ? { y: a.year } : {}) });
const MOD: Record<(typeof STRUCT_WHICH)[number], WeekdayMod> = { none: "none", this: "this", next: "next", next_week: "nextWeek", plus_week: "plusWeek" };

/** n-й день недели месяца (n = -1 — последний); null — такого нет (пятый понедельник). */
function nthWeekdayOf(year: number, month: number, wd: Weekday, n: number): number | null {
  const target = STRUCT_WEEKDAYS.indexOf(wd);
  if (n === -1) {
    const last = makeDay(year, month, daysInMonth(year, month));
    return last - ((weekday(last) - target + 7) % 7);
  }
  const first = makeDay(year, month, 1);
  const d = first + ((target - weekday(first) + 7) % 7) + (n - 1) * 7;
  return parts(d).month === month ? d : null;
}

/** Ближайший месяц (этот или позже, до года вперёд), где день по правилу не раньше сегодня. */
function nearestInMonth(today: number, month: number | undefined, pick: (y: number, m: number) => number | null): number {
  const t = parts(today);
  for (let k = 0; k < 13; k++) {
    const p = parts(addMonths(makeDay(t.year, t.month, 1), k));
    if (month !== undefined && p.month !== month) continue;
    const d = pick(p.year, p.month);
    if (d !== null && d >= today) return d;
  }
  throw new Invalid("invalid_date");
}

const concrete = (d: number): DateAst => {
  const p = parts(d);
  return { k: "abs", abs: { d: p.date, m: p.month, y: p.year } };
};

/** Дни-кандидаты простого дня — правилами грамматики (чтение без времени: «в пятницу» в пятницу — сегодня и +7). */
function baseDays(date: DateAst, now: Moment, tz: string): number[] {
  const r = resolvePointOrRange({ date }, "range", now, tz);
  if ("error" in r) throw new Invalid(r.error);
  const vs = "ambiguous" in r ? r.ambiguous : [r];
  return vs.flatMap((v) => ("range" in v ? [parseLocal(`${v.range.from.slice(0, 10)}T00:00`).day] : []));
}

/** День структуры → варианты DateAst (с n-м днём недели и сдвигом — уже конкретными датами). */
function dateAsts(s: DateStructureOne, now: Moment, tz: string): DateAst[] {
  const d = s.day;
  if (!d) return [];
  let simple: DateAst | undefined;
  let days: number[] | undefined;
  switch (d.type) {
    case "relative_days":
      simple = { k: "rel", days: d.days };
      break;
    case "relative_months":
      simple = { k: "relMonths", months: d.months };
      break;
    case "weekday":
      simple = { k: "wd", wd: d.weekday, mod: MOD[d.which ?? "none"] };
      break;
    case "date":
      simple = { k: "abs", abs: absAst(d), ...(d.weekday ? { wd: d.weekday } : {}) };
      break;
    case "nth_weekday":
      days = [nearestInMonth(now.day, d.month, (y, m) => nthWeekdayOf(y, m, d.weekday, d.n))];
      break;
    case "last_day": {
      // «за 2 дня до конца месяца» — сдвиг от последнего дня; месяц выбираем по итоговой дате, а не по последнему дню
      const shift = d.offset_days ?? 0;
      return [concrete(nearestInMonth(now.day, d.month, (y, m) => makeDay(y, m, daysInMonth(y, m)) + shift))];
    }
  }
  const offset = d.offset_days;
  if (!offset) return simple ? [simple] : days!.map(concrete);
  return (days ?? baseDays(simple!, now, tz)).map((x) => concrete(x + offset));
}

/** Одна трактовка → AST грамматики (несколько — если день дал несколько дат со сдвигом). */
function asts(s: DateStructureOne, kind: "point" | "range", now: Moment, tz: string): Ast[] {
  const ast: Ast = {};
  if (s.time) ast.time = timeAst(s.time);
  if (s.part_of_day) ast.part = s.part_of_day;
  if (s.in_minutes !== undefined) ast.relMinutes = s.in_minutes;
  if (s.interval) ast.interval = { start: timeAst(s.interval.start), end: timeAst(s.interval.end) };
  // «в 9-15»: вариант 9:15 — только при интервале без части суток («в 9-15 вечера» — просто 21:15)
  if (s.alt_time && ast.interval) ast.altTime = timeAst(s.alt_time);
  if (s.date_range) {
    const to = absAst(s.date_range.to);
    const from = absAst(s.date_range.from);
    ast.dateRange = { from: { ...from, m: from.m ?? to.m }, to };
  }
  const p = s.period;
  if (p) {
    let period: Period | undefined;
    switch (p.type) {
      case "week":
        ast.week = p.which === "next" ? "next" : "this";
        // «на неделе» при создании — один день (vagueWeek); для чтения — эта неделя
        if (ast.week === "this" && kind === "point") ast.vagueWeek = true;
        break;
      case "weekend":
        period = { k: "weekend", which: p.which === "next" ? "next" : "this" };
        break;
      case "month":
        period = { k: "month", which: p.month ?? (p.which === "next" ? "next" : "this") };
        break;
      case "next_days":
        period = { k: "nextDays", n: p.days ?? 1 };
        break;
      case "segment":
        period = { k: "segment", unit: p.unit === "week" ? "week" : "month", seg: p.segment ?? "begin", which: p.month ?? p.which ?? "auto" };
        break;
    }
    if (period) ast.period = period;
  }
  if (s.by) ast.byDate = true;
  if (s.timezone) ast.tz = s.timezone;
  const dates = dateAsts(s, now, tz);
  if (dates.length === 0) return [ast];
  return dates.map((date) => {
    const a: Ast = { ...ast, date };
    // День недели + «на следующей неделе» — как в грамматике
    if (a.week && date.k === "wd") {
      if (a.week === "next") a.date = { ...date, mod: "nextWeek" };
      delete a.week;
      delete a.vagueWeek;
    }
    return a;
  });
}

const key = (v: ParseValue) => JSON.stringify(v);

/** Структура → результат по правилам date-rules.md; несколько трактовок — варианты по порядку, без повторов. */
export function resolveDateStructure(s: DateStructure, kind: "point" | "range", now: Moment, tz: string): ParseResult {
  const results: ParseResult[] = [];
  for (const variant of [s, ...(s.alternatives ?? [])]) {
    if (variant.error) {
      results.push({ error: variant.error === "unsupported" ? "unparseable" : variant.error });
      continue;
    }
    try {
      for (const a of asts(variant, kind, now, tz)) results.push(resolvePointOrRange(a, kind, now, tz));
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      results.push({ error: e.reason });
    }
  }
  const values: ParseValue[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    for (const v of "error" in r ? [] : "ambiguous" in r ? r.ambiguous : [r]) {
      if (seen.has(key(v))) continue;
      seen.add(key(v));
      values.push(v);
    }
  }
  if (values.length === 0) return results.find((r) => "error" in r) ?? { error: "unparseable" };
  return values.length === 1 ? values[0]! : { ambiguous: values };
}

/** Есть ли в структуре хоть одна трактовка с днём или временем (не ошибка). */
export const structureHasValue = (s: DateStructure) => [s, ...(s.alternatives ?? [])].some((v) => !v.error);

/** Удобство для тестов и замеров: разбор + разрешение. */
export function resolveRawStructure(raw: unknown, kind: "point" | "range", now: string, tz: string): ParseResult | undefined {
  const s = parseDateStructure(raw);
  return s ? resolveDateStructure(s, kind, parseLocal(now), tz) : undefined;
}
