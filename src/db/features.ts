// US-64: учёт функций — какие возможности пользователь уже успешно использовал и когда впервые.
// Задел под подсказки о неиспользованных функциях (R2) и объяснение ценности в конце триала (ADR-0004).

/** Функция бота для учёта (US-64). Новое значение — дописать сюда и в docs/user-stories.md (US-64). */
export type Feature =
  | "list" // показано расписание (US-20)
  | "find" // «когда встреча…», «следующая встреча» (US-21)
  | "create" // событие создано (US-30)
  | "recurring" // создана серия (US-32)
  | "modify" // событие изменено (US-40–42)
  | "delete" // удалено или отклонено (US-50)
  | "undo" // отмена последнего действия (US-61)
  | "alias" // другое имя календаря: задано в /settings или по нему создано событие (US-06)
  | "digest" // получена утренняя сводка (US-70)
  | "voice" // голосовое распознано (US-10)
  | "voice_rehear" // голосовое переслушано мультимодальной моделью
  | "settings" // изменена настройка в /settings (US-04)
  | "forwarded_confirm"; // пересланное выполнено как команда (US-10)

/**
 * Отметить успешное использование: upsert без чтения — первая отметка запоминает время, дальше растёт счётчик.
 * Несколько функций сразу — одним batch (один запрос к D1). Best-effort: сбой учёта не ломает ответ пользователю.
 */
export async function recordFeature(db: D1Database, userId: string, feature: Feature | Feature[], now: number): Promise<void> {
  const features = Array.isArray(feature) ? feature : [feature];
  if (features.length === 0) return;
  const upsert = db.prepare(
    `INSERT INTO feature_usage (user_id, feature, first_used_at, count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (user_id, feature) DO UPDATE SET count = count + 1`,
  );
  try {
    await db.batch(features.map((f) => upsert.bind(userId, f, now)));
  } catch (e) {
    console.error("feature usage not recorded", features.join(","), e instanceof Error ? e.message : e);
  }
}
