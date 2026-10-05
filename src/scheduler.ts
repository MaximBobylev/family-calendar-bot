// Планировщик (ADR-0005 п.4, п.6): cron раз в минуту забирает наступившие задачи.
// Пока задач нет — каркас: атомарно помечает и возвращает их, исполнители появятся с дайджестами (US-70).

export interface DueJob {
  id: string;
  kind: string;
  user_id: string | null;
  payload_json: string;
}

export async function claimDueJobs(db: D1Database, now: number, limit = 100): Promise<DueJob[]> {
  const { results } = await db
    .prepare(
      `UPDATE scheduled_jobs SET status = 'queued', attempts = attempts + 1
       WHERE id IN (SELECT id FROM scheduled_jobs WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at LIMIT ?)
       RETURNING id, kind, user_id, payload_json`,
    )
    .bind(now, limit)
    .all<DueJob>();
  return results;
}

export async function runJob(_db: D1Database, job: DueJob): Promise<void> {
  throw new Error(`no handler for job kind: ${job.kind}`);
}

/** Один проход планировщика: забрать и выполнить наступившие задачи. */
export async function tick(db: D1Database, now: number): Promise<number> {
  const jobs = await claimDueJobs(db, now);
  for (const job of jobs) {
    try {
      await runJob(db, job);
      await db.prepare("UPDATE scheduled_jobs SET status = 'done' WHERE id = ?").bind(job.id).run();
    } catch (e) {
      console.error("job failed", job.id, job.kind, e);
      await db.prepare("UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?").bind(job.id).run();
    }
  }
  return jobs.length;
}

const DAY_MS = 86_400_000;

/**
 * Ретеншн (privacy-политика, ADR-0005, ревью 2026-10-05): inbox — 7 дней (ошибки — 30),
 * тексты в журнале — 90 дней, карточки/state/OAuth-ссылки — 1 день после истечения, диалог — 30 дней.
 */
export async function cleanup(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM inbox WHERE status = 'done' AND received_at < ?").bind(now - 7 * DAY_MS),
    db.prepare("DELETE FROM inbox WHERE received_at < ?").bind(now - 30 * DAY_MS),
    db.prepare("UPDATE usage_events SET text = NULL, result_json = NULL WHERE created_at < ? AND (text IS NOT NULL OR result_json IS NOT NULL)").bind(now - 90 * DAY_MS),
    db.prepare("DELETE FROM pending_actions WHERE expires_at < ?").bind(now - DAY_MS),
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now - DAY_MS),
    db.prepare("DELETE FROM dialog_state WHERE updated_at < ?").bind(now - 30 * DAY_MS),
  ]);
}
