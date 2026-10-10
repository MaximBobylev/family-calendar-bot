// Поправки к интенту от LLM: сильные слова в тексте важнее выбора маленькой модели (замер Qwen3).
// Одна функция — и для бота, и для замеров (scripts/eval-intents.ts).

import { extractDateSpans } from "../dates/extract";
import { isDetailChange } from "./detail-hints";
import type { Intent } from "./intents";
import { DELETE_VERBS, MODIFY_VERBS } from "./modify-hints";

const word = (stem: string) => new RegExp(`(?<!\\p{L})${stem}(?!\\p{L})`, "iu");

/** Нужно слово-событие: «следующая неделя» — не сюда. */
export const NEXT_EVENT = new RegExp(
  "(?<!\\p{L})(следующ|ближайш)\\p{L}*\\s+(встреч|событи|созвон|звон|дел|запис|мероприят)|" +
    "^(а\\s+)?что\\s+(у\\s+меня\\s+)?(дальше|потом|следующее)(?!\\p{L})|(?<!\\p{L})next\\s+(meeting|event|call|appointment)",
  "iu",
);

export const NEXT_WORD = word("(следующ\\p{L}*|ближайш\\p{L}*|next)");

export const WHEN_QUESTION = /^(а\s+)?(когда|when)(?!\p{L})/iu;

/** Явная команда создать: «поставь следующую встречу с Петей» — создание, даже без даты (спросим «когда?»). */
const CREATE_WORD = word("(постав\\p{L}*|запиш\\p{L}*|добав\\p{L}*|созда\\p{L}*|запланир\\p{L}*|schedule|add|create|book|set\\s+up)");

/** «Сейчас» не важно — нужен только факт даты. */
const hasDate = (text: string) => {
  const s = extractDateSpans(text, "2026-01-01T00:00", "UTC", "point");
  return !!(s.point || s.unsure);
};

/** «когда я свободен» — свободное время, а не поиск события. */
const NOT_LOOKUP = word("(свобод\\p{L}*|free|available)");

export function effectiveIntent(text: string, intent: Intent): Intent {
  if (intent.name === "multiple") return intent;
  // Место, описание, напоминания существующего события: «убери напоминания с обеда» — не удаление (US-41, US-42)
  if (isDetailChange(text)) return intent.name === "modify_event" ? intent : { name: "modify_event" };
  if (DELETE_VERBS.test(text)) return intent.name === "delete_event" ? intent : { name: "delete_event" };
  if (MODIFY_VERBS.test(text)) return intent.name === "modify_event" ? intent : { name: "modify_event" };
  // «Следующий созвон с Петей» без даты и без «поставь» — поиск, а не создание
  if (intent.name === "create_event" && NEXT_WORD.test(text) && !CREATE_WORD.test(text) && !hasDate(text)) return { name: "find_event", next: true };
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

/** Только общие слова («встреча») — null: спрашивают про ближайшее событие вообще. */
export function lookupQuery(text: string): string | null {
  const words = text
    .replace(/[?!.,«»"]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !LOOKUP_NOISE.test(w));
  const q = words.join(" ").trim();
  return q || null;
}
