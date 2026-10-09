// Правила алертов владельцу (docs/admin-console.md, «Правила алертов»; tech-debt #7) — чистые функции:
// счётчики → «горит / не горит» → что отправить с учётом alert_state. Пороги — общие с панелью «здоровье».
// В текстах только счётчики и ключи: ни текстов пользователей, ни имён, ни id.

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

// --- Пороги (их же использует светофор в src/admin/views/health.ts) ---------------------------------------

/** Ошибка доставки webhook свежее этого — webhook нездоров. */
export const WEBHOOK_ERROR_WINDOW_MS = 10 * MIN_MS;
/** Telegram копит больше апдейтов — мы их не принимаем. */
export const WEBHOOK_PENDING_MAX = 20;
/** Апдейт в pending/processing дольше — завис. */
export const INBOX_STUCK_MS = 2 * MIN_MS;
/** Столько failed-апдейтов за час — алерт. */
export const INBOX_FAILED_HOUR = 3;
/** pending-задача с fire_at старше — cron/очередь не раздают. */
export const JOBS_OVERDUE_MS = 5 * MIN_MS;
/** Окно для ошибок LLM/STT. */
export const AI_WINDOW_MS = 15 * MIN_MS;
/** Ошибок цепочки провайдеров за окно — не меньше этого и не меньше AI_ERROR_RATE от всех вызовов. */
export const AI_ERRORS_MIN = 3;
export const AI_ERROR_RATE = 0.2;
/** Пока горит — напоминание не чаще. */
export const REMIND_MS = 3 * HOUR_MS;
/** Оценка правил в cron — раз в 5 минут. */
export const ALERT_EVERY_MIN = 5;

// --- Входные данные ------------------------------------------------------------------------------------

export interface AlertInputs {
  now: number;
  expectedWebhookUrl: string;
  /** getWebhookInfo; null — не удалось получить (правило не оценивается: сбой Telegram API ≠ сбой webhook). */
  webhook: { url: string; pending_update_count: number; last_error_date?: number } | null;
  inbox: { oldestOpenAt: number | null; pending: number; processing: number; failedHour: number };
  /** failedHour — failed за час, кроме дайджестов (у них своё правило). */
  jobs: { overdue: number; oldestOverdueAt: number | null; failedHour: number };
  /** Дайджесты, упавшие (failed) за последние сутки. */
  digestFailedDay: number;
  /** Вызовы цепочек LLM/STT за AI_WINDOW_MS: всего и с outcome = error. */
  ai: { calls: number; errors: number };
  /** Календари с получателями, не синхронизированные дольше порога режима (sync-health.ts: isSyncStale). */
  sync: { stale: number; oldestStaleAt: number | null };
  /** Квоты ниже порога (quota-rules.ts: lowQuotas) — «OpenRouter: 4 запр. из 50»; null — не удалось оценить. */
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
  /** null — не удалось оценить: состояние не меняем. */
  firing: boolean | null;
  /** Короткая сводка счётчиков для сообщения (без пользовательских данных). */
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

  // Пороги — в sync-health.ts (с push сверка раз в сутки, без — опрос); счётчик уже посчитан по ним
  const { stale, oldestStaleAt } = i.sync;
  out.push({
    key: "sync_stale",
    firing: stale > 0,
    detail: `устарели: ${stale}${oldestStaleAt === null ? "" : `, старейший синк ${duration(now - oldestStaleAt)} назад`}`,
  });

  // Пороги — в quota-rules.ts: OpenRouter бесплатных < 10, DeepSeek < $1, Workers AI > 80% (оценка или GraphQL)
  const q = i.quotaLow;
  out.push({ key: "quota_low", firing: q === null ? null : q.length > 0, detail: q === null ? "квоты не оценены" : q.join("; ") || "всё в норме" });
  return out;
}

// --- Дедупликация (alert_state) ------------------------------------------------------------------------

export interface AlertState {
  key: string;
  status: "firing" | "ok";
  /** Когда начался текущий статус. */
  since: number;
  last_sent_at: number | null;
}

export type AlertAction = "fire" | "remind" | "resolve";

/**
 * Начал гореть → «fire»; горит дальше → «remind» не чаще REMIND_MS; погас → «resolve». Иначе ничего.
 * next — новое состояние; сохранять его только после успешной отправки (иначе повторим через 5 минут).
 */
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

/** Текст алерта владельцу: заголовок, счётчики, ссылка на /admin. Без HTML. */
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

/** Cron раз в минуту; правила — раз в ALERT_EVERY_MIN минут. */
export const isAlertMinute = (now: number) => new Date(now).getUTCMinutes() % ALERT_EVERY_MIN === 0;
