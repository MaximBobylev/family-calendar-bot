// Событие из чужого текста без LLM и без ввода-вывода: дата — наш парсер по предложениям, место и название — эвристики.

import { parseDateFragment } from "../dates";
import { cleanTitle, extractDateSpans } from "../dates/extract";

const MAX_TEXT = 1500;
const MAX_SENTENCE_WORDS = 40;
const QUOTE_LEN = 300;

// Не после сокращений адреса: «ул. Ленина», «каб. 12», «д. 5»
const SENTENCE_END = /\n+|(?<!(?:^|[\s,(])(?:ул|каб|д|пр|г|корп|стр|кв|пер|наб|им|тел|ауд|ст|просп|пл|ш|т|р-н|мкр)\.)(?<=[.!?])\s+(?=\p{Lu}|$)/iu;

// Длинные предложения — кусками: перебор кусков в extract квадратичный
export function sentences(text: string): string[] {
  return text
    .slice(0, MAX_TEXT)
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => {
      const ws = s.split(/\s+/);
      return Array.from({ length: Math.ceil(ws.length / MAX_SENTENCE_WORDS) }, (_, i) =>
        ws.slice(i * MAX_SENTENCE_WORDS, (i + 1) * MAX_SENTENCE_WORDS).join(" "),
      );
    });
}

export interface ForeignDates {
  point?: string;
  duration?: string;
  sentence?: string;
  // Убрать из названия
  fragments: string[];
}

function kindOf(text: string, now: string, tz: string): { k: "date"; days: string[] } | { k: "time"; day: string } | { k: "past" } | null {
  const r = parseDateFragment({ text, kind: "point", now, tz });
  if ("error" in r) return r.error === "in_past" ? { k: "past" } : null;
  const vs = "ambiguous" in r ? r.ambiguous : [r];
  const v = vs[0]!;
  if ("datetime" in v) return { k: "time", day: v.datetime.slice(0, 10) };
  if ("interval" in v) return { k: "time", day: v.interval.start.slice(0, 10) };
  // «на выходных» — кандидаты суббота и воскресенье; остальное (диапазоны и т.п.) — не момент
  const days = vs.flatMap((x) => ("date" in x ? [typeof x.date === "string" ? x.date : x.date.date] : []));
  return days.length ? { k: "date", days } : null;
}

// Строка из одного времени «14:02» — время сообщения в скриншоте чата, а не время события (tech-debt #25)
const CHAT_TIMESTAMP = /^\d{1,2}:\d{2}(\s*(?:[AaPp]\.?[Mm]\.?))?(\s*[✓✔]+)?$/u;

// Часы работы, а не событие (замер картинок, tech-debt #28): «Часы приёма: Пн–Пт 8:00–14:00», «Залы работают с 12.00
// до 19.00», «(понедельник — выходной)», «Open daily 10–6»
const DAY = "(?:пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|mon|tue|wed|thu|fri|sat|sun)";
const OPENING_HOURS = new RegExp(
  `(?<!\\p{L})(?:час[ыа]\\s+(?:работы|при[её]ма)|режим\\s+работы|работа(?:ет|ют|ем)\\s+(?:с|ежедневно|без)|` +
    `ежедневно\\s+с|opening\\s+hours|open\\s+(?:daily|until|from)|hours\\s*:)|(?<!\\p{L})${DAY}\\.?\\s*[–—:-]\\s*(?:${DAY}(?!\\p{L})|выходн)`,
  "iu",
);
const HOURS_GO_ON = new RegExp(`^(?:${DAY}(?!\\p{L})|\\d)`, "iu");

// От признака до запятой, после которой уже не день и не число («…с 10 до 19, ждём в субботу»)
function withoutOpeningHours(s: string): string {
  let t = s;
  for (let m = OPENING_HOURS.exec(t); m; m = OPENING_HOURS.exec(t)) {
    let end = t.length;
    const sep = /[,;]\s*/g;
    sep.lastIndex = m.index + m[0].length;
    for (let x = sep.exec(t); x; x = sep.exec(t)) {
      if (!HOURS_GO_ON.test(t.slice(x.index + x[0].length))) {
        end = x.index + 1;
        break;
      }
    }
    t = `${t.slice(0, m.index)} ${t.slice(end)}`.trim();
  }
  return t;
}

// Вёрстка афиш и записок разносит дату по коротким строкам («ПОНЕДЕЛЬНИК / 4 / октября») — склеиваем их
const LAYOUT_LINE_WORDS = 3;
export function mergeLayoutLines(text: string): string {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(run.join(" "));
    run = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const short = !!line && line.split(/\s+/).length <= LAYOUT_LINE_WORDS && !/[.!?:;]$/.test(line) && !CHAT_TIMESTAMP.test(line);
    if (short) run.push(line);
    else {
      flush();
      out.push(raw);
    }
  }
  flush();
  return out.join("\n");
}

// Первая дата по порядку; «В четверг собрание.» + «Начало в 18:00.» склеиваются;
// «встретимся на выходных?» + «В субботу в 12:30» — второе уточняет первое (тот же день, есть время) и побеждает.
export function foreignDateSpans(text: string, now: string, tz: string): ForeignDates {
  const byLines = datesOf(text, now, tz);
  const merged = mergeLayoutLines(text);
  if (merged === text) return byLines;
  // Склеенная вёрстка — только если даёт больше: время там, где было лишь число/день, или те же слова и ещё
  const byLayout = datesOf(merged, now, tz);
  if (!byLayout.point) return byLines;
  const rank = (d: ForeignDates) => {
    const k = d.point ? kindOf(d.point, now, tz)?.k : undefined;
    return k === "time" ? 2 : k === "date" ? 1 : 0;
  };
  const words = (p: string | undefined) => new Set((p ?? "").toLowerCase().split(/\s+/).filter(Boolean));
  const a = words(byLines.point);
  const b = words(byLayout.point);
  const richer = b.size > a.size && [...a].every((w) => b.has(w));
  return rank(byLayout) > rank(byLines) || (rank(byLayout) === rank(byLines) && richer) ? byLayout : byLines;
}

// Строка «6-20», «16–28» — дни диапазоном, месяц строкой ниже (вёрстка афиш); время так не пишут
const BARE_DAY_SPAN = /^\d{1,2}\s*[–—-]\s*\d{1,2}$/;
// К дате на афише время ищем и через пару строк («(К 60-летию со дня рождения)»)
const MAX_PIECES = 4;

function datesOf(text: string, now: string, tz: string): ForeignDates {
  const found: { point: string; sentence: string }[] = [];
  let duration: string | undefined;
  for (const line of sentences(text)) {
    if (CHAT_TIMESTAMP.test(line) || BARE_DAY_SPAN.test(line)) continue;
    const s = withoutOpeningHours(line);
    if (!s) continue;
    const sp = extractDateSpans(s, now, tz, "point");
    if (sp.duration && !duration) duration = sp.duration;
    if (sp.point) found.push({ point: sp.point, sentence: s });
    if (found.length === MAX_PIECES) break;
  }
  const first = found[0];
  if (!first) return { fragments: duration ? [duration] : [], ...(duration ? { duration } : {}) };
  const out = (point: string, extra: string[] = [], sentence = first.sentence): ForeignDates => ({
    point,
    sentence,
    fragments: [first.point, ...extra, ...(duration ? [duration] : [])],
    ...(duration ? { duration } : {}),
  });
  const second = found[1];
  const k1 = kindOf(first.point, now, tz);
  if (second && k1?.k === "date") {
    // Второй кусок сам по себе — момент в один из дней первого: «на выходных» → «в субботу в 12:30»
    const k2 = kindOf(second.point, now, tz);
    const refines = k2?.k === "time" && k1.days.includes(k2.day);
    // Только дата в первом куске, время — в одном из следующих (обычно во втором; на афише — и ниже)
    for (const next of found.slice(1)) {
      if (refines && next === second) break;
      const joined = `${first.point} ${next.point}`;
      const k = kindOf(joined, now, tz);
      if (k?.k === "time" || k?.k === "past") return out(joined, [next.point]);
    }
    if (refines) return out(second.point, [second.point], second.sentence);
  }
  return out(first.point);
}

const PLACE_START =
  /^(ул\.|улица|пр\.|пр-т|просп|пер\.|переулок|наб\.|б-р|бульвар|ш\.|шоссе|пл\.|площадь|д\.\s*\d|дом\s+\d|каб\.|кабинет|ауд\.|аудитория|офис|корп\.|корпус|школа|гимназия|лицей|детский сад|д\/с|зал\s|актовый зал|спортзал|этаж|ТЦ|ТРЦ|кафе|ресторан|клиника|поликлиника|st\.|street|room|office|floor)/iu;
const EXPLICIT_PLACE = /(?:^|\n|[.!]\s)(?:адрес|место|где|address|place|venue)\s*:\s*([^\n]+)/iu;

export function guessPlace(text: string): string | undefined {
  const explicit = EXPLICIT_PLACE.exec(text)?.[1]
    ?.trim()
    .replace(/[.;]+$/, "");
  if (explicit) return explicit.slice(0, 200);
  for (const line of text.slice(0, MAX_TEXT).split("\n")) {
    const parts = line.split(/[,;]/).map((p) => p.trim());
    const start = parts.findIndex((p) => PLACE_START.test(p));
    if (start < 0) continue;
    const place = [parts[start]!];
    for (const p of parts.slice(start + 1)) {
      if (PLACE_START.test(p) || /^(\d|кв\.|стр\.|подъезд|вход)/iu.test(p)) place.push(p);
      else break;
    }
    return place
      .join(", ")
      .replace(/[.!]+$/, "")
      .slice(0, 200);
  }
  return undefined;
}

const LEADS = /^(напоминаем[,:]?\s*(что\s+)?|вы записаны\s+|приглашаем(\s+вас)?(\s+на)?\s+|уважаемые\s+[^,!.]+[,!.]\s*|внимание[!:.]?\s*|reminder:?\s*)/iu;

export function heuristicTitle(sentence: string | undefined, fragments: string[], place: string | undefined): string | undefined {
  if (!sentence) return undefined;
  let s = sentence;
  if (place) for (const p of place.split(", ")) s = s.replace(p, " ");
  s = s.replace(/https?:\/\/\S+/g, " ").replace(LEADS, "");
  const title = cleanTitle(s.replace(/[!?]+/g, " "), fragments)
    ?.replace(/\s+(?=[,;])/g, "")
    .replace(/([\s,;]+|\s+(в|во|на|к|с|at|on|in))+$/iu, "");
  if (!title) return undefined;
  if (title.length <= 60) return title;
  const cut = title.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 60)}…`;
}

export const firstUrl = (text: string) => /https?:\/\/[^\s<>«»"]+/.exec(text)?.[0]?.replace(/[.,;:!?)]+$/, "");

export function sourceDescription(sourceLine: string, quote: string, linkLine?: (url: string) => string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  const short = flat.length > QUOTE_LEN ? `${flat.slice(0, QUOTE_LEN)}…` : flat;
  const url = firstUrl(quote);
  const lines = [`${sourceLine}:`, `«${short}»`];
  if (url && !short.includes(url) && linkLine) lines.push(linkLine(url));
  return lines.join("\n");
}
