// Только счётчики и классы ошибок: ни id календарей (почта), ни названий событий, ни текстов уведомлений.

import type { KindStats, NoticeStats } from "../queries";
import { CHANNEL_EXPIRING_MS, SYNC_STALE_POLL_MS, SYNC_STALE_PUSH_MS, type SyncSummary, syncLevel } from "../../ops/sync-health";
import { badge, esc, fmtAge, raw, table } from "./layout";

const HOUR_MS = 3_600_000;

export const SYNC_JOB_LABELS: Record<string, string> = {
  cal_sync: "плановый синк (сверка / опрос)",
  cal_push: "синк по push",
  watch_renew: "продление канала push",
  notify_flush: "отправка уведомлений (после тихих часов)",
  tg_reminder: "напоминания в Telegram",
};

export interface SyncView {
  now: number;
  pushEnabled: boolean;
  summary: SyncSummary;
  errors: { outcome: string; error: string; n: number }[];
  jobs: KindStats[];
  notices: NoticeStats;
  reminderUsers: number;
}

export const failedDay = (jobs: KindStats[]) => jobs.reduce((a, j) => a + j.failed_day, 0);

const hours = (ms: number) => `${Math.round(ms / HOUR_MS)} ч`;

export function syncBody(v: SyncView): string {
  const s = v.summary;
  const n = v.notices;
  const level = syncLevel(s, n.overdue, failedDay(v.jobs));
  const rem = v.jobs.find((j) => j.kind === "tg_reminder");
  const flush = v.jobs.find((j) => j.kind === "notify_flush");
  return `<h1>Синхронизация ${badge(level)}</h1>
<p class="muted">Подписка — одна на календарь Google (ADR-0005 §2). Устарел: календарь виден в чатах, а синка не было дольше ${hours(SYNC_STALE_PUSH_MS)} с push (сверка раз в сутки) или ${hours(SYNC_STALE_POLL_MS)} без push — те же пороги у алерта «синхронизация календарей». Доступ отозван / календарь удалён — «недоступен», в алерт не идёт. Push ${v.pushEnabled ? "включён" : "выключен (GOOGLE_PUSH_ENABLED)"}.</p>
<div class="cards">
  <div class="card">Календарей под синком<b>${s.total}</b></div>
  <div class="card">Push / опрос<b>${s.push} / ${s.poll}</b></div>
  <div class="card">Устарели<b class="${s.stale ? "err" : ""}">${s.stale}</b></div>
  <div class="card">Старейший синк${s.stale ? " (устаревших)" : ""}<b>${esc(fmtAge(s.oldestStaleAt ?? s.oldestSyncAt, v.now))}</b></div>
  <div class="card">Ещё не синхронизированы<b>${s.neverSynced}</b></div>
  <div class="card">Недоступны<b>${s.unavailable}</b></div>
  <div class="card">Последняя попытка — ошибка<b class="${s.failing ? "err" : ""}">${s.failing}</b></div>
  <div class="card">С ошибкой за 24 ч<b>${s.errorsDay}</b></div>
  <div class="card">Пересинхронизация (410) за 24 ч<b>${s.resyncsDay}</b></div>
  <div class="card">Каналы истекают (&lt; ${hours(CHANNEL_EXPIRING_MS)})<b class="${s.channelsExpiring ? "err" : ""}">${s.channelsExpiring}</b></div>
</div>
<h2>Ошибки синка за 24 ч (календарей)</h2>
${table(
  ["Исход", "Класс ошибки", "Календарей"],
  v.errors.map((e) => [e.outcome, raw(`<code>${esc(e.error)}</code>`), e.n]),
  "ошибок нет",
)}
<h2>Задачи</h2>
${table(
  ["Вид", "", "Ждут", "Повтор после ошибки", "Выполнены за 24 ч", "Упали за 24 ч", "Сняты за 24 ч"],
  v.jobs.map((j) => [
    j.kind,
    SYNC_JOB_LABELS[j.kind] ?? "",
    j.pending,
    j.retrying,
    j.done_day,
    raw(`<span class="${j.failed_day ? "err" : ""}">${j.failed_day}</span>`),
    j.cancelled_day,
  ]),
  "задач нет",
)}

<h2 id="notices">Уведомления об изменениях (US-72)</h2>
<div class="cards">
  <div class="card">Ждут конца тихих часов<b>${n.quiet}</b></div>
  <div class="card">Просрочены (&gt; 10 мин)<b class="${n.overdue ? "err" : ""}">${n.overdue}</b></div>
  <div class="card">Старейшее просроченное<b>${esc(fmtAge(n.oldestOverdueAt, v.now))}</b></div>
  <div class="card">Отправляются<b>${n.sending}</b></div>
  <div class="card">Создано / отправлено за 24 ч<b>${n.createdDay} / ${n.sentDay}</b></div>
  <div class="card">Отправка упала за 24 ч<b class="${flush?.failed_day ? "err" : ""}">${flush?.failed_day ?? 0}</b></div>
</div>
<p class="muted">Строка outbox — на чат и изменение; несколько изменений уходят одним сводным сообщением. Отправленные хранятся 2 дня.</p>

<h2 id="reminders">Напоминания в Telegram (US-71)</h2>
<div class="cards">
  <div class="card">Пользователей с напоминаниями<b>${v.reminderUsers}</b></div>
  <div class="card">Запланировано<b>${rem?.pending ?? 0}</b></div>
  <div class="card">Сработали за 24 ч<b>${rem?.done_day ?? 0}</b></div>
  <div class="card">Упали за 24 ч<b class="${rem?.failed_day ? "err" : ""}">${rem?.failed_day ?? 0}</b></div>
  <div class="card">Сняты за 24 ч (перенос, удаление)<b>${rem?.cancelled_day ?? 0}</b></div>
</div>
<p class="muted">«Сработали» — выполненные задачи, включая тихие пропуски (событие сдвинулось, встреча уже началась, настройку выключили).</p>`;
}
