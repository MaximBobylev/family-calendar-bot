// Пороги общие со светофором src/admin/views/health.ts. В текстах алертов — только счётчики и ключи: ни текстов
// пользователей, ни имён, ни id.

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

export const WEBHOOK_ERROR_WINDOW_MS = 10 * MIN_MS;
export const WEBHOOK_PENDING_MAX = 20;
export const INBOX_STUCK_MS = 2 * MIN_MS;
export const INBOX_FAILED_HOUR = 3;
export const JOBS_OVERDUE_MS = 5 * MIN_MS;
export const AI_WINDOW_MS = 15 * MIN_MS;
export const AI_ERRORS_MIN = 3;
export const AI_ERROR_RATE = 0.2;
export const REMIND_MS = 3 * HOUR_MS;
export const ALERT_EVERY_MIN = 5;

export interface AlertInputs {
  now: number;
  expectedWebhookUrl: string;
  // null — getWebhookInfo не ответил: правило не оцениваем, сбой Telegram API ≠ сбой webhook
  webhook: { url: string; pending_update_count: number; last_error_date?: number } | null;
  inbox: { oldestOpenAt: number | null; pending: number; processing: number; failedHour: number };
  // failedHour — без дайджестов: у них своё правило
  jobs: { overdue: number; oldestOverdueAt: number | null; failedHour: number };
  digestFailedDay: number;
  ai: { calls: number; errors: number };
  sync: { stale: number; oldestStaleAt: number | null };
  quotaLow: string[] | null;
}

export const ALERT_KEYS = ["webhook", "inbox_stuck", "inbox_failed", "jobs", "digest_failed", "ai_errors", "sync_stale", "quota_low"] as const;
export type AlertKey = (typeof ALERT_KEYS)[number];

export const ALERT_TITLES: Record<AlertKey, string> = {
  webhook: "webhook Telegram",
  inbox_stuck: "апдейты зависли",
  inbox_failed: "апдейты падают",
  jobs: "задачи планировщика",
  digest_failed: "дайджесты не доставлены",
  ai_errors: "ошибки LLM/STT",
  sync_stale: "синхронизация календарей",
  quota_low: "квоты провайдеров на исходе",
};

export interface RuleResult {
  key: AlertKey;
  // null — не удалось оценить: состояние алерта не меняем
  firing: boolean | null;
  detail: string;
}

const minutes = (ms: number) => Math.max(0, Math.round(ms / MIN_MS));

export function evaluateRules(i: AlertInputs): RuleResult[] {
  const { now } = i;
  const out: RuleResult[] = [];

  const w = i.webhook;
  if (!w) out.push({ key: "webhook", firing: null, detail: "getWebhookInfo недоступен" });
  else {
    const reasons: string[] = [];
    if (w.url !== i.expectedWebhookUrl) reasons.push(w.url ? "URL не совпадает" : "URL не установлен");
    if (w.last_error_date && now - w.last_error_date * 1000 < WEBHOOK_ERROR_WINDOW_MS)
      reasons.push(`ошибка доставки ${minutes(now - w.last_error_date * 1000)} мин назад`);
    if (w.pending_update_count > WEBHOOK_PENDING_MAX) reasons.push(`в очереди Telegram ${w.pending_update_count}`);
    out.push({ key: "webhook", firing: reasons.length > 0, detail: reasons.join("; ") || `в очереди Telegram ${w.pending_update_count}` });
  }

  const stuckMs = i.inbox.oldestOpenAt === null ? 0 : now - i.inbox.oldestOpenAt;
  out.push({
    key: "inbox_stuck",
    firing: stuckMs > INBOX_STUCK_MS,
    detail: `не обработано: ${i.inbox.pending + i.inbox.processing}, старейшему ${minutes(stuckMs)} мин`,
  });

  out.push({ key: "inbox_failed", firing: i.inbox.failedHour >= INBOX_FAILED_HOUR, detail: `failed за час: ${i.inbox.failedHour}` });

  const overdueMs = i.jobs.oldestOverdueAt === null ? 0 : now - i.jobs.oldestOverdueAt;
  out.push({
    key: "jobs",
    firing: i.jobs.failedHour > 0 || overdueMs > JOBS_OVERDUE_MS,
    detail: `failed за час: ${i.jobs.failedHour}; просрочено: ${i.jobs.overdue}${i.jobs.overdue ? `, старейшая ${minutes(overdueMs)} мин` : ""}`,
  });

  out.push({ key: "digest_failed", firing: i.digestFailedDay > 0, detail: `не доставлено за сутки: ${i.digestFailedDay}` });

  const { calls, errors } = i.ai;
  out.push({
    key: "ai_errors",
    firing: errors >= AI_ERRORS_MIN && errors >= calls * AI_ERROR_RATE,
    detail: `ошибок ${errors} из ${calls} за ${minutes(AI_WINDOW_MS)} мин`,
  });

  const { stale, oldestStaleAt } = i.sync;
  out.push({
    key: "sync_stale",
    firing: stale > 0,
    detail: `устарели: ${stale}${oldestStaleAt === null ? "" : `, старейший синк ${duration(now - oldestStaleAt)} назад`}`,
  });

  const q = i.quotaLow;
  out.push({ key: "quota_low", firing: q === null ? null : q.length > 0, detail: q === null ? "квоты не оценены" : q.join("; ") || "всё в норме" });
  return out;
}

export interface AlertState {
  key: string;
  status: "firing" | "ok";
  since: number;
  last_sent_at: number | null;
}

export type AlertAction = "fire" | "remind" | "resolve";

// next сохранять только после успешной отправки: не дошло — повторим на следующей оценке.
export function decide(prev: AlertState | undefined, r: RuleResult, now: number): { action: AlertAction; next: AlertState } | null {
  if (r.firing === null) return null;
  const wasFiring = prev?.status === "firing";
  if (r.firing && !wasFiring) return { action: "fire", next: { key: r.key, status: "firing", since: now, last_sent_at: now } };
  if (r.firing && prev && now - (prev.last_sent_at ?? prev.since) >= REMIND_MS) return { action: "remind", next: { ...prev, last_sent_at: now } };
  if (!r.firing && wasFiring) return { action: "resolve", next: { key: r.key, status: "ok", since: now, last_sent_at: now } };
  return null;
}

function duration(ms: number): string {
  const m = minutes(ms);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
}

export function alertText(action: AlertAction, r: RuleResult, prev: AlertState | undefined, now: number, adminUrl: string): string {
  const title = ALERT_TITLES[r.key];
  const head =
    action === "fire"
      ? `🔴 Алерт: ${title}`
      : action === "remind"
        ? `🔴 Всё ещё: ${title} (уже ${duration(now - (prev?.since ?? now))})`
        : `✅ Восстановлено: ${title} (было ${duration(now - (prev?.since ?? now))})`;
  return `${head}\n${r.detail}\n${adminUrl}`;
}

export const isAlertMinute = (now: number) => new Date(now).getUTCMinutes() % ALERT_EVERY_MIN === 0;
