// Планировщик (ADR-0005 п.4, п.6; tech-debt #14). Cron раз в минуту только раздаёт наступившие задачи
// в очередь (pending → queued); выполняет их потребитель очереди (queued → running → done).
// Повтор — с экспоненциальной задержкой (fire_at сдвигается), после MAX_ATTEMPTS — failed.
// Задача, застрявшая в queued/running дольше STALE_MS (упал воркер, потерялось сообщение), возвращается в pending.
// Исполнитель должен быть идемпотентным по смыслу: при сбое после отправки задача может повториться.

import type { AppContext } from "./bot/context";
import { runDigestJob, DIGEST_JOB } from "./jobs/digest";

export interface DueJob {
  id: string;
  kind: string;
  user_id: string | null;
  payload_json: string;
  fire_at: number;
  attempts: number;
}

export interface JobMessage {
  jobId: string;
}

const MAX_ATTEMPTS = 5;
const STALE_MS = 10 * 60 * 1000;
/** Разброс отправки по секундам — лимит Telegram ~30 сообщений/с. */
const JOBS_PER_SECOND = 20;

type JobHandler = (ctx: AppContext, job: DueJob) => Promise<void>;
const HANDLERS: Record<string, JobHandler> = {
  [DIGEST_JOB]: runDigestJob,
};

export async function claimDueJobs(db: D1Database, now: number, limit = 500): Promise<DueJob[]> {
  const { results } = await db
    .prepare(
      `UPDATE scheduled_jobs SET status = 'queued', queued_at = ?1
       WHERE id IN (SELECT id FROM scheduled_jobs WHERE status = 'pending' AND fire_at <= ?1 ORDER BY fire_at LIMIT ?2)
       RETURNING id, kind, user_id, payload_json, fire_at, attempts`,
    )
    .bind(now, limit)
    .all<DueJob>();
  return results;
}

/**
 * Один проход cron: вернуть зависшие, забрать наступившие и отдать их `enqueue` (очередь; в тестах — сразу выполнить).
 * Если очередь недоступна — задачи возвращаются в pending до следующей минуты.
 */
export async function tick(db: D1Database, now: number, enqueue: (jobs: DueJob[], delays: number[]) => Promise<void>): Promise<number> {
  await db
    .prepare("UPDATE scheduled_jobs SET status = 'pending' WHERE status IN ('queued', 'running') AND queued_at < ?")
    .bind(now - STALE_MS)
    .run();
  const jobs = await claimDueJobs(db, now);
  if (jobs.length === 0) return 0;
  try {
    await enqueue(jobs, jobs.map((_, i) => Math.floor(i / JOBS_PER_SECOND)));
  } catch (e) {
    console.error("enqueue jobs failed", e);
    await db.batch(jobs.map((j) => db.prepare("UPDATE scheduled_jobs SET status = 'pending' WHERE id = ? AND status = 'queued'").bind(j.id)));
  }
  return jobs.length;
}

/** Выполнить задачу из очереди. Повторная доставка того же сообщения ничего не делает (захват queued → running). */
export async function runQueuedJob(ctx: AppContext, jobId: string): Promise<void> {
  const now = ctx.clock.now();
  const job = await ctx.db
    .prepare(
      `UPDATE scheduled_jobs SET status = 'running', attempts = attempts + 1, queued_at = ?
       WHERE id = ? AND status = 'queued'
       RETURNING id, kind, user_id, payload_json, fire_at, attempts`,
    )
    .bind(now, jobId)
    .first<DueJob>();
  if (!job) return;
  try {
    const handler = HANDLERS[job.kind];
    if (!handler) throw new Error(`no handler for job kind: ${job.kind}`);
    await handler(ctx, job);
    await ctx.db.prepare("UPDATE scheduled_jobs SET status = 'done', last_error = NULL WHERE id = ?").bind(job.id).run();
  } catch (e) {
    const error = String(e instanceof Error ? e.message : e).slice(0, 500);
    console.error("job failed", job.id, job.kind, job.attempts, error);
    if (job.attempts >= MAX_ATTEMPTS) {
      await ctx.db.prepare("UPDATE scheduled_jobs SET status = 'failed', last_error = ? WHERE id = ?").bind(error, job.id).run();
    } else {
      // 1, 2, 4, 8 минут
      const retryAt = ctx.clock.now() + 60_000 * 2 ** (job.attempts - 1);
      await ctx.db.prepare("UPDATE scheduled_jobs SET status = 'pending', fire_at = ?, last_error = ? WHERE id = ?").bind(retryAt, error, job.id).run();
    }
  }
}

const DAY_MS = 86_400_000;

/**
 * Ретеншн (privacy-политика, ADR-0005, ревью 2026-10-05): inbox — 7 дней (ошибки — 30),
 * тексты в журнале — 90 дней, карточки/state/OAuth-ссылки — 1 день после истечения, диалог — 30 дней,
 * выполненные задачи — 7 дней (ошибки — 30).
 */
export async function cleanup(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM inbox WHERE status = 'done' AND received_at < ?").bind(now - 7 * DAY_MS),
    db.prepare("DELETE FROM inbox WHERE received_at < ?").bind(now - 30 * DAY_MS),
    db.prepare("UPDATE usage_events SET text = NULL, result_json = NULL WHERE created_at < ? AND (text IS NOT NULL OR result_json IS NOT NULL)").bind(now - 90 * DAY_MS),
    db.prepare("DELETE FROM pending_actions WHERE expires_at < ?").bind(now - DAY_MS),
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now - DAY_MS),
    db.prepare("DELETE FROM dialog_state WHERE updated_at < ?").bind(now - 30 * DAY_MS),
    db.prepare("DELETE FROM scheduled_jobs WHERE status IN ('done', 'cancelled') AND fire_at < ?").bind(now - 7 * DAY_MS),
    db.prepare("DELETE FROM scheduled_jobs WHERE status = 'failed' AND fire_at < ?").bind(now - 30 * DAY_MS),
  ]);
}
