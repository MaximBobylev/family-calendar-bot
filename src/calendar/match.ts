// Сопоставление описания события («встречу с Петей», «планёрку») с названиями — с учётом падежей.
// Без морфологического словаря: совпадение по общему префиксу, достаточному для русских окончаний.

const STOP_WORDS = new Set([
  "встреча", "встречу", "встречи", "встрече", "событие", "события", "мероприятие", "запись",
  "с", "со", "по", "в", "во", "на", "у", "к", "и", "или", "о", "об", "про", "для",
  "мою", "мой", "моё", "мое", "мои", "эту", "этот", "это", "эта", "ту", "тот", "то",
  "the", "a", "an", "my", "with", "meeting", "event", "my",
]);

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll("ё", "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** Значимые слова описания (без «встречу», предлогов и местоимений). */
export function queryWords(query: string): string[] {
  return normalizeWords(query).filter((w) => !STOP_WORDS.has(w));
}

/** Одно слово — разные формы: «петей» ~ «петя», «планерку» ~ «планерка», «созвона» ~ «созвон». */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return common >= Math.max(3, Math.min(a.length, b.length) - 2);
}

/** Доля значимых слов описания, найденных в названии: 0…1. Пустое описание — 0. */
export function titleScore(query: string, title: string): number {
  const q = queryWords(query);
  if (q.length === 0) return 0;
  const t = normalizeWords(title);
  return q.filter((w) => t.some((tw) => sameWord(w, tw))).length / q.length;
}
