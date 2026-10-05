// Повторения (US-32): ближайшие даты по нашему правилу (Recurrence), RRULE для Google, описание словами.
// Правило задаёт парсер (kind=recurrence) — здесь только детерминированная арифметика.

import { daysInMonth, formatDate, localToUtc, makeDay, parts, startOfWeek, weekday, type Day, type Moment } from "./calendar";
import { WEEKDAY_INDEX } from "./lexicon";
import type { Recurrence, Weekday } from "./types";

const HORIZON_DAYS = 3 * 366;
const ALL_WEEKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

function untilDay(r: Recurrence): Day | undefined {
  if (!r.until) return undefined;
  const [y, m, d] = r.until.split("-").map(Number);
  return makeDay(y!, m!, d!);
}

/** n-й (pos ≥ 1) или последний (pos = -1) день недели wd в месяце дня `day`. */
function nthWeekdayOfMonth(day: Day, wd: Weekday, pos: number): Day | null {
  const { year, month } = parts(day);
  const matching: Day[] = [];
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const x = makeDay(year, month, d);
    if (weekday(x) === WEEKDAY_INDEX[wd]) matching.push(x);
  }
  return (pos > 0 ? matching[pos - 1] : matching[matching.length + pos]) ?? null;
}

/** Подходит ли день правилу, без учёта интервала (интервал считается от первой даты). */
function matchesPattern(r: Recurrence, day: Day, anchor?: Day): boolean {
  const p = parts(day);
  switch (r.freq) {
    case "daily":
      return true;
    case "weekly": {
      const days = r.by_day ?? (anchor !== undefined ? [ALL_WEEKDAYS[weekday(anchor)]!] : ALL_WEEKDAYS);
      return days.some((d) => WEEKDAY_INDEX[d] === weekday(day));
    }
    case "monthly":
      if (r.by_set_pos !== undefined && r.by_day?.length) return r.by_day.some((wd) => nthWeekdayOfMonth(day, wd, r.by_set_pos!) === day);
      if (r.by_month_day === -1) return p.date === daysInMonth(p.year, p.month);
      if (r.by_month_day !== undefined) return p.date === r.by_month_day;
      return anchor === undefined || p.date === parts(anchor).date;
    case "yearly": {
      const a = anchor !== undefined ? parts(anchor) : undefined;
      return p.month === (r.by_month ?? a?.month ?? p.month) && p.date === (r.by_month_day ?? a?.date ?? p.date);
    }
  }
}

function intervalOk(r: Recurrence, day: Day, anchor: Day): boolean {
  const n = r.interval ?? 1;
  if (n === 1) return true;
  switch (r.freq) {
    case "daily": return (day - anchor) % n === 0;
    case "weekly": return ((startOfWeek(day) - startOfWeek(anchor)) / 7) % n === 0;
    case "monthly": {
      const a = parts(anchor);
      const b = parts(day);
      return ((b.year - a.year) * 12 + (b.month - a.month)) % n === 0;
    }
    case "yearly": return (parts(day).year - parts(anchor).year) % n === 0;
  }
}

/**
 * Даты повторений начиная с `from` (включительно). Первая подходящая дата — «якорь» интервала,
 * как DTSTART у RRULE. `limit` — сколько вернуть.
 */
export function occurrences(r: Recurrence, from: Day, limit: number): Day[] {
  const until = untilDay(r);
  let anchor: Day | undefined;
  const out: Day[] = [];
  for (let day = from; day < from + HORIZON_DAYS && out.length < limit; day++) {
    if (until !== undefined && day > until) break;
    if (!matchesPattern(r, day, anchor)) continue;
    if (anchor === undefined) anchor = day;
    if (!intervalOk(r, day, anchor)) continue;
    out.push(day);
    if (r.count !== undefined && out.length >= r.count) break;
  }
  return out;
}

const RRULE_DAY: Record<Weekday, string> = { MO: "MO", TU: "TU", WE: "WE", TH: "TH", FR: "FR", SA: "SA", SU: "SU" };

/**
 * RRULE для Google. `start` — первое вхождение (DTSTART); `allDay` — событие на весь день (UNTIL — дата),
 * иначе UNTIL — конец дня `until` в поясе `tz`, в UTC (требование RFC 5545 при DTSTART с поясом).
 */
export function toRRule(r: Recurrence, start: Moment, tz: string, allDay: boolean): string {
  const parts_: string[] = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval && r.interval > 1) parts_.push(`INTERVAL=${r.interval}`);
  if (r.freq === "weekly") {
    const days = r.by_day ?? [ALL_WEEKDAYS[weekday(start.day)]!];
    parts_.push(`BYDAY=${days.map((d) => RRULE_DAY[d]).join(",")}`);
  }
  if (r.freq === "monthly") {
    if (r.by_set_pos !== undefined && r.by_day?.length) parts_.push(`BYDAY=${r.by_day.map((d) => `${r.by_set_pos}${RRULE_DAY[d]}`).join(",")}`);
    else if (r.by_month_day !== undefined) parts_.push(`BYMONTHDAY=${r.by_month_day}`);
  }
  if (r.freq === "yearly") {
    if (r.by_month) parts_.push(`BYMONTH=${r.by_month}`);
    if (r.by_month_day) parts_.push(`BYMONTHDAY=${r.by_month_day}`);
  }
  const until = untilDay(r);
  if (until !== undefined) {
    if (allDay) parts_.push(`UNTIL=${formatDate(until).replaceAll("-", "")}`);
    else {
      const utc = new Date(localToUtc({ day: until, minutes: 23 * 60 + 59 }, tz)).toISOString();
      parts_.push(`UNTIL=${utc.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`);
    }
  } else if (r.count) parts_.push(`COUNT=${r.count}`);
  return `RRULE:${parts_.join(";")}`;
}

// --- Описание словами --------------------------------------------------------

const RU_DAY_ACC: Record<Weekday, string> = { MO: "понедельник", TU: "вторник", WE: "среду", TH: "четверг", FR: "пятницу", SA: "субботу", SU: "воскресенье" };
const RU_DAY_DAT_PL: Record<Weekday, string> = { MO: "понедельникам", TU: "вторникам", WE: "средам", TH: "четвергам", FR: "пятницам", SA: "субботам", SU: "воскресеньям" };
const RU_EVERY: Record<Weekday, string> = { MO: "Каждый", TU: "Каждый", WE: "Каждую", TH: "Каждый", FR: "Каждую", SA: "Каждую", SU: "Каждое" };
const RU_POS: Record<string, [string, string]> = { "1": ["первый", "первую"], "2": ["второй", "вторую"], "3": ["третий", "третью"], "4": ["четвёртый", "четвёртую"], "-1": ["последний", "последнюю"] };
const RU_MONTH_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const FEMININE = new Set<Weekday>(["WE", "FR", "SA"]);
const EN_DAY: Record<Weekday, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };

const sameSet = (a: Weekday[], b: Weekday[]) => a.length === b.length && a.every((x) => b.includes(x));

/** «Каждый понедельник», «По будням», «Раз в 2 недели по четвергам», «В первый понедельник месяца», «Каждый год 3 марта». */
export function describeRecurrence(r: Recurrence, start: Day, locale: string): string {
  const en = locale === "en";
  const n = r.interval ?? 1;
  let text: string;
  const days = r.by_day ?? [ALL_WEEKDAYS[weekday(start)]!];
  switch (r.freq) {
    case "daily":
      text = en ? (n > 1 ? `Every ${n} days` : "Every day") : n > 1 ? `Раз в ${n} дня` : "Каждый день";
      break;
    case "weekly":
      if (en) text = `${n > 1 ? `Every ${n} weeks on` : "Every"} ${days.map((d) => EN_DAY[d]).join(", ")}`;
      else if (sameSet(days, ["MO", "TU", "WE", "TH", "FR"])) text = n > 1 ? `Раз в ${n} недели по будням` : "По будням";
      else if (sameSet(days, ["SA", "SU"])) text = n > 1 ? `Раз в ${n} недели по выходным` : "По выходным";
      else if (n > 1) text = `Раз в ${n} недели по ${days.map((d) => RU_DAY_DAT_PL[d]).join(" и ")}`;
      else if (days.length === 1) text = `${RU_EVERY[days[0]!]} ${RU_DAY_ACC[days[0]!]}`;
      else text = `По ${days.map((d) => RU_DAY_DAT_PL[d]).join(" и ")}`;
      break;
    case "monthly":
      if (r.by_set_pos !== undefined && r.by_day?.length) {
        const wd = r.by_day[0]!;
        const pos = RU_POS[String(r.by_set_pos)] ?? [`${r.by_set_pos}-й`, `${r.by_set_pos}-ю`];
        text = en ? `Every ${r.by_set_pos === -1 ? "last" : `#${r.by_set_pos}`} ${EN_DAY[wd]} of the month` : `В ${FEMININE.has(wd) ? pos[1] : pos[0]} ${RU_DAY_ACC[wd]} месяца`;
      } else if (r.by_month_day === -1) text = en ? "On the last day of every month" : "В последний день месяца";
      else text = en ? `Every month on day ${r.by_month_day ?? parts(start).date}` : `Каждый месяц ${r.by_month_day ?? parts(start).date}-го`;
      if (n > 1 && !en) text += `, раз в ${n} месяца`;
      break;
    case "yearly": {
      const p = parts(start);
      text = en ? `Every year on ${r.by_month_day ?? p.date}/${r.by_month ?? p.month}` : `Каждый год ${r.by_month_day ?? p.date} ${RU_MONTH_GEN[(r.by_month ?? p.month) - 1]}`;
      break;
    }
  }
  if (r.until) {
    const u = untilDay(r)!;
    const up = parts(u);
    text += en ? ` until ${up.date}/${up.month}/${up.year}` : ` до ${up.date} ${RU_MONTH_GEN[up.month - 1]}${up.year !== parts(start).year ? ` ${up.year}` : ""}`;
  } else if (r.count) text += en ? `, ${r.count} times` : `, ${r.count} раз`;
  return text;
}
