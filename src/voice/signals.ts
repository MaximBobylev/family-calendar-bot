// Сигналы, что текстовый путь ошибся на голосовом (docs/tracks/multimodal-voice.md, вариант D). Чистые функции.

import { queryWords, sameWord } from "../calendar/match";

/** «Не так» после ответа на голосовое — переслушать предыдущее голосовое. */
export const NOT_RIGHT_WINDOW_MS = 5 * 60 * 1000;
/** Новое голосовое, похожее на предыдущее, — человек переговаривает; переслушать новое. */
export const REPEAT_WINDOW_MS = 3 * 60 * 1000;

/** «неправильно», «не так», «не то», «нет, я сказал…», «ты не понял» — короткая реплика недовольства. */
const NOT_RIGHT =
  /^(нет[,.!]?\s*)?(это\s+)?(неправильно|не\s+правильно|неверно|не\s+верно|не\s+так|не\s+то|ты\s+не\s+(понял|поняла|расслышал|расслышала)|не\s+понял|я\s+(же\s+)?(сказал|сказала|говорил|говорила)|wrong|that'?s\s+wrong|not\s+that)(?![\p{L}])/iu;

export function isNotRight(text: string): boolean {
  const t = text.trim();
  return t.split(/\s+/).length <= 8 && NOT_RIGHT.test(t);
}

/** Похожие транскрипты: ≥ 60% значимых слов общие (с учётом падежей), в каждом не меньше двух слов. */
export function similarTranscripts(a: string, b: string): boolean {
  const wa = queryWords(a);
  const wb = queryWords(b);
  if (wa.length < 2 || wb.length < 2) return false;
  const common = wa.filter((w) => wb.some((x) => sameWord(w, x))).length;
  return common / Math.max(wa.length, wb.length) >= 0.6;
}
