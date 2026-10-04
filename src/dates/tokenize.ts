// Нормализация фрагмента и разбиение на токены. Числительные словами здесь же превращаются в числа.

import { MERIDIEM_WORDS, NUMBER_WORDS, TENS, type Meridiem, type NumberForm } from "./lexicon";

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

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/ноль-ноль/g, " 00 ")
    .replace(/[–—]/g, "-")
    .replace(/[,;!?«»"()]/g, " ")
    .replace(/\.(\s|$)/g, " ")
    .trim();
}

/** Слова, начинающиеся на «пол», которые сами по себе что-то значат и не делятся. */
const POL_WORDS = new Set(["полдень", "полночь", "полчаса", "полтора", "полторы", "половине", "пол"]);

function classify(raw: string): Token[] {
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
  if ((m = /^(\d{1,2})(am|pm)$/.exec(raw))) return [{ t: "num", v: +m[1]!, form: "digit" }, { t: "mer", v: m[2] as Meridiem }];
  if ((m = /^(\d{1,2})-?(го|е|ое|ого|st|nd|rd|th)$/.exec(raw))) return [{ t: "dayord", v: +m[1]! }];
  if (/^\d+$/.test(raw)) return [{ t: "num", v: +raw, form: "digit" }];

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

/** «двадцать третьего» → 23 (ordGen), «двадцать пять» → 25 (card). */
function combineNumbers(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const tok of tokens) {
    const prev = out[out.length - 1];
    if (
      tok.t === "num" && prev?.t === "num" && prev.form === "card" && TENS.has(prev.v) &&
      tok.v >= 1 && tok.v <= 9 && (tok.form === "card" || tok.form === "ordGen" || tok.form === "gen")
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
