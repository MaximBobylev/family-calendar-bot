// Весь SQL админки — в одном месте (docs/admin-console.md, «Архитектура»): тонкий слой, легко повторить на Go.
// admin_audit — только INSERT и SELECT (без UPDATE/DELETE).

import { setOpsState } from "../db/ops-state";
import type { SyncCalendarRow } from "../ops/sync-health";

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

// --- Синхронизация, уведомления, напоминания (итерация 3) -----------------------------------------------
// id календаря (почта) и тексты уведомлений не выбираются — только времена, статусы и счётчики.

/** Строки calendar_sync для сводки (src/ops/sync-health.ts) — по ней же алерт sync_stale. */
export async function syncCalendars(db: D1Database): Promise<SyncCalendarRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.last_sync_at, s.channel_id IS NOT NULL AS has_channel, s.channel_expires_at, s.last_outcome, s.last_error_at, s.last_resync_at,
              EXISTS (SELECT 1 FROM calendars c
                      JOIN provider_accounts a ON a.id = c.account_id
                      JOIN channel_identities ci ON ci.user_id = a.user_id AND ci.channel = 'telegram'
                      WHERE c.provider_calendar_id = s.provider_calendar_id) AS subscribed
       FROM calendar_sync s`,
    )
    .all<SyncCalendarRow>();
  return results;
}

/** Исходы и классы ошибок синка за сутки (errorClass — без текста ответа): сколько календарей. */
export async function syncErrorClasses(db: D1Database, now: number): Promise<{ outcome: string; error: string; n: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT coalesce(last_outcome, '—') outcome, coalesce(last_error, '—') error, count(*) n
       FROM calendar_sync WHERE last_error_at > ? GROUP BY outcome, error ORDER BY n DESC`,
    )
    .bind(now - DAY_MS)
    .all<{ outcome: string; error: string; n: number }>();
  return results;
}

export interface KindStats {
  kind: string;
  pending: number;
  /** pending с last_error — ждут повтора. */
  retrying: number;
  /** Наступили за сутки: выполнены (done, включая тихие пропуски) / упали / сняты. */
  done_day: number;
  failed_day: number;
  cancelled_day: number;
}

/** Задачи синка, продления каналов, отправки уведомлений и напоминаний — по виду. */
export async function jobKindStats(db: D1Database, now: number, kinds: string[]): Promise<KindStats[]> {
  const { results } = await db
    .prepare(
      `SELECT kind, coalesce(sum(status = 'pending'), 0) pending, coalesce(sum(status = 'pending' AND last_error IS NOT NULL), 0) retrying,
              coalesce(sum(status = 'done' AND fire_at > ?1 AND fire_at <= ?2), 0) done_day,
              coalesce(sum(status = 'failed' AND coalesce(queued_at, fire_at) > ?1), 0) failed_day,
              coalesce(sum(status = 'cancelled' AND fire_at > ?1 AND fire_at <= ?2), 0) cancelled_day
       FROM scheduled_jobs WHERE kind IN (SELECT value FROM json_each(?3)) GROUP BY kind ORDER BY kind`,
    )
    .bind(now - DAY_MS, now, JSON.stringify(kinds))
    .all<KindStats>();
  return results;
}

export interface NoticeStats {
  /** Ждут конца тихих часов. */
  quiet: number;
  /** queued, срок наступил больше 10 минут назад — отправка не прошла. */
  overdue: number;
  oldestOverdueAt: number | null;
  sending: number;
  sentDay: number;
  createdDay: number;
}

export async function noticeStats(db: D1Database, now: number): Promise<NoticeStats> {
  const r = await db
    .prepare(
      `SELECT coalesce(sum(status = 'queued' AND deliver_at > ?1), 0) quiet,
              coalesce(sum(status = 'queued' AND deliver_at <= ?2), 0) overdue,
              min(CASE WHEN status = 'queued' AND deliver_at <= ?2 THEN deliver_at END) oldest_overdue,
              coalesce(sum(status = 'sending'), 0) sending,
              coalesce(sum(status = 'sent' AND sent_at > ?3), 0) sent_day,
              coalesce(sum(created_at > ?3), 0) created_day
       FROM change_notices`,
    )
    .bind(now, now - 10 * MIN_MS, now - DAY_MS)
    .first<{ quiet: number; overdue: number; oldest_overdue: number | null; sending: number; sent_day: number; created_day: number }>();
  return {
    quiet: r?.quiet ?? 0,
    overdue: r?.overdue ?? 0,
    oldestOverdueAt: r?.oldest_overdue ?? null,
    sending: r?.sending ?? 0,
    sentDay: r?.sent_day ?? 0,
    createdDay: r?.created_day ?? 0,
  };
}

/** Пользователи с включёнными напоминаниями в Telegram (US-71). */
export async function reminderUsersCount(db: D1Database): Promise<number> {
  const r = await db
    .prepare("SELECT count(*) n FROM users WHERE json_valid(settings_json) AND coalesce(settings_json ->> '$.tgReminderMin', 0) > 0")
    .first<{ n: number }>();
  return r?.n ?? 0;
}

// --- Дома (итерация 3) ------------------------------------------------------------------------------------
// Название дома, имена и другие имена участников, имена детей и коды приглашений не выбираются никогда.

export interface HouseholdRow {
  id: string;
  owner_user_id: string;
  created_at: number;
  members: number;
  with_google: number;
  dependents: number;
  group_chats: number;
  calendars: number;
  invites_active: number;
}

const HOUSEHOLD_COLUMNS = `h.id, h.owner_user_id, h.created_at,
  (SELECT count(*) FROM household_members m WHERE m.household_id = h.id) members,
  (SELECT count(*) FROM household_members m WHERE m.household_id = h.id
     AND EXISTS (SELECT 1 FROM provider_accounts a WHERE a.user_id = m.user_id AND a.provider = 'google')) with_google,
  (SELECT count(*) FROM dependents d WHERE d.household_id = h.id) dependents,
  (SELECT count(*) FROM conversations c WHERE c.household_id = h.id AND c.kind = 'group') group_chats,
  (SELECT count(*) FROM household_calendars hc WHERE hc.household_id = h.id) calendars,
  (SELECT count(*) FROM household_invites i WHERE i.household_id = h.id AND i.used_at IS NULL AND i.expires_at > ?1) invites_active`;

export async function households(db: D1Database, now: number, limit = 200): Promise<HouseholdRow[]> {
  const { results } = await db
    .prepare(`SELECT ${HOUSEHOLD_COLUMNS} FROM households h ORDER BY h.created_at DESC LIMIT ?2`)
    .bind(now, limit)
    .all<HouseholdRow>();
  return results;
}

export async function household(db: D1Database, id: string, now: number): Promise<HouseholdRow | null> {
  return db.prepare(`SELECT ${HOUSEHOLD_COLUMNS} FROM households h WHERE h.id = ?2`).bind(now, id).first<HouseholdRow>();
}

export interface HouseholdMemberRow {
  user_id: string;
  role: string;
  joined_at: number;
  has_google: number;
}

export async function householdMembers(db: D1Database, householdId: string): Promise<HouseholdMemberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.user_id, m.role, m.joined_at,
              EXISTS (SELECT 1 FROM provider_accounts a WHERE a.user_id = m.user_id AND a.provider = 'google') has_google
       FROM household_members m WHERE m.household_id = ? ORDER BY m.role = 'owner' DESC, m.joined_at`,
    )
    .bind(householdId)
    .all<HouseholdMemberRow>();
  return results;
}

export interface InviteCounts {
  active: number;
  used: number;
  expired: number;
}

/** Приглашения — только счётчики: код и есть доступ в дом. */
export async function householdInvites(db: D1Database, householdId: string, now: number): Promise<InviteCounts> {
  const r = await db
    .prepare(
      `SELECT coalesce(sum(used_at IS NULL AND expires_at > ?2), 0) active, coalesce(sum(used_at IS NOT NULL), 0) used,
              coalesce(sum(used_at IS NULL AND expires_at <= ?2), 0) expired
       FROM household_invites WHERE household_id = ?1`,
    )
    .bind(householdId, now)
    .first<InviteCounts>();
  return r ?? { active: 0, used: 0, expired: 0 };
}

/** Привязанные групповые чаты: id чата — только для псевдонима, в HTML не попадает. */
export async function householdChats(db: D1Database, householdId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT chat_id FROM conversations WHERE household_id = ? AND kind = 'group' ORDER BY chat_id")
    .bind(householdId)
    .all<{ chat_id: string }>();
  return results.map((r) => r.chat_id);
}

// --- Контент → событие и inline (итерация 3) --------------------------------------------------------------

export interface SourceUsage {
  source: string;
  n: number;
  errors: number;
  cost: number;
}

/** Вызовы LLM по источнику (result_json.source: forward — пересланное, image — vision по фото) за 7 дней. */
export async function llmBySource(db: D1Database, now: number): Promise<SourceUsage[]> {
  const { results } = await db
    .prepare(
      `SELECT result_json ->> '$.source' source, count(*) n, coalesce(sum(outcome = 'error'), 0) errors, coalesce(sum(cost_micro_usd), 0) cost
       FROM usage_events
       WHERE kind = 'llm' AND created_at > ? AND json_valid(result_json) AND json_type(result_json) = 'object'
         AND result_json ->> '$.source' IS NOT NULL
       GROUP BY source ORDER BY source`,
    )
    .bind(now - 7 * DAY_MS)
    .all<SourceUsage>();
  return results;
}

export interface InlineStats {
  /** Карточки (inline_events), созданные за 7 дней; строки живут до expires_at — старше не видно. */
  cards7d: number;
  cardsStored: number;
  authors7d: number;
  adds7d: number;
  /** inline_adds хранятся 60 дней. */
  adds60d: number;
  adders60d: number;
}

export async function inlineStats(db: D1Database, now: number): Promise<InlineStats> {
  const [cards, adds] = await db.batch<{ a: number; b: number; c: number }>([
    db
      .prepare("SELECT coalesce(sum(created_at > ?1), 0) a, count(*) b, count(DISTINCT CASE WHEN created_at > ?1 THEN created_by_tg END) c FROM inline_events")
      .bind(now - 7 * DAY_MS),
    db.prepare("SELECT coalesce(sum(created_at > ?1), 0) a, count(*) b, count(DISTINCT telegram_id) c FROM inline_adds").bind(now - 7 * DAY_MS),
  ]);
  const c = cards?.results[0];
  const a = adds?.results[0];
  return { cards7d: c?.a ?? 0, cardsStored: c?.b ?? 0, authors7d: c?.c ?? 0, adds7d: a?.a ?? 0, adds60d: a?.b ?? 0, adders60d: a?.c ?? 0 };
}
