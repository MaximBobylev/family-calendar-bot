// US-71: напоминания о встречах в Telegram «за N минут». Задача scheduled_jobs на (событие, пользователь, момент);
// источник времени — снимки синхронизации (event_snapshots), поэтому перенос/удаление события переставляет или
// снимает напоминание. Ставим на горизонт HORIZON_MS вперёд; дальше горизонт двигает плановый синк календаря.
// При срабатывании событие сверяется со снимком ещё раз: не совпало время — молчим (новая задача уже стоит).

import type { AppContext } from "../bot/context";
import { telegramChatOf } from "../db/accounts";
import { chatsForCalendar, snapshotsBetween, snapshotsByIds, userCalendarIds, type CalendarChat } from "../db/sync";
import { findUserById } from "../db/users";
import type { DueJob } from "../scheduler";
import { DAY_MS, MINUTE_MS, reminderFireAt, reminderText, type Snapshot } from "./logic";

export const TG_REMINDER_JOB = "tg_reminder";
/** Напоминания ставятся на столько вперёд; плановый синк (не реже раза в сутки) двигает горизонт. */
export const HORIZON_MS = 3 * DAY_MS;
/** Варианты «за N минут» в /settings. */
export const TG_REMINDER_PRESETS = [5, 10, 15, 30, 60];

interface ReminderPayload {
  pcid: string;
  eventId: string;
  startMs: number;
  minutes: number;
}

/** Кому напоминать о событиях календаря: пользователи с включённой настройкой. */
export const reminderUsers = (chats: CalendarChat[]) => chats.filter((c): c is CalendarChat & { userId: string } => !!c.userId && !!c.settings.tgReminderMin);

type ReminderUser = { userId: string; settings: { tgReminderMin?: number } };

/**
 * Поставить напоминания по снимкам для пользователей — одним запросом (json_each). Ключ — событие, пользователь и
 * момент: повтор не дублирует; отменённую раньше (событие переносили туда и обратно) — вернуть.
 */
function insertReminders(db: D1Database, pcid: string, snaps: Snapshot[], users: ReminderUser[], now: number): D1PreparedStatement[] {
  const rows: { id: string; u: string; f: number; p: string; k: string }[] = [];
  for (const s of snaps) {
    for (const u of users) {
      const minutes = u.settings.tgReminderMin!;
      const fireAt = reminderFireAt(s, minutes);
      if (fireAt === null || fireAt <= now || s.startMs! - now > HORIZON_MS) continue;
      const payload: ReminderPayload = { pcid, eventId: s.eventId, startMs: s.startMs!, minutes };
      rows.push({
        id: crypto.randomUUID(),
        u: u.userId,
        f: fireAt,
        p: JSON.stringify(payload),
        k: `${TG_REMINDER_JOB}:${pcid}:${s.eventId}:${u.userId}:${fireAt}`,
      });
    }
  }
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 100) {
    out.push(
      db
        .prepare(
          `INSERT INTO scheduled_jobs (id, kind, user_id, fire_at, payload_json, status, dedupe_key)
           SELECT j.value ->> '$.id', ?1, j.value ->> '$.u', j.value ->> '$.f', j.value ->> '$.p', 'pending', j.value ->> '$.k'
           FROM json_each(?2) j WHERE true
           ON CONFLICT (dedupe_key) DO UPDATE SET status = 'pending' WHERE status = 'cancelled'`,
        )
        .bind(TG_REMINDER_JOB, JSON.stringify(rows.slice(i, i + 100))),
    );
  }
  return out;
}

/** События изменились: снять их ожидающие напоминания и поставить по новому времени (в том же batch, что и снимки). */
export function reminderStatements(
  db: D1Database,
  pcid: string,
  eventIds: string[],
  afters: Snapshot[],
  users: ReminderUser[],
  now: number,
): D1PreparedStatement[] {
  if (eventIds.length === 0) return [];
  return [
    db
      .prepare(
        `UPDATE scheduled_jobs SET status = 'cancelled'
         WHERE kind = ?1 AND status = 'pending' AND payload_json ->> '$.pcid' = ?2
           AND payload_json ->> '$.eventId' IN (SELECT value FROM json_each(?3))`,
      )
      .bind(TG_REMINDER_JOB, pcid, JSON.stringify(eventIds)),
    ...insertReminders(db, pcid, afters, users, now),
  ];
}

/** Сдвинуть горизонт: напоминания на ближайшие HORIZON_MS по всем событиям календаря (идемпотентно). */
export async function extendReminders(db: D1Database, pcid: string, now: number): Promise<void> {
  const users = reminderUsers(await chatsForCalendar(db, pcid));
  if (users.length === 0) return;
  const snaps = await snapshotsBetween(db, pcid, now, now + HORIZON_MS + 60 * MINUTE_MS);
  const stmts = insertReminders(db, pcid, snaps, users, now);
  if (stmts.length) await db.batch(stmts);
}

/** Настройка пользователя поменялась: снять его напоминания и поставить заново по всем его календарям. */
export async function rescheduleUserReminders(db: D1Database, userId: string, now: number): Promise<void> {
  await db.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE user_id = ? AND kind = ? AND status = 'pending'").bind(userId, TG_REMINDER_JOB).run();
  for (const pcid of await userCalendarIds(db, userId)) await extendReminders(db, pcid, now);
}

/** Срабатывание: сверить со снимком (время, отмена, отказ, настройка) и отправить. */
export async function runReminderJob(ctx: AppContext, job: DueJob): Promise<void> {
  const p = JSON.parse(job.payload_json) as ReminderPayload;
  const user = job.user_id ? await findUserById(ctx.db, job.user_id) : null;
  if (!user || user.settings.tgReminderMin !== p.minutes) return;
  const now = ctx.clock.now();
  // Опоздали (сбой cron дольше самого напоминания) — встреча уже началась, не шлём
  if (now >= p.startMs) return;
  const snap = (await snapshotsByIds(ctx.db, p.pcid, [p.eventId])).get(p.eventId) ?? null;
  if (!snap || snap.startMs !== p.startMs || reminderFireAt(snap, p.minutes) === null) return;
  if (!(await userCalendarIds(ctx.db, user.id)).includes(p.pcid)) return;
  const chatId = await telegramChatOf(ctx.db, user.id);
  if (!chatId) return;
  await ctx.telegram.sendMessage(Number(chatId), reminderText(snap, p.minutes, user.locale, user.home_tz, now), undefined, { html: true });
}
