// US-70: утренний дайджест «Сегодня». Одна задача scheduled_jobs на ближайшее время отправки; при выполнении
// сразу ставится следующая. Смена времени/пояса/выключение — reschedule. Раз в час ensureDigests добирает
// пользователей без задачи (новые, после сбоев). Сильно опоздавшую сводку (сбой дольше MAX_LATE_MS) не шлём.

import type { AppContext } from "../bot/context";
import { appendFailedNote, formatEvents } from "../bot/format-events";
import { t } from "../bot/messages";
import { GoogleCalendarProvider } from "../calendar/google-provider";
import { AuthRevoked, type CalendarInfo, type EventList } from "../calendar/model";
import { localToUtc, utcToLocal } from "../dates/calendar";
import { nextDailyAt, parseHhmm } from "../dates/daily";
import { hasGoogleAccount, telegramChatOf } from "../db/accounts";
import { recordFeature } from "../db/features";
import { DEFAULT_DIGEST_TIME } from "../db/settings";
import { findUserById, type User } from "../db/users";
import type { DueJob } from "../scheduler";

export const DIGEST_JOB = "digest";
const MAX_LATE_MS = 3 * 60 * 60 * 1000;

const digestMinutes = (user: User) => parseHhmm(user.settings.digestTime ?? DEFAULT_DIGEST_TIME) ?? 8 * 60;

/** Поставить ближайший дайджест (идемпотентно: dedupe по пользователю и моменту). */
export async function scheduleDigest(db: D1Database, user: User, now: number): Promise<void> {
  if (user.settings.digestOff) return;
  const fireAt = nextDailyAt(now, user.home_tz, digestMinutes(user));
  await db
    .prepare(
      `INSERT INTO scheduled_jobs (id, kind, user_id, fire_at, status, dedupe_key)
       VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (dedupe_key) DO UPDATE SET status = 'pending' WHERE status = 'cancelled'`,
    )
    .bind(crypto.randomUUID(), DIGEST_JOB, user.id, fireAt, `${DIGEST_JOB}:${user.id}:${fireAt}`)
    .run();
}

/** Настройки поменялись: снять ожидающий дайджест и поставить по новым. */
export async function rescheduleDigest(db: D1Database, userId: string, now: number): Promise<void> {
  await db.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE user_id = ? AND kind = ? AND status = 'pending'").bind(userId, DIGEST_JOB).run();
  const user = await findUserById(db, userId);
  if (user && (await hasGoogleAccount(db, userId))) await scheduleDigest(db, user, now);
}

/** Страховка раз в час: у каждого подключённого пользователя со включённым дайджестом есть задача. */
export async function ensureDigests(db: D1Database, now: number): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT u.id
       FROM users u
       WHERE EXISTS (SELECT 1 FROM provider_accounts a WHERE a.user_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM scheduled_jobs j WHERE j.user_id = u.id AND j.kind = ? AND j.status IN ('pending', 'queued', 'running'))`,
    )
    .bind(DIGEST_JOB)
    .all<{ id: string }>();
  for (const { id } of results) {
    const user = await findUserById(db, id);
    if (user) await scheduleDigest(db, user, now);
  }
}

export async function runDigestJob(ctx: AppContext, job: DueJob): Promise<void> {
  const now = ctx.clock.now();
  const user = job.user_id ? await findUserById(ctx.db, job.user_id) : null;
  if (!user || user.settings.digestOff || !(await hasGoogleAccount(ctx.db, user.id))) return;
  // Следующая — сразу: повтор этой задачи или сбой отправки не должны оставить пользователя без завтрашней
  await scheduleDigest(ctx.db, user, Math.max(now, job.fire_at));
  if (now - job.fire_at > MAX_LATE_MS) {
    console.warn("digest skipped: too late", job.id, now - job.fire_at);
    return;
  }
  const chatId = await telegramChatOf(ctx.db, user.id);
  if (!chatId) return;

  const tz = user.home_tz;
  const today = utcToLocal(job.fire_at, tz).day;
  const provider = new GoogleCalendarProvider(ctx.config, ctx.db, user.id, ctx.clock);
  let list: EventList;
  let calendars: CalendarInfo[];
  try {
    calendars = await provider.calendars();
    list = await provider.listEvents(localToUtc({ day: today, minutes: 0 }, tz), localToUtc({ day: today + 1, minutes: 0 }, tz), tz);
  } catch (e) {
    // Доступ отозван — молчим: о переподключении скажем, когда пользователь напишет сам (не каждое утро)
    if (e instanceof AuthRevoked) return;
    throw e;
  }
  const defaultId = calendars.find((c) => c.isDefault)?.id;
  const parts = formatEvents(list.events, today, today, today, user.locale, (id) => calendars.length > 1 && id !== defaultId);
  parts[0] = `${t("digestGreeting", user.locale)}\n\n${parts[0]}`;
  appendFailedNote(parts, list.failed, user.locale);
  for (const text of parts) await ctx.telegram.sendMessage(Number(chatId), text, undefined, { html: true });
  await recordFeature(ctx.db, user.id, "digest", ctx.clock.now());
}
