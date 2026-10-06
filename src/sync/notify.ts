// US-72: уведомления об изменениях в календаре во все чаты, где он виден, кроме чата-источника.
// Outbox change_notices: строки пишутся в одном batch со снимками (повтор синка не шлёт дважды и не теряет), затем
// чат «смывается»: наступившие уведомления — по одному или сводкой (пачка), в тихие часы — утренней задачей.

import type { AppContext } from "../bot/context";
import { t } from "../bot/messages";
import { chatsForCalendar, claimDueNotices, finishNotices, insertNotices, sentRecently, type CalendarChat, type NoticeRow } from "../db/sync";
import { log } from "../log";
import type { DueJob } from "../scheduler";
import {
  BATCH_WINDOW_MS,
  deliveryPlan,
  inNotifyWindow,
  MINUTE_MS,
  noticeText,
  quietUntil,
  summaryText,
  timeOf,
  type ChangeKind,
  type Notice,
  type Snapshot,
} from "./logic";

export const NOTIFY_FLUSH_JOB = "notify_flush";

/** Изменение события для рассылки. */
export interface Change {
  kind: ChangeKind;
  before: Snapshot | null;
  after: Snapshot | null;
  /** Сделано ботом: из какого чата (туда не шлём) и кто. Нет — внешнее изменение (во все чаты). */
  origin?: { chatId: string; authorName?: string };
}

/** Получатели: чаты календаря с включёнными уведомлениями, календарь в них на запись, кроме чата-источника. */
export function recipientsOf(chats: CalendarChat[], change: Pick<Change, "origin">): CalendarChat[] {
  return chats.filter((c) => c.writable && !c.settings.changeNotifyOff && c.chatId !== change.origin?.chatId);
}

function noticeFor(change: Change, chat: CalendarChat): Notice | null {
  const cur = change.kind === "cancelled" ? change.before : change.after;
  if (!cur) return null;
  return {
    kind: change.kind,
    title: cur.title,
    time: timeOf(cur),
    ...(change.kind === "moved" && change.before ? { before: timeOf(change.before) } : {}),
    ...(change.kind !== "cancelled" && cur.htmlLink ? { link: cur.htmlLink } : {}),
    ...(change.origin?.authorName ? { author: change.origin.authorName } : {}),
    ...(!change.origin && cur.organizer ? { organizer: cur.organizer } : {}),
    locale: chat.locale,
    tz: chat.tz,
  };
}

/**
 * Строки outbox для изменений календаря (в batch со снимками) и чаты, которые смыть после записи.
 * Окно 30 дней — по времени события; тихие часы — по поясу получателя: тогда — задача на 08:00.
 */
export function noticeStatements(
  db: D1Database,
  chats: CalendarChat[],
  changes: Change[],
  now: number,
): { stmts: D1PreparedStatement[]; flushNow: Set<string> } {
  const stmts: D1PreparedStatement[] = [];
  const rows: NoticeRow[] = [];
  const flushNow = new Set<string>();
  for (const change of changes) {
    const times = [change.before, change.after].filter((s): s is Snapshot => !!s).map(timeOf);
    if (!inNotifyWindow(times, now)) continue;
    for (const chat of recipientsOf(chats, change)) {
      const notice = noticeFor(change, chat);
      if (!notice) continue;
      const quiet = quietUntil(now, chat.tz);
      const deliverAt = quiet ?? now;
      rows.push({ chatId: chat.chatId, userId: chat.userId, noticeJson: JSON.stringify(notice), deliverAt });
      if (quiet === null) flushNow.add(chat.chatId);
      else if (!rows.some((r, i) => i < rows.length - 1 && r.chatId === chat.chatId && r.deliverAt === deliverAt))
        stmts.push(flushJob(db, chat.chatId, deliverAt));
    }
  }
  return { stmts: [...insertNotices(db, rows, now), ...stmts], flushNow };
}

function flushJob(db: D1Database, chatId: string, at: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO scheduled_jobs (id, kind, user_id, fire_at, payload_json, status, dedupe_key)
       VALUES (?, ?, NULL, ?, ?, 'pending', ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(crypto.randomUUID(), NOTIFY_FLUSH_JOB, at, JSON.stringify({ chatId }), `${NOTIFY_FLUSH_JOB}:${chatId}:${at}`);
}

/**
 * Отправить наступившие уведомления чата: по одному или сводкой (пачка, US-72). Не отправилось — вернуть в очередь
 * и повторить через минуту задачей (ошибку не пробрасываем: синк, который их записал, уже завершён).
 */
export async function flushChat(ctx: AppContext, chatId: string): Promise<void> {
  const now = ctx.clock.now();
  const claimed = await claimDueNotices(ctx.db, chatId, now);
  if (claimed.length === 0) return;
  const all = claimed.map((r) => ({ id: r.id, notice: JSON.parse(r.notice_json) as Notice }));
  // Копились до утра — о прошедшем уже не сообщаем
  const due = all.filter((x) => inNotifyWindow([x.notice.time, ...(x.notice.before ? [x.notice.before] : [])], now));
  const stale = all.filter((x) => !due.includes(x)).map((x) => x.id);
  await finishNotices(ctx.db, stale, "sent", now);
  if (due.length === 0) return;
  const plan = deliveryPlan(due.length, await sentRecently(ctx.db, chatId, now - BATCH_WINDOW_MS));
  const done: string[] = [];
  try {
    if (plan === "summary") {
      await ctx.telegram.sendMessage(
        Number(chatId),
        summaryText(
          due.map((x) => x.notice),
          now,
        ),
        undefined,
        { html: true },
      );
      done.push(...due.map((x) => x.id));
    } else {
      for (const x of due) {
        const n = x.notice;
        const markup = n.link ? { inline_keyboard: [[{ text: t("openInCalendar", n.locale), url: n.link }]] } : undefined;
        await ctx.telegram.sendMessage(Number(chatId), noticeText(n, now), markup, { html: true });
        done.push(x.id);
      }
    }
    log("change_notice", { sent: due.length, plan });
  } catch (e) {
    console.error("change notice send failed", e instanceof Error ? e.message : e);
    await finishNotices(
      ctx.db,
      due.map((x) => x.id).filter((id) => !done.includes(id)),
      "queued",
      now,
    );
    await flushJob(ctx.db, chatId, now + MINUTE_MS).run();
  } finally {
    await finishNotices(ctx.db, done, "sent", now);
  }
}

/** Задача «смыть чат»: утро после тихих часов или повтор после сбоя отправки. */
export async function runNotifyFlushJob(ctx: AppContext, job: DueJob): Promise<void> {
  const { chatId } = JSON.parse(job.payload_json) as { chatId: string };
  await flushChat(ctx, chatId);
}

/** Записать уведомления об изменениях календаря и сразу отправить те, что не попали в тихие часы. */
export async function notifyChanges(
  ctx: AppContext,
  pcid: string,
  changes: Change[],
  extra: D1PreparedStatement[] = [],
  known?: CalendarChat[],
): Promise<void> {
  const chats = changes.length ? (known ?? (await chatsForCalendar(ctx.db, pcid))) : [];
  const { stmts, flushNow } = noticeStatements(ctx.db, chats, changes, ctx.clock.now());
  const all = [...extra, ...stmts];
  if (all.length) await ctx.db.batch(all);
  for (const chatId of flushNow) await flushChat(ctx, chatId);
}
