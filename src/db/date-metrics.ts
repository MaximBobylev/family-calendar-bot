// Метрика качества дат (tech-debt #26): «создано из карточки» и «дату поправили сразу после» — счётчики для /admin/usage.

import type { DateFixKind } from "../bot/date-fix-logic";

export interface DateMetric {
  userId: string;
  event: "created" | "fix";
  source: string;
  fixKind?: DateFixKind;
  agreement?: string;
  disagreed: boolean;
  now: number;
}

/** Best-effort: сбой учёта не ломает ответ пользователю (как recordFeature). */
export async function recordDateMetric(db: D1Database, m: DateMetric): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO date_metrics (id, user_id, created_at, event, source, fix_kind, agreement, disagreed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), m.userId, m.now, m.event, m.source, m.fixKind ?? null, m.agreement ?? null, m.disagreed ? 1 : 0)
      .run();
  } catch (e) {
    console.error("date metric not recorded", m.event, e instanceof Error ? e.message : e);
  }
}
