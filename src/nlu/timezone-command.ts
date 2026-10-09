// US-07 (R2): фразы о часовом поясе и поездках — без LLM, до шага NLU: «Я в Тбилиси [до воскресенья]», «Я переехал в …»,
// «Я вернулся», «Какой у меня часовой пояс?». Город — по словарю городов (любой падеж); незнакомый город — не про пояс.
// Кейсы — testdata/nlu/timezone.yaml.

import { parseDateFragment } from "../dates";
import { ZONE_CITIES } from "../dates/lexicon";
import { parseTimeZone } from "../dates/timezone";

export type TimezoneCommand =
  | { kind: "where" }
  | { kind: "return" }
  | { kind: "move"; tz: string; place: string }
  /** until — слова окончания как сказаны («воскресенья», «15 октября»): день считает бот в поясе поездки. */
  | { kind: "trip"; tz: string; place: string; until?: string };

/** Основа города по формам «по Берлину» / «до Берлина»: «берлин» — и «в Берлине», и «в Берлин»; короче 4 букв — только точно. */
const STEMS = ZONE_CITIES.map((c) => {
  const [a = "", b = ""] = c.forms;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return { tz: c.tz, stem: a.slice(0, i), exact: new Set([...c.forms, c.en.toLowerCase()]) };
});

/** Пояс места: город из словаря, IANA-имя, UTC±N; не знаем — undefined. */
export function placeTimeZone(place: string): string | undefined {
  const known = parseTimeZone(place);
  if (known) return known;
  const p = place.toLowerCase().replace(/ё/g, "е");
  for (const c of STEMS) {
    if (c.exact.has(p)) return c.tz;
    if (c.stem.length >= 4 && p.startsWith(c.stem) && p.length - c.stem.length <= 3 && !/\s/.test(p)) return c.tz;
  }
  return undefined;
}

const PLACE = String.raw`(\S+(?:\s+\S+)?)`;
const UNTIL_RU = String.raw`(?:\s+до\s+(.+))?`;
const UNTIL_EN = String.raw`(?:\s+(?:until|till|through)\s+(.+))?`;

const WHERE = [
  /^(?:какой|который)\s+(?:у\s+меня\s+)?(?:сейчас\s+)?(?:часовой\s+)?пояс(?:\s+у\s+меня)?(?:\s+сейчас)?$/iu,
  /^what(?:'?s|\s+is)\s+my\s+time\s?zone$/iu,
];
const RETURN = [
  /^(?:я|мы)\s+(?:уже\s+|снова\s+)?(?:вернул(?:ся|ась|ись)(?:\s+домой)?|дома|(?:при[её]хал|прилетел)[аи]?\s+домой)$/iu,
  /^(?:i'?m|i\s+am|we'?re|we\s+are)\s+back(?:\s+home)?$/iu,
  /^back\s+home$/iu,
];
const MOVE = [
  new RegExp(String.raw`^(?:я|мы)\s+(?:теперь\s+)?(?:переехал[аи]?|переехали|живу|живём|живем)(?:\s+теперь)?\s+(?:в|во)\s+${PLACE}$`, "iu"),
  new RegExp(String.raw`^(?:i|we)\s+(?:have\s+|'ve\s+)?moved\s+to\s+${PLACE}$`, "iu"),
  new RegExp(String.raw`^(?:i|we)\s+live\s+in\s+${PLACE}\s+now$`, "iu"),
];
const TRIP_RU = [
  new RegExp(String.raw`^(?:я|мы)\s+(?:сейчас\s+|уже\s+|пока\s+)?(?:в|во)\s+${PLACE}${UNTIL_RU}$`, "iu"),
  new RegExp(String.raw`^(?:(?:я|мы)\s+)?(?:прилетел|приехал|прибыл)[аи]?\s+(?:в|во)\s+${PLACE}${UNTIL_RU}$`, "iu"),
];
const TRIP_EN = [
  new RegExp(String.raw`^(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:now\s+)?in\s+${PLACE}${UNTIL_EN}$`, "iu"),
  new RegExp(String.raw`^(?:i|we)\s+(?:landed|arrived)\s+in\s+${PLACE}${UNTIL_EN}$`, "iu"),
];

export function parseTimezoneCommand(text: string): TimezoneCommand | null {
  const s = text
    .trim()
    .replace(/[.!?]+$/u, "")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ");
  if (WHERE.some((re) => re.test(s))) return { kind: "where" };
  if (RETURN.some((re) => re.test(s))) return { kind: "return" };
  for (const re of MOVE) {
    const m = re.exec(s);
    const tz = m && placeTimeZone(m[1]!);
    if (m && tz) return { kind: "move", tz, place: m[1]! };
  }
  for (const re of [...TRIP_RU, ...TRIP_EN]) {
    const m = re.exec(s);
    const tz = m && placeTimeZone(m[1]!);
    if (m && tz) return { kind: "trip", tz, place: m[1]!, ...(m[2] ? { until: m[2].trim() } : {}) };
  }
  return null;
}

/** День окончания поездки («YYYY-MM-DD») по словам после «до»: дата, момент или конец периода; прошлое и не дата — нет. */
export function tripUntil(text: string, now: string, tz: string): string | undefined {
  for (const variant of [text, `до ${text}`]) {
    const r = parseDateFragment({ text: variant, kind: "point", now, tz });
    if ("error" in r) continue;
    const v = "ambiguous" in r ? r.ambiguous[0]! : r;
    if ("date" in v) return typeof v.date === "string" ? v.date : v.date.date;
    if ("datetime" in v) return v.datetime.slice(0, 10);
    if ("interval" in v) return v.interval.start.slice(0, 10);
    if ("range" in v) return v.range.to;
  }
  return undefined;
}
