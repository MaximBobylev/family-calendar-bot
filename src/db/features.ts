// Какие функции пользователь уже успешно использовал (US-64) — задел под подсказки (R2) и итог триала (ADR-0004).

/** Новое значение — дописать и в docs/user-stories.md (US-64). */
export type Feature =
  | "list"
  | "find"
  | "create"
  | "recurring"
  | "modify"
  | "delete" // и отклонение приглашения
  | "undo"
  | "alias" // задан в /settings или по нему создано событие
  | "digest"
  | "voice"
  | "voice_rehear"
  | "settings"
  | "forwarded_confirm" // пересланное выполнено как команда
  | "forward_event" // из пересланного предложено событие
  | "image_event"
  | "ics_import"
  | "assign";

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
