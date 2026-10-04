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
