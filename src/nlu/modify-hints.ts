// Детерминированные подсказки для изменения события — страховка от того, что маленькая LLM
// не заполнит необязательные поля (ADR-0002, замер 2026-10-04).

export interface ModifyHints {
  reference?: "next" | "last" | "list";
  listIndex?: number;
  newTitle?: string;
  scope?: "this" | "all";
}

// \b в JS не работает с кириллицей — границы слова через Unicode-lookaround
const word = (stem: string) => new RegExp(`(?<!\\p{L})${stem}(?!\\p{L})`, "iu");
const ORDINALS: [RegExp, number][] = [
  [word("перв(ую|ой|ое|ый)"), 1], [word("втор(ую|ой|ое)"), 2], [word("треть(ю|ей|е)"), 3],
  [word("четв[её]рт(ую|ой|ое)"), 4], [word("пят(ую|ой|ое)"), 5],
  [word("first"), 1], [word("second"), 2], [word("third"), 3],
];

export function modifyHints(text: string): ModifyHints {
  const h: ModifyHints = {};
  const t = text.trim();

  // «переименуй завтрашнюю встречу в Ревью дизайна», «назови её Стендап»
  const rename = /(?:переименуй|переименовать|rename)\s+(?:.*?\s)?(?:в|на|to)\s+[«"]?(.+?)[»"]?\s*$/i.exec(t)
    ?? /(?:назови|назвать|call)\s+(?:её|ее|его|эту встречу|it)\s+[«"]?(.+?)[»"]?\s*$/i.exec(t);
  if (rename?.[1]) h.newTitle = rename[1].trim();

  if (/следующ|ближайш|\bnext\b/i.test(t)) h.reference = "next";
  // «её», «последнюю», «эту встречу» — но не «в эту среду»
  else if (/(^|\s)(её|ее)(\s|$)|последн|эт(у|от|о)\s+(встреч|созвон|событи|запис)|\bit\b/i.test(t)) h.reference = "last";
  for (const [re, n] of ORDINALS) {
    if (re.test(t) && !/(понедельник|вторник|сред|четверг|пятниц|суббот|воскресень|недел|числ)/i.test(t.slice(t.search(re)))) {
      h.reference = "list";
      h.listIndex = n;
      break;
    }
  }

  if (word("(все|всю серию|каждую|каждый|каждое|all|every|whole series)").test(t)) h.scope = "all";
  else if (/(только эт|only this|в этот|в эту|в это)/i.test(t)) h.scope = "this";
  return h;
}

/** Глаголы, при которых команда — точно изменение существующего события (LLM путает с созданием). */
export const MODIFY_VERBS = word("(перенеси|перенести|перенесите|передвинь|сдвинь|сдвинуть|переставь|переименуй|переименовать|продли|продлить|укороти|move|reschedule|rename|postpone)");

/** Глаголы удаления. «Отмени последнее» — это отмена действия (US-61), а не удаление. */
export const DELETE_VERBS = word("(удали|удалить|удалите|отмени|отменить|отмените|убери|убрать|delete|remove|cancel)");
export const UNDO_PHRASE = /(отмени|отменить|undo)\s+(последн|действи|это$)|^(отмена|отмени|cancel|undo)[.!]?$/i;
/** Одно слово «отмена» — при открытой карточке отменяет её, иначе отменяет последнее действие. */
export const BARE_CANCEL = /^(отмена|отмени|cancel)[.!]?$/i;
/** «удали все встречи на завтра» — массовое удаление (R1). */
export const MASS_DELETE = word("(все|всё|all)\\s+(встречи|события|дела|events|meetings)");

const QUERY_NOISE = word(
  "(удали|удалить|удалите|отмени|отменить|отмените|убери|убрать|delete|remove|cancel|перенеси|перенести|перенесите|передвинь|сдвинь|сдвинуть|переставь|переименуй|переименовать|продли|продлить|укороти|сделай|измени|поменяй|" +
    "следующую|следующий|следующее|ближайшую|её|ее|его|эту|этот|последнюю|первую|вторую|третью|четвёртую|четвертую|пятую|" +
    "все|всю|серию|только|пожалуйста|move|reschedule|rename|postpone|please|next|it)",
);

/**
 * Описание события из самой фразы: без глагола, дат, указателей и нового названия.
 * «Перенеси созвон с Петей на 16» → «созвон с Петей». Пусто → null (событие указано только временем/контекстом).
 */
export function modifyQuery(text: string, dateFragments: string[], newTitle?: string): string | null {
  let rest = text;
  if (newTitle) rest = rest.replace(new RegExp(`\\s(в|на|to)\\s+[«"]?${escapeRe(newTitle)}[»"]?\\s*$`, "i"), " ");
  rest = rest.replace(/[?!.,«»"]/g, " ");
  // Слова фрагментов дат убираем по одному: фрагмент мог быть склеен из разных мест фразы
  const dateWords = dateFragments.flatMap((f) => f.toLowerCase().split(/\s+/));
  const words = rest.split(/\s+/).filter((w) => {
    if (!w || QUERY_NOISE.test(w) || /^завтрашн|^сегодняшн|^вчерашн/i.test(w)) return false;
    const i = dateWords.indexOf(w.toLowerCase());
    if (i >= 0) {
      dateWords.splice(i, 1);
      return false;
    }
    return true;
  });
  const q = words.join(" ").trim();
  return q || null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
