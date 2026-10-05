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

/** Слова, которые не отличают один календарь от другого: «в общий календарь», «из рабочего календаря». */
const CALENDAR_WORDS = new Set(["в", "во", "из", "на", "к", "для", "in", "to", "календарь", "календаря", "календаре", "календарем", "календарём", "calendar"]);

/**
 * Календарь по названию или алиасу (US-06): сначала точно, потом с учётом падежей («в семейном» ~ «семейный»).
 * Неоднозначно или не найдено — undefined.
 */
export function findCalendarByName<C extends { title: string; aliases: string[] }>(calendars: C[], name: string): C | undefined {
  const norm = (s: string) => normalizeWords(s).filter((w) => !CALENDAR_WORDS.has(w));
  const wanted = norm(name);
  if (wanted.length === 0) return undefined;
  const names = (c: C) => [c.title, ...c.aliases].map(norm);
  const exact = calendars.filter((c) => names(c).some((n) => n.join(" ") === wanted.join(" ")));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const fuzzy = calendars.filter((c) =>
    names(c).some((n) => n.length === wanted.length && n.every((w, i) => sameWord(w, wanted[i]!))));
  return fuzzy.length === 1 ? fuzzy[0] : undefined;
}
