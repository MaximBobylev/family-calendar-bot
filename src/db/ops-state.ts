// Служебные метки эксплуатации (ops_state, миграция 0006): последний прогон cron, кеш getWebhookInfo.
// Читает админка (src/admin/queries.ts); пишут cron и админка.

export const OPS_LAST_TICK = "last_tick_at";
export const OPS_LAST_HOURLY = "last_hourly_at";

export async function setOpsState(db: D1Database, key: string, value: string, now: number): Promise<void> {
  await db
    .prepare("INSERT INTO ops_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3")
    .bind(key, value, now)
    .run();
}
