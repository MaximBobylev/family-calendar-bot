// Cron только раздаёт наступившие задачи в очередь, выполняет их потребитель очереди (ADR-0005 п.4, tech-debt #14).
// Исполнитель должен быть идемпотентным по смыслу: при сбое после отправки задача может повториться.

import type { AppContext } from "./bot/context";
import { runTripCheckJob } from "./bot/timezone";
import { TRIP_CHECK_JOB } from "./db/settings";
import { ASSIGN_JOB, runAssignJob } from "./jobs/assign";
import { DIGEST_JOB, runDigestJob, TOMORROW_DIGEST_JOB, WEEK_DIGEST_JOB } from "./jobs/digest";
import { errorClass, log } from "./log";
import { PUSH_SYNC_JOB, runPushSyncJob, runSyncJob, runWatchRenewJob, SYNC_JOB, WATCH_RENEW_JOB } from "./sync/engine";
import { NOTIFY_FLUSH_JOB, runNotifyFlushJob } from "./sync/notify";
import { runReminderJob, TG_REMINDER_JOB } from "./sync/reminders";

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
const RETRY_BASE_MS = 60 * 1000;
/** Лимит Telegram — ~30 сообщений/с. */
const JOBS_PER_SECOND = 20;

type JobHandler = (ctx: AppContext, job: DueJob) => Promise<void>;
const HANDLERS: Record<string, JobHandler> = {
  [DIGEST_JOB]: runDigestJob,
  // Один исполнитель: период сводки берёт из вида задачи
  [TOMORROW_DIGEST_JOB]: runDigestJob,
  [WEEK_DIGEST_JOB]: runDigestJob,
  [SYNC_JOB]: runSyncJob,
  [PUSH_SYNC_JOB]: runPushSyncJob,
  [WATCH_RENEW_JOB]: runWatchRenewJob,
  [NOTIFY_FLUSH_JOB]: runNotifyFlushJob,
  [TG_REMINDER_JOB]: runReminderJob,
  [ASSIGN_JOB]: runAssignJob,
  [TRIP_CHECK_JOB]: runTripCheckJob,
};

export async function claimDueJobs(db: D1Database, now: number, limit = 500): Promise<DueJob[]> {
  const { results } = await db
    .prepare(
      `UPDATE scheduled_jobs
       SET status = 'queued', queued_at = ?1
       WHERE id IN (SELECT id FROM scheduled_jobs WHERE status = 'pending' AND fire_at <= ?1 ORDER BY fire_at LIMIT ?2)
       RETURNING id, kind, user_id, payload_json, fire_at, attempts`,
    )
    .bind(now, limit)
    .all<DueJob>();
  return results;
}

/** Застрявшие в queued/running (упал воркер, потерялось сообщение) возвращаются в pending. В тестах enqueue выполняет сразу. */
export async function tick(db: D1Database, now: number, enqueue: (jobs: DueJob[], delays: number[]) => Promise<void>): Promise<number> {
  await db
    .prepare("UPDATE scheduled_jobs SET status = 'pending' WHERE status IN ('queued', 'running') AND queued_at < ?")
    .bind(now - STALE_MS)
    .run();
  const jobs = await claimDueJobs(db, now);
  if (jobs.length === 0) return 0;
  try {
    await enqueue(
      jobs,
      jobs.map((_, i) => Math.floor(i / JOBS_PER_SECOND)),
    );
  } catch (e) {
    console.error("enqueue jobs failed", e);
    await db.batch(jobs.map((j) => db.prepare("UPDATE scheduled_jobs SET status = 'pending' WHERE id = ? AND status = 'queued'").bind(j.id)));
  }
  return jobs.length;
}

/** Очередь может доставить сообщение повторно — тогда захват queued → running не пройдёт и ничего не случится. */
export async function runQueuedJob(ctx: AppContext, jobId: string): Promise<void> {
  const now = ctx.clock.now();
  const job = await ctx.db
    .prepare(
      `UPDATE scheduled_jobs
       SET status = 'running', attempts = attempts + 1, queued_at = ?
       WHERE id = ? AND status = 'queued'
       RETURNING id, kind, user_id, payload_json, fire_at, attempts`,
    )
    .bind(now, jobId)
    .first<DueJob>();
  if (!job) return;
  const started = Date.now(); // только длительность для лога
  const fields = { job_id: job.id, kind: job.kind, attempt: job.attempts };
  try {
    const handler = HANDLERS[job.kind];
    if (!handler) throw new Error(`no handler for job kind: ${job.kind}`);
    await handler(ctx, job);
    await ctx.db.prepare("UPDATE scheduled_jobs SET status = 'done', last_error = NULL WHERE id = ?").bind(job.id).run();
    log("job", { ...fields, outcome: "done", ms: Date.now() - started });
  } catch (e) {
    const error = String(e instanceof Error ? e.message : e).slice(0, 500);
    // Текст ошибки — в last_error (админка показывает его замаскированным), в лог — только класс
    log("job", { ...fields, outcome: "error", final: job.attempts >= MAX_ATTEMPTS, error: errorClass(e), ms: Date.now() - started });
    if (job.attempts >= MAX_ATTEMPTS) {
      await ctx.db.prepare("UPDATE scheduled_jobs SET status = 'failed', last_error = ? WHERE id = ?").bind(error, job.id).run();
    } else {
      const retryAt = ctx.clock.now() + RETRY_BASE_MS * 2 ** (job.attempts - 1);
      await ctx.db.prepare("UPDATE scheduled_jobs SET status = 'pending', fire_at = ?, last_error = ? WHERE id = ?").bind(retryAt, error, job.id).run();
    }
  }
}

const DAY_MS = 86_400_000;

/** Сроки хранения — из privacy-политики (ADR-0005). */
export async function cleanup(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM inbox WHERE status = 'done' AND received_at < ?").bind(now - 7 * DAY_MS),
    db.prepare("DELETE FROM inbox WHERE received_at < ?").bind(now - 30 * DAY_MS),
    db
      .prepare("UPDATE usage_events SET text = NULL, result_json = NULL WHERE created_at < ? AND (text IS NOT NULL OR result_json IS NOT NULL)")
      .bind(now - 90 * DAY_MS),
    db.prepare("DELETE FROM pending_actions WHERE expires_at < ?").bind(now - DAY_MS),
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now - DAY_MS),
    db.prepare("DELETE FROM dialog_state WHERE updated_at < ?").bind(now - 30 * DAY_MS),
    db.prepare("DELETE FROM scheduled_jobs WHERE status IN ('done', 'cancelled') AND fire_at < ?").bind(now - 7 * DAY_MS),
    db.prepare("DELETE FROM scheduled_jobs WHERE status = 'failed' AND fire_at < ?").bind(now - 30 * DAY_MS),
    // expires_at токена — уже неделя после события
    db.prepare("DELETE FROM inline_events WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM inline_adds WHERE created_at < ?").bind(now - 60 * DAY_MS),
  ]);
}
