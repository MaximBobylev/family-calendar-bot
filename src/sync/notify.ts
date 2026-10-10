// Outbox change_notices пишется в одном batch со снимками — повтор синка не шлёт дважды и не теряет; затем чат
// «смывается»: по одному или сводкой, в тихие часы — утренней задачей.

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

export interface Change {
  kind: ChangeKind;
  before: Snapshot | null;
  after: Snapshot | null;
  origin?: { chatId: string; authorName?: string; authorUserId?: string };
}

// Автору правки и в личный чат эхо не нужно: сделал в семейном — сам знает.
export function recipientsOf(chats: CalendarChat[], change: Pick<Change, "origin">): CalendarChat[] {
  const o = change.origin;
  return chats.filter((c) => c.writable && !c.settings.changeNotifyOff && c.chatId !== o?.chatId && !(o?.authorUserId && c.userId === o.authorUserId));
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

export function noticeStatements(
  db: D1Database,
  pcid: string,
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
    const ev = change.after ?? change.before;
    const guard = ev ? { pcid, eventId: ev.eventId, exists: !!change.before, etag: change.before?.etag ?? null } : undefined;
    for (const chat of recipientsOf(chats, change)) {
      const notice = noticeFor(change, chat);
      if (!notice) continue;
      const quiet = quietUntil(now, chat.tz);
      const deliverAt = quiet ?? now;
      rows.push({ chatId: chat.chatId, userId: chat.userId, noticeJson: JSON.stringify(notice), deliverAt, ...(guard ? { guard } : {}) });
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

// Ошибку отправки не пробрасываем: синк, записавший уведомления, уже завершён — повтор делает задача.
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

export async function runNotifyFlushJob(ctx: AppContext, job: DueJob): Promise<void> {
  const { chatId } = JSON.parse(job.payload_json) as { chatId: string };
  await flushChat(ctx, chatId);
}

// Уведомления — в batch раньше extra (снимков): их guard сверяется со снимком до записи (tech-debt #21). first —
// чтение, которому тоже нужен снимок до batch; возвращается его результат.
export async function notifyChanges(
  ctx: AppContext,
  pcid: string,
  changes: Change[],
  extra: D1PreparedStatement[] = [],
  known?: CalendarChat[],
  first?: D1PreparedStatement,
): Promise<D1Result | undefined> {
  const chats = changes.length ? (known ?? (await chatsForCalendar(ctx.db, pcid))) : [];
  const { stmts, flushNow } = noticeStatements(ctx.db, pcid, chats, changes, ctx.clock.now());
  const all = [...(first ? [first] : []), ...stmts, ...extra];
  const results = all.length ? await ctx.db.batch(all) : [];
  for (const chatId of flushNow) await flushChat(ctx, chatId);
  return first ? results[0] : undefined;
}
