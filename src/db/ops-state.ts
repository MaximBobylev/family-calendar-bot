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

/** Заголовки лимитов последнего вызова провайдера (x-ratelimit-*, retry-after) — для панели «Квоты». */
export const RATE_HEADERS_PREFIX = "rate_headers:";

export interface SeenRateHeaders {
  provider: string;
  headers: Record<string, string>;
  /** HTTP-статус того вызова: 429 — лимит уже сработал. */
  status: number;
  at: number;
}

export async function saveRateHeaders(db: D1Database, provider: string, headers: Record<string, string>, status: number, now: number): Promise<void> {
  await setOpsState(db, `${RATE_HEADERS_PREFIX}${provider}`, JSON.stringify({ headers, status }), now);
}

export async function loadRateHeaders(db: D1Database): Promise<SeenRateHeaders[]> {
  const { results } = await db
    .prepare("SELECT key, value, updated_at FROM ops_state WHERE key LIKE ? ORDER BY key")
    .bind(`${RATE_HEADERS_PREFIX}%`)
    .all<{ key: string; value: string; updated_at: number }>();
  const out: SeenRateHeaders[] = [];
  for (const r of results) {
    try {
      const v = JSON.parse(r.value) as { headers: Record<string, string>; status: number };
      out.push({ provider: r.key.slice(RATE_HEADERS_PREFIX.length), headers: v.headers, status: v.status, at: r.updated_at });
    } catch {
      // битая запись — просто не показываем
    }
  }
  return out;
}

export async function getOpsState(db: D1Database, key: string): Promise<{ value: string; updated_at: number } | null> {
  return db.prepare("SELECT value, updated_at FROM ops_state WHERE key = ?").bind(key).first<{ value: string; updated_at: number }>();
}
