// Явно названный пояс во фрагменте даты: «в 15:00 по Киеву», «в 12 по UTC+4», «3pm London time», «по местному».
// Грамматика (point.ts) считает время в этом поясе и переводит в пояс пользователя; карточка показывает оба времени.

import { BARE_ZONE_WORDS, LOCAL_ZONE_WORDS, ZONE_CITIES, type ZoneCity } from "./lexicon";
import { parseTimeZone } from "./timezone";
import { type Token, tokenize } from "./tokenize";

export interface NamedZone {
  tz: string;
  ru: string;
  en: string;
}

const CITY_BY_FORM = new Map<string, ZoneCity>(ZONE_CITIES.flatMap((c) => c.forms.map((f) => [f, c] as const)));
const word = (tok: Token | undefined) => (tok?.t === "word" ? tok.w : undefined);

/** bare — пояс можно назвать без «по» / «time» («мск», «UTC+4»). */
function zoneAt(tokens: Token[], i: number): { zone: NamedZone; n: number; bare: boolean } | null {
  const w = word(tokens[i]);
  if (!w) return null;
  const w1 = word(tokens[i + 1]);
  const two = w1 ? CITY_BY_FORM.get(`${w} ${w1}`) : undefined;
  const city = two ?? CITY_BY_FORM.get(w);
  if (city) return { zone: { tz: city.tz, ru: `по ${city.ru}`, en: `${city.en} time` }, n: two ? 2 : 1, bare: BARE_ZONE_WORDS.has(w) };
  // «UTC+4», «GMT-3», «UTC +4», «UTC»
  const glued = /^(utc|gmt)([+-]\d{1,2})?$/.exec(w);
  const sign = glued && !glued[2] && w1 && /^[+-]\d{1,2}$/.test(w1) ? w1 : undefined;
  if (glued) {
    const offset = glued[2] ?? sign ?? "";
    const tz = parseTimeZone(`UTC${offset}`);
    if (!tz) return null;
    const label = `UTC${offset}`;
    return { zone: { tz, ru: `по ${label}`, en: label }, n: sign ? 2 : 1, bare: true };
  }
  if (w.includes("/")) {
    const tz = parseTimeZone(w);
    return tz ? { zone: { tz, ru: `по ${tz}`, en: tz }, n: 1, bare: false } : null;
  }
  return null;
}

/** «по Киеву», «по киевскому времени», «по времени Киева», «Kyiv time», «мск», «UTC+4»; "local" — «по местному (времени)», «local time». */
export function readZone(tokens: Token[], i: number): { zone: NamedZone | "local"; n: number } | null {
  const w = word(tokens[i]);
  if (w === "по") {
    let k = i + 1;
    const genitive = word(tokens[k]) === "времени";
    if (genitive) k++;
    const z = LOCAL_ZONE_WORDS.has(word(tokens[k]) ?? "") ? { zone: "local" as const, n: 1 } : zoneAt(tokens, k);
    if (!z) return null;
    k += z.n;
    if (!genitive && word(tokens[k]) === "времени") k++;
    return { zone: z.zone, n: k - i };
  }
  const z = w && LOCAL_ZONE_WORDS.has(w) ? { zone: "local" as const, n: 1, bare: false } : zoneAt(tokens, i);
  if (!z) return null;
  if (word(tokens[i + z.n]) === "time") return { zone: z.zone, n: z.n + 1 };
  return z.bare ? { zone: z.zone, n: z.n } : null;
}

/** «по местному» — тоже undefined. */
export function namedZone(fragment: string): NamedZone | undefined {
  const tokens = tokenize(fragment);
  for (let i = 0; i < tokens.length; i++) {
    const z = readZone(tokens, i);
    if (z && z.zone !== "local") return z.zone;
  }
  return undefined;
}

/** Одинаковые пояса под разными IANA-именами: модель пишет новое имя, словарь — старое. */
const TZ_ALIASES: Record<string, string> = { "Europe/Kyiv": "Europe/Kiev" };

export function zoneByTz(tz: string): NamedZone {
  const city = ZONE_CITIES.find((c) => c.tz === (TZ_ALIASES[tz] ?? tz));
  if (city) return { tz, ru: `по ${city.ru}`, en: `${city.en} time` };
  // В Etc/GMT знак обратный: Etc/GMT-4 = UTC+4
  const etc = /^Etc\/GMT([+-])(\d{1,2})$/.exec(tz);
  const label = etc ? `UTC${etc[1] === "-" ? "+" : "-"}${etc[2]}` : tz;
  return { tz, ru: `по ${label}`, en: label };
}
