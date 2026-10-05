// Длительности: «полтора часа», «на 45 минут», «часа на три», «2 дня», «неделю».
// Используются в kind=shift / kind=duration и внутри «через …» в kind=point.

import { UNITS, type Unit } from "./lexicon";
import type { ParseResult } from "./types";
import type { Token } from "./tokenize";

export interface Duration {
  /** Реальные минуты (минуты и часы). */
  minutes: number;
  /** Календарные дни (дни и недели). */
  days: number;
  months: number;
}

const ZERO: Duration = { minutes: 0, days: 0, months: 0 };

function fromUnit(unit: Unit, amount: number): Duration | null {
  switch (unit) {
    case "minute": return { ...ZERO, minutes: amount };
    case "hour": return { ...ZERO, minutes: amount * 60 };
    case "day": return Number.isInteger(amount) ? { ...ZERO, days: amount } : null;
    case "week": return Number.isInteger(amount) ? { ...ZERO, days: amount * 7 } : null;
    case "month": return Number.isInteger(amount) ? { ...ZERO, months: amount } : null;
    case "year": return Number.isInteger(amount) ? { ...ZERO, months: amount * 12 } : null;
  }
}

const word = (tok: Token | undefined) => (tok?.t === "word" ? tok.w : undefined);
const unitOf = (tok: Token | undefined): Unit | undefined => {
  // «дня» токенизатор считает частью суток («в 2 дня»), но после числа это единица
  if (tok?.t === "mer" && tok.v === "day") return "day";
  const w = word(tok);
  return w ? UNITS.get(w) : undefined;
};
const numOf = (tok: Token | undefined) => (tok?.t === "num" && tok.form !== "ordGen" && tok.form !== "ordNom" ? tok.v : undefined);

/** Пытается прочитать длительность с позиции `i`. Возвращает её и число съеденных токенов. */
export function readDuration(tokens: Token[], i: number): { d: Duration; n: number } | null {
  const w = word(tokens[i]);

  if (w === "полчаса") return { d: { ...ZERO, minutes: 30 }, n: 1 };
  if (w === "полтора" || w === "полторы") {
    const u = unitOf(tokens[i + 1]);
    const d = u && fromUnit(u, 1.5);
    return d ? { d, n: 2 } : null;
  }

  // «часа на три» — единица, затем «на» и число
  const u0 = unitOf(tokens[i]);
  if (u0 && word(tokens[i + 1]) === "на" && numOf(tokens[i + 2]) !== undefined) {
    const d = fromUnit(u0, numOf(tokens[i + 2])!);
    return d ? { d, n: 3 } : null;
  }

  // «45 минут», «два часа», «a week», «one hour»
  const amount = numOf(tokens[i]) ?? (w === "a" || w === "an" ? 1 : undefined);
  if (amount !== undefined) {
    const u = unitOf(tokens[i + 1]);
    if (!u) return null;
    const d = fromUnit(u, amount);
    return d ? { d, n: 2 } : null;
  }

  // «час», «день», «неделю» — одна единица
  if (u0) {
    const d = fromUnit(u0, 1);
    return d ? { d, n: 1 } : null;
  }
  return null;
}

export function toIso(d: Duration, sign = ""): string {
  if (d.months) return `${sign}P${d.months}M`;
  if (d.days) return `${sign}P${d.days}D`;
  const h = Math.floor(d.minutes / 60);
  const m = d.minutes % 60;
  return `${sign}PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}`;
}

const LATER = new Set(["позже", "later", "вперед", "forward", "after"]);
const EARLIER = new Set(["раньше", "earlier", "назад", "back", "before"]);

/** kind=shift: «на час позже», «на два дня раньше», «на неделю вперёд». Без направления — позже. */
export function parseShift(tokens: Token[]): ParseResult {
  let i = 0;
  if (word(tokens[i]) === "на") i++;
  const dur = readDuration(tokens, i);
  if (!dur) return { error: "unparseable" };
  i += dur.n;
  let sign = "+";
  const dir = word(tokens[i]);
  if (dir && LATER.has(dir)) i++;
  else if (dir && EARLIER.has(dir)) {
    sign = "-";
    i++;
  }
  if (i !== tokens.length) return { error: "unparseable" };
  return { shift: toIso(dur.d, sign) };
}

/** kind=duration: «на полчаса», «часа на три», «на весь день», «for 30 minutes». */
export function parseDuration(tokens: Token[]): ParseResult {
  const words = tokens.map((t) => word(t) ?? "?").join(" ");
  if (/^(на )?весь день$|^all day$/.test(words)) return { duration: "all_day" };
  let i = 0;
  if (word(tokens[i]) === "на" || word(tokens[i]) === "for") i++;
  const dur = readDuration(tokens, i);
  if (!dur || i + dur.n !== tokens.length) return { error: "unparseable" };
  return { duration: toIso(dur.d) };
}

/**
 * ISO-длительность или сдвиг («PT1H30M», «+P1D», «-PT30M») → минуты со знаком.
 * Месяцы и годы в минуты не переводятся — null (вызывающий код должен сказать «не понял»).
 */
export function durationToMinutes(iso: string): number | null {
  const sign = iso.startsWith("-") ? -1 : 1;
  const body = iso.replace(/^[+-]/, "");
  const d = /^P(\d+)D$/.exec(body);
  if (d) return sign * Number(d[1]) * 1440;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(body);
  if (!m || (!m[1] && !m[2])) return null;
  return sign * (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0));
}
