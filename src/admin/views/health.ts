// Панель «здоровье» — главная страница админки: всё ли живо за 10 секунд (docs/admin-console.md #1).
// Пороги — общие с алертами владельцу (src/ops/alert-rules.ts): светофор и алерт краснеют одинаково.

import type { DigestDelivery, InboxFailure, InboxHealth, JobsGroup, JobsLag, OpsValue, ProblemJob, Totals, UpdatesDay } from "../queries";
import type { WebhookStatus } from "../webhook";
import { INBOX_FAILED_HOUR, INBOX_STUCK_MS, JOBS_OVERDUE_MS, WEBHOOK_ERROR_WINDOW_MS, WEBHOOK_PENDING_MAX } from "../../ops/alert-rules";
import { badge, esc, fmtAge, fmtTime, type Level, raw, table } from "./layout";

const MIN_MS = 60_000;

export interface HealthView {
  now: number;
  expectedWebhookUrl: string;
  webhook: WebhookStatus;
  inbox: InboxHealth;
  inboxFailures: (InboxFailure & { maskedError: string })[];
  jobs: JobsGroup[];
  lag: JobsLag;
  problems: (ProblemJob & { user: string; maskedError: string })[];
  digests: DigestDelivery;
  lastTick?: OpsValue;
  lastHourly?: OpsValue;
  totals: Totals;
  byDay: UpdatesDay[];
}

export function webhookLevel(v: HealthView): Level {
  if (!v.webhook.ok) return "unknown";
  const i = v.webhook.info;
  if (i.url !== v.expectedWebhookUrl) return "crit";
  if (i.last_error_date && v.now - i.last_error_date * 1000 < WEBHOOK_ERROR_WINDOW_MS) return "crit";
  if (i.pending_update_count > WEBHOOK_PENDING_MAX) return "crit";
  if (i.pending_update_count > 0 || i.last_error_date) return "warn";
  return "ok";
}

export function inboxLevel(i: InboxHealth, now: number): Level {
  if (i.oldestOpenAt && now - i.oldestOpenAt > INBOX_STUCK_MS) return "crit";
  if (i.failedHour >= INBOX_FAILED_HOUR) return "crit";
  if (i.failedDay > 0) return "warn";
  return "ok";
}

export function jobsLevel(l: JobsLag, now: number): Level {
  if (l.oldestOverdueAt && now - l.oldestOverdueAt > JOBS_OVERDUE_MS) return "crit";
  if (l.overdue > 0 || l.stuck > 0 || l.failedDay > 0) return "warn";
  return "ok";
}

export function cronLevel(lastTick: OpsValue | undefined, now: number): Level {
  if (!lastTick) return "unknown";
  return now - lastTick.updated_at > 3 * MIN_MS ? "crit" : "ok";
}

export function digestLevel(d: DigestDelivery): Level {
  return (d.fired.failed ?? 0) > 0 ? "warn" : "ok";
}

function webhookSection(v: HealthView): string {
  if (!v.webhook.ok) return `<p class="err">Не удалось получить состояние: ${esc(v.webhook.error)}</p>`;
  const i = v.webhook.info;
  const rows: unknown[][] = [
    [
      "URL",
      raw(
        `<code>${esc(i.url || "(не установлен)")}</code>${i.url === v.expectedWebhookUrl ? "" : ` <span class="err">≠ ожидаемого ${esc(v.expectedWebhookUrl)}</span>`}`,
      ),
    ],
    ["Ожидают доставки (pending_update_count)", i.pending_update_count],
    [
      "Последняя ошибка",
      i.last_error_date ? `${fmtTime(i.last_error_date * 1000)} (${fmtAge(i.last_error_date * 1000, v.now)}): ${i.last_error_message ?? ""}` : "нет",
    ],
  ];
  if (i.max_connections) rows.push(["max_connections", i.max_connections]);
  return `${table(["", ""], rows)}<p class="muted">getWebhookInfo: ${v.webhook.cached ? "из кеша" : "запрошено"} ${fmtAge(v.webhook.fetchedAt, v.now)} (кеш 1 мин)</p>`;
}

export function healthBody(v: HealthView): string {
  const levels: [string, Level, string][] = [
    ["Webhook Telegram", webhookLevel(v), "#webhook"],
    ["Inbox апдейтов", inboxLevel(v.inbox, v.now), "#inbox"],
    ["Задачи планировщика", jobsLevel(v.lag, v.now), "#jobs"],
    ["Дайджесты", digestLevel(v.digests), "#digests"],
    ["Cron", cronLevel(v.lastTick, v.now), "#cron"],
  ];
  const i = v.inbox;
  const jobsTable = table(
    ["Вид", "Статус", "Задач", "Самый ранний fire_at"],
    v.jobs.map((j) => [j.kind, j.status, j.n, fmtTime(j.oldest_fire_at)]),
  );
  const d = v.digests;
  const firedTotal = Object.values(d.fired).reduce((a, b) => a + b, 0);
  return `<h1>Здоровье</h1>
<div class="cards">${levels.map(([name, level, href]) => `<div class="card"><a href="${href}">${esc(name)}</a><br>${badge(level)}</div>`).join("")}</div>

<h2 id="webhook">Webhook Telegram ${badge(levels[0]![1])}</h2>
${webhookSection(v)}

<h2 id="inbox">Inbox апдейтов ${badge(levels[1]![1])}</h2>
<div class="cards">
  <div class="card">В очереди (pending)<b>${i.pending}</b></div>
  <div class="card">Обрабатываются<b>${i.processing}</b></div>
  <div class="card">Самый старый открытый<b>${i.oldestOpenAt ? esc(fmtAge(i.oldestOpenAt, v.now)) : "—"}</b></div>
  <div class="card">Получено за час / сутки<b>${i.receivedHour} / ${i.receivedDay}</b></div>
  <div class="card">Ошибок за час / сутки<b class="${i.failedDay ? "err" : ""}">${i.failedHour} / ${i.failedDay}</b></div>
  <div class="card">С повтором за сутки<b>${i.retriedDay}</b></div>
</div>
<h2>Ошибки обработки (последние 10, тексты замаскированы)</h2>
${table(
  ["Время", "update_id", "Попыток", "Ошибка"],
  v.inboxFailures.map((f) => [fmtTime(f.received_at), f.update_id, f.attempts, raw(`<code class="err">${esc(f.maskedError)}</code>`)]),
  "ошибок нет",
)}

<h2 id="jobs">Задачи планировщика ${badge(levels[2]![1])}</h2>
<div class="cards">
  <div class="card">Просрочены (pending, fire_at &gt; 2 мин назад)<b>${v.lag.overdue}</b></div>
  <div class="card">Самая старая просроченная<b>${v.lag.oldestOverdueAt ? esc(fmtAge(v.lag.oldestOverdueAt, v.now)) : "—"}</b></div>
  <div class="card">Зависли в queued/running<b>${v.lag.stuck}</b></div>
  <div class="card">Failed за сутки<b class="${v.lag.failedDay ? "err" : ""}">${v.lag.failedDay}</b></div>
</div>
${jobsTable}
<h2>Задачи с ошибкой (failed и ждущие повтора)</h2>
${table(
  ["fire_at", "Вид", "Статус", "Пользователь", "Попыток", "last_error"],
  v.problems.map((p) => [fmtTime(p.fire_at), p.kind, p.status, p.user, p.attempts, raw(`<code class="err">${esc(p.maskedError)}</code>`)]),
  "нет",
)}

<h2 id="digests">Дайджесты ${badge(levels[3]![1])}</h2>
${table(
  ["За последние 24 ч", "Задач"],
  [...Object.entries(d.fired).map(([status, n]) => [status, n]), ["всего наступило", firedTotal], ["запланировано на ближайшие 24 ч", d.upcoming]],
)}
<p class="muted">done = выполнено, включая пропуски (опоздание &gt; 3 ч, нет чата, отозван доступ): исход отдельно не пишется — scheduled_jobs.outcome в планах беты.</p>

<h2 id="cron">Cron ${badge(levels[4]![1])}</h2>
${table(
  ["", "Когда"],
  [
    ["Последний прогон (раз в минуту)", v.lastTick ? `${fmtTime(v.lastTick.updated_at)} · ${fmtAge(v.lastTick.updated_at, v.now)}` : "нет данных"],
    [
      "Часовые работы (ретеншн, страховка дайджестов)",
      v.lastHourly ? `${fmtTime(v.lastHourly.updated_at)} · ${fmtAge(v.lastHourly.updated_at, v.now)}` : "нет данных",
    ],
  ],
)}

<h2>Объём</h2>
<div class="cards">
  <div class="card">Пользователи<b>${v.totals.users}</b></div>
  <div class="card">Google-аккаунты<b>${v.totals.accounts}</b></div>
  <div class="card">Календари<b>${v.totals.calendars}</b></div>
</div>
<h2>Апдейты по дням (7 дней)</h2>
${table(
  ["День (UTC)", "Апдейтов", "Ошибок", "Задержка обработки, ср.", "макс."],
  v.byDay.map((r) => [r.day, r.n, r.failed, r.lag_ms === null ? "—" : `${r.lag_ms} мс`, r.max_lag_ms === null ? "—" : `${r.max_lag_ms} мс`]),
)}`;
}
