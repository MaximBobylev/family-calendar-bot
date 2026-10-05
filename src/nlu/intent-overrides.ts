// Детерминированные поправки к интенту от LLM: сильные слова в тексте важнее выбора маленькой модели
// (замер Qwen3, 2026-10-04). Одна функция — и для бота (routeIntent), и для замеров (scripts/eval-intents.ts).

import { isDetailChange } from "./detail-hints";
import type { Intent } from "./intents";
import { DELETE_VERBS, MODIFY_VERBS } from "./modify-hints";

const word = (stem: string) => new RegExp(`(?<!\\p{L})${stem}(?!\\p{L})`, "iu");

/** «следующая встреча», «ближайший созвон», «что у меня дальше», «next meeting» (US-21). Не «следующая неделя». */
export const NEXT_EVENT = new RegExp(
  "(?<!\\p{L})(следующ|ближайш)\\p{L}*\\s+(встреч|событи|созвон|звон|дел|запис|мероприят)|" +
    "^(а\\s+)?что\\s+(у\\s+меня\\s+)?(дальше|потом|следующее)(?!\\p{L})|(?<!\\p{L})next\\s+(meeting|event|call|appointment)",
  "iu",
);

/** «следующая планёрка», «ближайший стоматолог» — показать одно ближайшее совпадение. */
export const NEXT_WORD = word("(следующ\\p{L}*|ближайш\\p{L}*|next)");

/** «Когда встреча с Петей?», «Когда у меня стоматолог?», «When is the dentist?» (US-21). */
export const WHEN_QUESTION = /^(а\s+)?(когда|when)(?!\p{L})/iu;

/** Не поиск события: «когда я свободен» — это свободное время (US-22, позже). */
const NOT_LOOKUP = word("(свобод\\p{L}*|free|available)");

export function effectiveIntent(text: string, intent: Intent): Intent {
  if (intent.name === "multiple") return intent;
  // Место, описание, напоминания существующего события: «убери напоминания с обеда» — не удаление (US-41, US-42)
  if (isDetailChange(text)) return intent.name === "modify_event" ? intent : { name: "modify_event" };
  if (DELETE_VERBS.test(text)) return intent.name === "delete_event" ? intent : { name: "delete_event" };
  if (MODIFY_VERBS.test(text)) return intent.name === "modify_event" ? intent : { name: "modify_event" };
  // Вопрос «когда …» / «какая следующая …» — поиск события, а не список за период и не «не понимаю»
  if ((intent.name === "list_events" || intent.name === "unsupported") && !NOT_LOOKUP.test(text)) {
    if (NEXT_EVENT.test(text)) return { name: "find_event", next: true };
    if (WHEN_QUESTION.test(text)) return { name: "find_event" };
  }
  return intent;
}

const LOOKUP_NOISE = word(
  "(когда|у|меня|мне|будет|будут|есть|а|ли|там|моя|мой|моё|мое|мою|следующ\\p{L}*|ближайш\\p{L}*|какая|какой|какое|что|дальше|потом|" +
    "покажи|подскажи|скажи|напомни|when|is|are|my|the|next|what|what's|whats|show)",
);

/**
 * Что ищем — из самой фразы: без вопросительных слов и «следующая». «Когда у меня стоматолог?» → «стоматолог».
 * Только общие слова («встреча») — null: спрашивают про ближайшее событие вообще.
 */
export function lookupQuery(text: string): string | null {
  const words = text
    .replace(/[?!.,«»"]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !LOOKUP_NOISE.test(w));
  const q = words.join(" ").trim();
  return q || null;
}
