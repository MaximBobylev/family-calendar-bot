// US-65 / US-66: чистая логика «событие из чужого текста» — дата (наш парсер по предложениям), место, название
// без LLM, описание-источник. Без ввода-вывода (юнит-тесты test/ingest-logic.test.ts); сценарий — ingest.ts.

import { parseDateFragment } from "../dates";
import { cleanTitle, extractDateSpans } from "../dates/extract";

/** Чужой текст бывает длинным: парсер дат — по предложениям, не больше этого. */
const MAX_TEXT = 1500;
const MAX_SENTENCE_WORDS = 40;
const QUOTE_LEN = 300;

/** Конец предложения — но не после сокращений адреса: «ул. Ленина», «каб. 12», «д. 5». */
const SENTENCE_END = /\n+|(?<!(?:^|[\s,(])(?:ул|каб|д|пр|г|корп|стр|кв|пер|наб|им|тел|ауд|ст|просп|пл|ш|т|р-н|мкр)\.)(?<=[.!?])\s+(?=\p{Lu}|$)/iu;

/** Предложения и строки; длинные — кусками по MAX_SENTENCE_WORDS слов (перебор кусков в extract квадратичный). */
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
  /** Фрагмент момента для парсера: «в четверг в 18:00», «14.10 в 9:30». */
  point?: string;
  duration?: string;
  /** Предложение, где нашлась дата, — из него название без LLM. */
  sentence?: string;
  /** Куски дат — убрать из названия. */
  fragments: string[];
}

/** Что даёт кусок: только дни (`date`, с датами-кандидатами), момент со временем (`time`), прошлое или ничего. */
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

/** Строка из одного времени «14:02» — время сообщения в скриншоте чата, а не время события (tech-debt #25). */
const CHAT_TIMESTAMP = /^\d{1,2}:\d{2}(\s*(?:[AaPp]\.?[Mm]\.?))?(\s*[✓✔]+)?$/u;

/**
 * Дата события в чужом тексте: первая по порядку; «В четверг собрание.» + «Начало в 18:00.» склеиваются;
 * «встретимся на выходных?» + «В субботу в 12:30» — второе уточняет первое (тот же день, есть время) и побеждает.
 */
export function foreignDateSpans(text: string, now: string, tz: string): ForeignDates {
  const found: { point: string; sentence: string }[] = [];
  let duration: string | undefined;
  for (const s of sentences(text)) {
    if (CHAT_TIMESTAMP.test(s)) continue;
    const sp = extractDateSpans(s, now, tz, "point");
    if (sp.duration && !duration) duration = sp.duration;
    if (sp.point) found.push({ point: sp.point, sentence: s });
    if (found.length === 2) break;
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
    // Только дата в первом куске, время — во втором
    const joined = `${first.point} ${second.point}`;
    const k = kindOf(joined, now, tz);
    if (k?.k === "time" || k?.k === "past") return out(joined, [second.point]);
    // Второй кусок сам по себе — момент в один из дней первого: «на выходных» → «в субботу в 12:30»
    const k2 = kindOf(second.point, now, tz);
    if (k2?.k === "time" && k1.days.includes(k2.day)) return out(second.point, [second.point], second.sentence);
  }
  return out(first.point);
}

/** Начало куска с местом: улица, кабинет, школа, «адрес: …». */
const PLACE_START =
  /^(ул\.|улица|пр\.|пр-т|просп|пер\.|переулок|наб\.|б-р|бульвар|ш\.|шоссе|пл\.|площадь|д\.\s*\d|дом\s+\d|каб\.|кабинет|ауд\.|аудитория|офис|корп\.|корпус|школа|гимназия|лицей|детский сад|д\/с|зал\s|актовый зал|спортзал|этаж|ТЦ|ТРЦ|кафе|ресторан|клиника|поликлиника|st\.|street|room|office|floor)/iu;
const EXPLICIT_PLACE = /(?:^|\n|[.!]\s)(?:адрес|место|где|address|place|venue)\s*:\s*([^\n]+)/iu;

/** Место из чужого текста без LLM: «Адрес: …» или подряд идущие куски вида «ул. Ленина 5, каб. 12». */
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
    // Продолжение адреса: «ул. Ленина 5, каб. 12», «д. 3, кв. 7»
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

/** Вводные слова объявлений, которые не название. */
const LEADS = /^(напоминаем[,:]?\s*(что\s+)?|вы записаны\s+|приглашаем(\s+вас)?(\s+на)?\s+|уважаемые\s+[^,!.]+[,!.]\s*|внимание[!:.]?\s*|reminder:?\s*)/iu;

/** Название без LLM: предложение с датой без дат, места и вводных слов; до ~60 символов по словам. */
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

/** Описание события: откуда («Из пересланного сообщения от Маши») + цитата до ~300 символов (US-65) + ссылка. */
export function sourceDescription(sourceLine: string, quote: string, linkLine?: (url: string) => string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  const short = flat.length > QUOTE_LEN ? `${flat.slice(0, QUOTE_LEN)}…` : flat;
  const url = firstUrl(quote);
  const lines = [`${sourceLine}:`, `«${short}»`];
  if (url && !short.includes(url) && linkLine) lines.push(linkLine(url));
  return lines.join("\n");
}
