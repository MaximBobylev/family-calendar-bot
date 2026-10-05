// Календарная арифметика в «плавающем» локальном времени (wall clock) и перевод между поясами.
// Дата хранится как число дней от эпохи — так сложение дней и сравнение тривиальны.

import type { LocalDate, LocalDateTime } from "./types";

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** Дата как число дней от 1970-01-01. */
export type Day = number;

export interface Moment {
  day: Day;
  /** Минуты от начала дня, 0…1439. */
  minutes: number;
}

export function makeDay(year: number, month: number, date: number): Day {
  return Date.UTC(year, month - 1, date) / DAY_MS;
}

export function parts(day: Day): { year: number; month: number; date: number } {
  const d = new Date(day * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, date: d.getUTCDate() };
}

/** 0 = понедельник … 6 = воскресенье. */
export function weekday(day: Day): number {
  return (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidDate(year: number, month: number, date: number): boolean {
  return month >= 1 && month <= 12 && date >= 1 && date <= daysInMonth(year, month);
}

export function addMonths(day: Day, months: number): Day {
  const { year, month, date } = parts(day);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return makeDay(y, m, Math.min(date, daysInMonth(y, m)));
}

export function startOfWeek(day: Day): Day {
  return day - weekday(day);
}

export function formatDate(day: Day): LocalDate {
  const { year, month, date } = parts(day);
  return `${year}-${pad(month)}-${pad(date)}`;
}

export function formatMoment(m: Moment): LocalDateTime {
  const norm = normalize(m);
  return `${formatDate(norm.day)}T${pad(Math.floor(norm.minutes / 60))}:${pad(norm.minutes % 60)}`;
}

export function normalize(m: Moment): Moment {
  const extraDays = Math.floor(m.minutes / 1440);
  return { day: m.day + extraDays, minutes: m.minutes - extraDays * 1440 };
}

export function compare(a: Moment, b: Moment): number {
  const x = normalize(a);
  const y = normalize(b);
  return x.day - y.day || x.minutes - y.minutes;
}

export function parseLocal(local: LocalDateTime): Moment {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`bad local datetime: ${local}`);
  return { day: makeDay(+m[1]!, +m[2]!, +m[3]!), minutes: +m[4]! * 60 + +m[5]! };
}

// --- Часовые пояса ---------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Локальное время в поясе `tz` для момента UTC. */
export function utcToLocal(utcMs: number, tz: string): Moment {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return { day: makeDay(+p.year!, +p.month!, +p.day!), minutes: +p.hour! * 60 + +p.minute! };
}

function wallMs(m: Moment): number {
  const n = normalize(m);
  return n.day * DAY_MS + n.minutes * 60_000;
}

/**
 * Момент UTC для локального времени в поясе `tz`.
 * При неоднозначности (переход на зимнее время) — более раннее из двух.
 */
export function localToUtc(m: Moment, tz: string): number {
  const wall = wallMs(m);
  // Два прохода уточнения смещения достаточно для любых реальных поясов.
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const offset = wallMs(utcToLocal(guess, tz)) - guess;
    guess = wall - offset;
  }
  // Если раньше на час то же локальное время — берём раннее вхождение.
  const earlier = guess - 3_600_000;
  return wallMs(utcToLocal(earlier, tz)) === wall ? earlier : guess;
}

export function convertZone(m: Moment, fromTz: string, toTz: string): Moment {
  return fromTz === toTz ? m : utcToLocal(localToUtc(m, fromTz), toTz);
}

/** Прибавить реальные минуты с учётом переходов времени в поясе `tz`. */
export function addRealMinutes(m: Moment, minutes: number, tz: string): Moment {
  return utcToLocal(localToUtc(m, tz) + minutes * 60_000, tz);
}

/** Момент + минуты (локальное время, без учёта переходов — для этого addRealMinutes). */
export function addMinutes(m: Moment, minutes: number): Moment {
  return normalize({ day: m.day, minutes: m.minutes + minutes });
}

/** Разница a − b в минутах. */
export function minutesBetween(a: Moment, b: Moment): number {
  return (a.day - b.day) * 1440 + (a.minutes - b.minutes);
}
