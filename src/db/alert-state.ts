// Алерты владельцу (src/ops/alerts.ts): состояние правил в alert_state (миграция 0009) и счётчики,
// которых нет в запросах панели «здоровье». Только агрегаты — тексты и id пользователей не выбираются.

import type { AlertState } from "../ops/alert-rules";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export async function loadAlertStates(db: D1Database): Promise<Map<string, AlertState>> {
  const { results } = await db.prepare("SELECT key, status, since, last_sent_at FROM alert_state").all<AlertState>();
  return new Map(results.map((r) => [r.key, r]));
}

export async function saveAlertState(db: D1Database, s: AlertState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alert_state (key, status, since, last_sent_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (key) DO UPDATE SET status = ?2, since = ?3, last_sent_at = ?4`,
    )
    .bind(s.key, s.status, s.since, s.last_sent_at)
    .run();
}

export interface AlertCounts {
  /** Задачи (кроме дайджестов), ставшие failed за час: queued_at — время последней попытки. */
  jobsFailedHour: number;
  digestFailedDay: number;
  aiCalls: number;
  aiErrors: number;
}

export async function alertCounts(db: D1Database, now: number, aiWindowMs: number): Promise<AlertCounts> {
  const [jobs, ai] = await db.batch<{ a: number; b: number }>([
    db
      .prepare(
        `SELECT coalesce(sum(kind <> 'digest' AND queued_at > ?1), 0) a, coalesce(sum(kind = 'digest' AND queued_at > ?2), 0) b
         FROM scheduled_jobs WHERE status = 'failed'`,
      )
      .bind(now - HOUR_MS, now - DAY_MS),
    db
      .prepare("SELECT count(*) a, coalesce(sum(outcome = 'error'), 0) b FROM usage_events WHERE created_at > ? AND kind IN ('llm', 'stt')")
      .bind(now - aiWindowMs),
  ]);
  const j = jobs?.results[0];
  const a = ai?.results[0];
  return { jobsFailedHour: j?.a ?? 0, digestFailedDay: j?.b ?? 0, aiCalls: a?.a ?? 0, aiErrors: a?.b ?? 0 };
}
