// Весь SQL админки — в одном месте (docs/admin-console.md, «Архитектура»): тонкий слой, легко повторить на Go.
// admin_audit — только INSERT и SELECT (без UPDATE/DELETE).

import { setOpsState } from "../db/ops-state";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

// --- Здоровье ---------------------------------------------------------------------------------------

export interface Totals {
  users: number;
  accounts: number;
  calendars: number;
}

export async function totals(db: D1Database): Promise<Totals> {
  const row = await db
    .prepare(
      `SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM provider_accounts) accounts,
              (SELECT count(*) FROM calendars) calendars`,
    )
    .first<Totals>();
  return row ?? { users: 0, accounts: 0, calendars: 0 };
}

export interface InboxHealth {
  pending: number;
  processing: number;
  /** Самый старый апдейт в pending/processing (received_at). */
  oldestOpenAt: number | null;
  receivedHour: number;
  receivedDay: number;
  failedHour: number;
  failedDay: number;
  /** Апдейты за сутки, обработанные не с первой попытки. */
  retriedDay: number;
}

export async function inboxHealth(db: D1Database, now: number): Promise<InboxHealth> {
  const r = await db
    .prepare(
      `SELECT coalesce(sum(status = 'pending'), 0) pending, coalesce(sum(status = 'processing'), 0) processing,
              min(CASE WHEN status IN ('pending', 'processing') THEN received_at END) oldest,
              coalesce(sum(received_at > ?1), 0) recv_hour, coalesce(sum(received_at > ?2), 0) recv_day,
              coalesce(sum(status = 'failed' AND received_at > ?1), 0) failed_hour,
              coalesce(sum(status = 'failed' AND received_at > ?2), 0) failed_day,
              coalesce(sum(attempts > 1 AND received_at > ?2), 0) retried_day
       FROM inbox`,
    )
    .bind(now - HOUR_MS, now - DAY_MS)
    .first<{
      pending: number;
      processing: number;
      oldest: number | null;
      recv_hour: number;
      recv_day: number;
      failed_hour: number;
      failed_day: number;
      retried_day: number;
    }>();
  return {
    pending: r?.pending ?? 0,
    processing: r?.processing ?? 0,
    oldestOpenAt: r?.oldest ?? null,
    receivedHour: r?.recv_hour ?? 0,
    receivedDay: r?.recv_day ?? 0,
    failedHour: r?.failed_hour ?? 0,
    failedDay: r?.failed_day ?? 0,
    retriedDay: r?.retried_day ?? 0,
  };
}

export interface InboxFailure {
  update_id: number;
  received_at: number;
  attempts: number;
  error: string | null;
}

/** Последние ошибки обработки. payload_json (сырой апдейт с именем и текстом) не выбирается никогда. */
export async function inboxFailures(db: D1Database, limit = 10): Promise<InboxFailure[]> {
  const { results } = await db
    .prepare("SELECT update_id, received_at, attempts, error FROM inbox WHERE status = 'failed' ORDER BY received_at DESC LIMIT ?")
    .bind(limit)
    .all<InboxFailure>();
  return results;
}

export interface UpdatesDay {
  day: string;
  n: number;
  failed: number;
  lag_ms: number | null;
  max_lag_ms: number | null;
}

export async function updatesByDay(db: D1Database, now: number): Promise<UpdatesDay[]> {
  const { results } = await db
    .prepare(
      `SELECT date(received_at / 1000, 'unixepoch') day, count(*) n, sum(status = 'failed') failed,
              round(avg(CASE WHEN status = 'done' THEN processed_at - received_at END)) lag_ms,
              max(CASE WHEN status = 'done' THEN processed_at - received_at END) max_lag_ms
       FROM inbox WHERE received_at > ? GROUP BY day ORDER BY day DESC`,
    )
    .bind(now - 7 * DAY_MS)
    .all<UpdatesDay>();
  return results;
}

export interface JobsGroup {
  kind: string;
  status: string;
  n: number;
  oldest_fire_at: number | null;
}

export async function jobsByKindStatus(db: D1Database): Promise<JobsGroup[]> {
  const { results } = await db
    .prepare("SELECT kind, status, count(*) n, min(fire_at) oldest_fire_at FROM scheduled_jobs GROUP BY kind, status ORDER BY kind, status")
    .all<JobsGroup>();
  return results;
}

export interface JobsLag {
  /** pending, у которых fire_at прошёл больше 2 минут назад (cron раздаёт раз в минуту). */
  overdue: number;
  oldestOverdueAt: number | null;
  /** queued/running дольше 10 минут — вернутся в pending (scheduler.ts, STALE_MS). */
  stuck: number;
  failedDay: number;
}

export async function jobsLag(db: D1Database, now: number): Promise<JobsLag> {
  const r = await db
    .prepare(
      `SELECT coalesce(sum(status = 'pending' AND fire_at < ?1), 0) overdue,
              min(CASE WHEN status = 'pending' AND fire_at < ?1 THEN fire_at END) oldest_overdue,
              coalesce(sum(status IN ('queued', 'running') AND queued_at < ?2), 0) stuck,
              coalesce(sum(status = 'failed' AND fire_at > ?3), 0) failed_day
       FROM scheduled_jobs`,
    )
    .bind(now - 2 * MIN_MS, now - 10 * MIN_MS, now - DAY_MS)
    .first<{ overdue: number; oldest_overdue: number | null; stuck: number; failed_day: number }>();
  return { overdue: r?.overdue ?? 0, oldestOverdueAt: r?.oldest_overdue ?? null, stuck: r?.stuck ?? 0, failedDay: r?.failed_day ?? 0 };
}

export interface ProblemJob {
  id: string;
  kind: string;
  user_id: string | null;
  status: string;
  fire_at: number;
  attempts: number;
  last_error: string | null;
}

/** failed и pending-с-ошибкой (повтор ждёт), самые свежие. */
export async function problemJobs(db: D1Database, limit = 10): Promise<ProblemJob[]> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, user_id, status, fire_at, attempts, last_error FROM scheduled_jobs
       WHERE status = 'failed' OR (status = 'pending' AND last_error IS NOT NULL)
       ORDER BY fire_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<ProblemJob>();
  return results;
}

export interface DigestDelivery {
  /** Наступившие за последние 24 ч, по статусу задачи. */
  fired: Record<string, number>;
  /** Запланированы на ближайшие 24 ч. */
  upcoming: number;
}

export async function digestDelivery(db: D1Database, now: number): Promise<DigestDelivery> {
  const [fired, upcoming] = await Promise.all([
    db
      .prepare("SELECT status, count(*) n FROM scheduled_jobs WHERE kind = 'digest' AND fire_at > ?1 AND fire_at <= ?2 GROUP BY status")
      .bind(now - DAY_MS, now)
      .all<{ status: string; n: number }>(),
    db
      .prepare("SELECT count(*) n FROM scheduled_jobs WHERE kind = 'digest' AND status = 'pending' AND fire_at > ?1 AND fire_at <= ?2")
      .bind(now, now + DAY_MS)
      .first<{ n: number }>(),
  ]);
  return { fired: Object.fromEntries(fired.results.map((r) => [r.status, r.n])), upcoming: upcoming?.n ?? 0 };
}

export interface OpsValue {
  value: string;
  updated_at: number;
}

export async function opsState(db: D1Database, keys: string[]): Promise<Map<string, OpsValue>> {
  if (keys.length === 0) return new Map();
  const { results } = await db
    .prepare(`SELECT key, value, updated_at FROM ops_state WHERE key IN (${keys.map(() => "?").join(", ")})`)
    .bind(...keys)
    .all<{ key: string } & OpsValue>();
  return new Map(results.map((r) => [r.key, { value: r.value, updated_at: r.updated_at }]));
}

export const saveOpsState = setOpsState;

// --- Журнал распознанного ----------------------------------------------------------------------------

export interface JournalRow {
  id: string;
  user_id: string | null;
  created_at: number;
  kind: string;
  model: string;
  outcome: string | null;
  text: string | null;
  result_json: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  audio_ms: number | null;
  cost_micro_usd: number | null;
  /** Пояс пользователя сейчас (истории поясов нет); NULL — пользователь удалён. */
  tz: string | null;
}

export interface JournalFilter {
  kind?: string;
  outcome?: string;
  intent?: string;
  /** Пользователи по псевдониму (обратного отображения нет — список id подбирает роутер). */
  userIds?: string[];
  /** Курсор: записи строго раньше этого момента. */
  before?: number;
}

const JOURNAL_COLUMNS = `e.id, e.user_id, e.created_at, e.kind, e.model, e.outcome, e.text, e.result_json,
  e.tokens_in, e.tokens_out, e.audio_ms, e.cost_micro_usd, u.home_tz tz`;

export async function journal(db: D1Database, f: JournalFilter, limit = 50): Promise<JournalRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.kind) {
    where.push("e.kind = ?");
    args.push(f.kind);
  }
  if (f.outcome) {
    where.push("e.outcome = ?");
    args.push(f.outcome);
  }
  if (f.intent) {
    where.push("json_valid(e.result_json) AND json_extract(e.result_json, '$.name') = ?");
    args.push(f.intent);
  }
  if (f.userIds) {
    if (f.userIds.length === 0) return [];
    where.push(`e.user_id IN (${f.userIds.map(() => "?").join(", ")})`);
    args.push(...f.userIds);
  }
  if (f.before) {
    where.push("e.created_at < ?");
    args.push(f.before);
  }
  args.push(limit);
  const { results } = await db
    .prepare(
      `SELECT ${JOURNAL_COLUMNS} FROM usage_events e LEFT JOIN users u ON u.id = e.user_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.created_at DESC LIMIT ?`,
    )
    .bind(...args)
    .all<JournalRow>();
  return results;
}

export async function journalRow(db: D1Database, id: string): Promise<JournalRow | null> {
  return db.prepare(`SELECT ${JOURNAL_COLUMNS} FROM usage_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?`).bind(id).first<JournalRow>();
}

/** Все id пользователей — для поиска по псевдониму (на MVP-объёмах дешевле, чем хранить псевдонимы). */
export async function userIds(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT id FROM users").all<{ id: string }>();
  return results.map((r) => r.id);
}

// --- Аудит --------------------------------------------------------------------------------------------

export interface AuditEntry {
  at: number;
  operator: string;
  action: string;
  targetUserId: string | null;
  reason: string | null;
  details: Record<string, unknown>;
}

export async function insertAudit(db: D1Database, e: AuditEntry): Promise<number> {
  const row = await db
    .prepare("INSERT INTO admin_audit (at, operator, action, target_user_id, reason, details_json) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(e.at, e.operator, e.action, e.targetUserId, e.reason, JSON.stringify(e.details))
    .first<{ id: number }>();
  if (!row) throw new Error("admin_audit insert returned nothing");
  return row.id;
}

export interface AuditRow {
  id: number;
  at: number;
  operator: string;
  action: string;
  target_user_id: string | null;
  reason: string | null;
  details_json: string;
}

export async function auditLog(db: D1Database, limit = 100): Promise<AuditRow[]> {
  const { results } = await db
    .prepare("SELECT id, at, operator, action, target_user_id, reason, details_json FROM admin_audit ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<AuditRow>();
  return results;
}

// --- Расход -------------------------------------------------------------------------------------------

export interface UserUsage {
  user_id: string | null;
  kind: string;
  n_today: number;
  n_7d: number;
  n_hour: number;
  n_24h: number;
  errors_7d: number;
  cost_today: number;
  cost_7d: number;
  /** Записи без cost_micro_usd (до учёта стоимости в момент вызова). */
  no_cost: number;
}

export async function usageByUser(db: D1Database, now: number, dayStart: number): Promise<UserUsage[]> {
  const { results } = await db
    .prepare(
      `SELECT user_id, kind, coalesce(sum(created_at >= ?1), 0) n_today, count(*) n_7d,
              coalesce(sum(created_at > ?3), 0) n_hour, coalesce(sum(created_at > ?4), 0) n_24h,
              coalesce(sum(outcome = 'error'), 0) errors_7d,
              coalesce(sum(CASE WHEN created_at >= ?1 THEN cost_micro_usd END), 0) cost_today,
              coalesce(sum(cost_micro_usd), 0) cost_7d, coalesce(sum(cost_micro_usd IS NULL), 0) no_cost
       FROM usage_events WHERE created_at > ?2 GROUP BY user_id, kind ORDER BY cost_7d DESC`,
    )
    .bind(dayStart, now - 7 * DAY_MS, now - HOUR_MS, now - DAY_MS)
    .all<UserUsage>();
  return results;
}

export interface ModelUsage {
  kind: string;
  model: string;
  n: number;
  errors: number;
  tin: number;
  tout: number;
  audio_ms: number;
  cost: number;
}

export async function usageByModel(db: D1Database, now: number): Promise<ModelUsage[]> {
  const { results } = await db
    .prepare(
      `SELECT kind, model, count(*) n, coalesce(sum(outcome = 'error'), 0) errors,
              coalesce(sum(tokens_in), 0) tin, coalesce(sum(tokens_out), 0) tout, coalesce(sum(audio_ms), 0) audio_ms,
              coalesce(sum(cost_micro_usd), 0) cost
       FROM usage_events WHERE created_at > ? GROUP BY kind, model ORDER BY kind`,
    )
    .bind(now - 7 * DAY_MS)
    .all<ModelUsage>();
  return results;
}

export async function intentCounts(db: D1Database, now: number): Promise<{ intent: string; n: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT CASE WHEN outcome = 'error' OR NOT json_valid(result_json) THEN '(ошибка)' ELSE coalesce(json_extract(result_json, '$.name'), '—') END intent,
              count(*) n
       FROM usage_events WHERE kind = 'llm' AND created_at > ? GROUP BY intent ORDER BY n DESC`,
    )
    .bind(now - 7 * DAY_MS)
    .all<{ intent: string; n: number }>();
  return results;
}

export async function cardCounts(db: D1Database, now: number): Promise<{ kind: string; status: string; n: number }[]> {
  const { results } = await db
    .prepare("SELECT kind, status, count(*) n FROM pending_actions WHERE created_at > ? GROUP BY kind, status ORDER BY kind, status")
    .bind(now - 7 * DAY_MS)
    .all<{ kind: string; status: string; n: number }>();
  return results;
}

export interface FeatureRow {
  feature: string;
  users: number;
  uses: number;
  first_at: number;
}

/** US-64: какие функции использовали — пользователей, раз всего, самое раннее первое использование. */
export async function featureUsage(db: D1Database): Promise<FeatureRow[]> {
  const { results } = await db
    .prepare(
      `SELECT feature, count(*) users, sum(count) uses, min(first_used_at) first_at
       FROM feature_usage
       GROUP BY feature
       ORDER BY users DESC, uses DESC, feature`,
    )
    .all<FeatureRow>();
  return results;
}
