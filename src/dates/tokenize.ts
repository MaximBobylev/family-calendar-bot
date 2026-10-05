// Нормализация фрагмента и разбиение на токены. Числительные словами здесь же превращаются в числа.

import { MERIDIEM_WORDS, NUMBER_WORDS, TENS, TYPOS, type Meridiem, type NumberForm } from "./lexicon";

export type Token =
  | { t: "word"; w: string }
  /** Число; `form` — для числительных словами, у цифр — "digit". */
  | { t: "num"; v: number; form: NumberForm | "digit" }
  /** «15:30», «9:30am». */
  | { t: "clock"; h: number; m: number }
  /** «14.10», «15.30», «5.11.26», «14/10» — дата или время решает грамматика по контексту. */
  | { t: "dm"; a: number; b: number; y?: number }
  /** «2026-11-05». */
  | { t: "iso"; y: number; m: number; d: number }
  /** «23-го», «14-е», «1st». */
  | { t: "dayord"; v: number }
  | { t: "mer"; v: Meridiem };

/** Латинские буквы, похожие на кириллические: «cреду» с латинской «c». */
const LOOKALIKES: Record<string, string> = { a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", k: "к", m: "м", t: "т", h: "н", b: "в" };

/** В слове, где есть кириллица, латинские двойники заменяются кириллицей. Чисто латинские слова не трогаем. */
function fixLookalikes(w: string): string {
  return /[а-я]/.test(w) && /[a-z]/.test(w) ? w.replace(/[acepoxykmthb]/g, (ch) => LOOKALIKES[ch]!) : w;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/ноль-ноль/g, " 00 ")
    .replace(/[–—]/g, "-")
    .replace(/[,;!?«»"()…]/g, " ")
    .replace(/\.+(\s|$)/g, " ")
    // «пол-третьего» = «полтретьего»
    .replace(/(^|\s)пол-(?=[а-я])/g, "$1пол")
    .replace(/\S+/g, fixLookalikes)
    .trim();
}

/** Порядок важен: «послезавтрашн» раньше «завтрашн». */
const DAY_ADJECTIVES: [string, string][] = [
  ["послезавтрашн", "послезавтра"], ["позавчерашн", "позавчера"], ["сегодняшн", "сегодня"], ["завтрашн", "завтра"], ["вчерашн", "вчера"],
  ["today's", "today"], ["tomorrow's", "tomorrow"], ["yesterday's", "yesterday"], ["tonight's", "tonight"],
  // «на субботний вечер», «пятничная встреча»; «средний» — не среда, поэтому среды нет
  ["понедельничн", "понедельник"], ["вторничн", "вторник"], ["пятничн", "пятница"], ["субботн", "суббота"], ["воскресн", "воскресенье"],
];

/** Слова, начинающиеся на «пол», которые сами по себе что-то значат и не делятся. */
const POL_WORDS = new Set(["полдень", "полночь", "полчаса", "полтора", "полторы", "половине", "пол"]);

function classify(word: string): Token[] {
  const raw = TYPOS.get(word) ?? word;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw))) return [{ t: "iso", y: +m[1]!, m: +m[2]!, d: +m[3]! }];
  if ((m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/.exec(raw))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined;
    return [{ t: "dm", a: +m[1]!, b: +m[2]!, ...(y ? { y } : {}) }];
  }
  if ((m = /^(\d{1,2}):(\d{2})(am|pm)?$/.exec(raw))) {
    const out: Token[] = [{ t: "clock", h: +m[1]!, m: +m[2]! }];
    if (m[3]) out.push({ t: "mer", v: m[3] as Meridiem });
    return out;
  }
  // «9.30pm»
  if ((m = /^(\d{1,2})\.(\d{2})(am|pm)$/.exec(raw))) return [{ t: "clock", h: +m[1]!, m: +m[2]! }, { t: "mer", v: m[3] as Meridiem }];
  if ((m = /^(\d{1,2})(am|pm)$/.exec(raw))) return [{ t: "num", v: +m[1]!, form: "digit" }, { t: "mer", v: m[2] as Meridiem }];
  if ((m = /^(\d{1,2})-?(го|е|ое|ого|st|nd|rd|th)$/.exec(raw))) return [{ t: "dayord", v: +m[1]! }];
  // «15-30», «10-00» — время (так пишет Whisper); «10-12» — «с 10 до 12». «9-15» — тоже интервал: не гадаем
  if ((m = /^(\d{1,2})-(\d{2})$/.exec(raw))) {
    const a = +m[1]!;
    const b = +m[2]!;
    if (m[2]!.startsWith("0") || b > 24) return [{ t: "clock", h: a, m: b }];
    return [{ t: "num", v: a, form: "digit" }, { t: "word", w: "-" }, { t: "num", v: b, form: "digit" }];
  }
  // «в 15ч», «at 3ish» (приблизительное время = точное)
  if ((m = /^(\d{1,2})ч$/.exec(raw))) return [{ t: "num", v: +m[1]!, form: "digit" }, { t: "word", w: "ч" }];
  if ((m = /^(\d{1,2})ish$/.exec(raw))) return [{ t: "num", v: +m[1]!, form: "digit" }];
  if (/^\d+$/.test(raw)) return [{ t: "num", v: +raw, form: "digit" }];

  // «сегодняшний день», «на завтрашнюю», «послезавтрашние встречи» — прилагательное = само наречие
  const adj = DAY_ADJECTIVES.find(([prefix]) => raw.startsWith(prefix));
  if (adj) return [{ t: "word", w: adj[1] }];

  const mer = MERIDIEM_WORDS.get(raw);
  if (mer) return [{ t: "mer", v: mer }];
  const num = NUMBER_WORDS.get(raw);
  if (num) return [{ t: "num", v: num.v, form: num.form }];

  // «полтретьего» → «пол» + 3 (родительный порядковый)
  if (raw.startsWith("пол") && !POL_WORDS.has(raw)) {
    const rest = NUMBER_WORDS.get(raw.slice(3));
    if (rest?.form === "ordGen") return [{ t: "word", w: "пол" }, { t: "num", v: rest.v, form: "ordGen" }];
  }
  return [{ t: "word", w: raw }];
}

/** «двадцать третьего» → 23 (ordGen), «двадцать пять» → 25 (card), «двадцати пяти» → 25 (gen), «двадцать пятое» → 25 (ordNom). */
function combineNumbers(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const tok of tokens) {
    const prev = out[out.length - 1];
    if (
      tok.t === "num" && prev?.t === "num" && TENS.has(prev.v) && tok.v >= 1 && tok.v <= 9 &&
      ((prev.form === "card" && (tok.form === "card" || tok.form === "ordGen" || tok.form === "gen" || tok.form === "ordNom")) ||
        (prev.form === "gen" && tok.form === "gen"))
    ) {
      out[out.length - 1] = { t: "num", v: prev.v + tok.v, form: tok.form };
      continue;
    }
    out.push(tok);
  }
  return out;
}

export function tokenize(text: string): Token[] {
  const raws = normalize(text).split(/\s+/).filter(Boolean);
  return combineNumbers(raws.flatMap(classify));
}
