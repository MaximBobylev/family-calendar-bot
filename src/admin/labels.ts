// Русские подписи для таблиц админки — чистый модуль (импортируют юнит-тесты, без D1).
// Полнота FEATURE_LABELS по типу Feature проверяется при компиляции в views/usage.ts.

/** Функции бота (US-64, src/db/features.ts). Новая функция без подписи — ошибка компиляции в views/usage.ts. */
export const FEATURE_LABELS = {
  list: "Расписание (US-20)",
  find: "Поиск встречи (US-21)",
  create: "Создание события (US-30)",
  recurring: "Серия (US-32)",
  modify: "Изменение (US-40–42)",
  delete: "Удаление / отказ (US-50)",
  undo: "Отмена последнего (US-61)",
  alias: "Другое имя календаря (US-06)",
  digest: "Сводка (US-70)",
  voice: "Голосовое (US-10)",
  voice_rehear: "Переслушивание голосового",
  settings: "Настройки (US-04)",
  forwarded_confirm: "Пересланное как команда (US-10)",
  forward_event: "Событие из пересланного (US-65)",
  image_event: "Событие из фото (US-66)",
  ics_import: "Импорт .ics (US-67)",
} as const satisfies Record<string, string>;

/** Подпись функции; неизвестная (старая запись, функция из соседней ветки) — ключ как есть. */
export const featureLabel = (f: string): string => (Object.hasOwn(FEATURE_LABELS, f) ? FEATURE_LABELS[f as keyof typeof FEATURE_LABELS] : f);

/** Источник вызова LLM (usage_events.result_json.source, src/bot/ingest.ts). */
export const SOURCE_LABELS: Record<string, string> = { forward: "пересланное → LLM (US-65)", image: "фото → vision (US-66)" };
