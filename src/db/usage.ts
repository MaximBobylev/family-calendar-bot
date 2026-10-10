// Одна запись на вызов STT/LLM: журнал распознанного (US-13) и основа лимитов на пользователя (tech-debt #4).

import { DAY_MS, HOUR_MS, type UsageWindow } from "../limits";

export interface UsageRecord {
  userId: string;
  kind: "stt" | "llm";
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  audioMs?: number;
  /** Оценка по прайсу (limits.ts), не фактический счёт. */
  costMicroUsd?: number;
  text?: string;
  result?: unknown;
  outcome: "ok" | "error";
  now: number;
}

export async function recordUsage(db: D1Database, r: UsageRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_events (id, user_id, created_at, kind, provider, model, audio_ms, tokens_in, tokens_out, cost_micro_usd, text, result_json, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      r.userId,
      r.now,
      r.kind,
      r.provider,
      r.model,
      r.audioMs ?? null,
      r.tokensIn ?? null,
      r.tokensOut ?? null,
      r.costMicroUsd ?? null,
      r.text ?? null,
      r.result === undefined ? null : JSON.stringify(r.result),
      r.outcome,
    )
    .run();
}

export async function usageWindow(db: D1Database, userId: string, kind: UsageRecord["kind"], now: number): Promise<UsageWindow> {
  const row = await db
    .prepare(
      `SELECT count(*) AS day_n, min(created_at) AS day_oldest,
              coalesce(sum(created_at > ?3), 0) AS hour_n, min(CASE WHEN created_at > ?3 THEN created_at END) AS hour_oldest
       FROM usage_events
       WHERE user_id = ?1 AND kind = ?2 AND created_at > ?4`,
    )
    .bind(userId, kind, now - HOUR_MS, now - DAY_MS)
    .first<{ day_n: number; day_oldest: number | null; hour_n: number; hour_oldest: number | null }>();
  return { dayCount: row?.day_n ?? 0, dayOldest: row?.day_oldest ?? null, hourCount: row?.hour_n ?? 0, hourOldest: row?.hour_oldest ?? null };
}

export interface ProviderToday {
  provider: string;
  /** Вызовов с `utcStart` (полночь UTC) и с `altStart` (полночь в другом поясе, напр. сброс Gemini по Тихоокеанскому). */
  n_utc: number;
  n_alt: number;
  cost_utc: number;
  audio_ms_utc: number;
}

/** Ошибки цепочки (provider = chain) не тратят квоту провайдера. */
export async function usageTodayByProvider(db: D1Database, utcStart: number, altStart: number): Promise<ProviderToday[]> {
  const { results } = await db
    .prepare(
      `SELECT provider,
              coalesce(sum(created_at >= ?1), 0) AS n_utc,
              coalesce(sum(created_at >= ?2), 0) AS n_alt,
              coalesce(sum(CASE WHEN created_at >= ?1 THEN cost_micro_usd END), 0) AS cost_utc,
              coalesce(sum(CASE WHEN created_at >= ?1 THEN audio_ms END), 0) AS audio_ms_utc
       FROM usage_events
       WHERE created_at >= min(?1, ?2) AND outcome = 'ok'
       GROUP BY provider`,
    )
    .bind(utcStart, altStart)
    .all<ProviderToday>();
  return results;
}
