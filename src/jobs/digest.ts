// US-70: дайджесты «Сегодня» (утро, по умолчанию вкл), «Завтра» (21:00) и «Неделя» (вс 20:00 или пн 08:00; оба по
// умолчанию выкл). На каждый вид — одна задача scheduled_jobs на ближайшее время отправки; при выполнении сразу
// ставится следующая. Смена времени/пояса/выключение — reschedule. Раз в час ensureDigests добирает пользователей
// без задачи (новые, после сбоев). Сильно опоздавшую сводку (сбой дольше MAX_LATE_MS) не шлём.

import { familyLabeler } from "../bot/assign/family";
import type { AppContext } from "../bot/context";
import { appendFailedNote, formatEvents } from "../bot/format-events";
import { type MessageKey, t } from "../bot/messages";
import { AuthRevoked, type CalendarInfo, type EventList } from "../calendar/model";
import { type Day, localToUtc, utcToLocal } from "../dates/calendar";
import { nextDailyAt, nextWeeklyAt, parseHhmm } from "../dates/daily";
import { telegramChatOf } from "../db/accounts";
import { recordFeature } from "../db/features";
import { DEFAULT_DIGEST_TIME } from "../db/settings";
import { findUserById, type User } from "../db/users";
import type { DueJob } from "../scheduler";
import { assignmentsBlock, digestProvider, hasDigestSource } from "./family-digest";

export const DIGEST_JOB = "digest";
export const TOMORROW_DIGEST_JOB = "digest_tomorrow";
export const WEEK_DIGEST_JOB = "digest_week";
const DIGEST_KINDS = [DIGEST_JOB, TOMORROW_DIGEST_JOB, WEEK_DIGEST_JOB] as const;
type DigestKind = (typeof DIGEST_KINDS)[number];

const MAX_LATE_MS = 3 * 60 * 60 * 1000;
/** «Завтра» — в 21:00 по поясу пользователя `[решение 2026-10-06]`: время не настраивается. */
export const TOMORROW_DIGEST_TIME = "21:00";
/** «Неделя»: воскресенье вечером (предстоящая неделя) или понедельник утром (текущая). 0 — пн … 6 — вс. */
export const WEEK_SLOTS = { sun: { weekday: 6, time: "20:00" }, mon: { weekday: 0, time: "08:00" } } as const;

const digestMinutes = (user: User) => parseHhmm(user.settings.digestTime ?? DEFAULT_DIGEST_TIME) ?? 8 * 60;

/** Ближайший момент отправки дайджеста этого вида; null — выключен. */
function nextFireAt(kind: DigestKind, user: User, now: number): number | null {
  const tz = user.home_tz;
  if (kind === DIGEST_JOB) return user.settings.digestOff ? null : nextDailyAt(now, tz, digestMinutes(user));
  if (kind === TOMORROW_DIGEST_JOB) return user.settings.tomorrowDigest ? nextDailyAt(now, tz, parseHhmm(TOMORROW_DIGEST_TIME)!) : null;
  const slot = user.settings.weekDigest ? WEEK_SLOTS[user.settings.weekDigest] : undefined;
  return slot ? nextWeeklyAt(now, tz, slot.weekday, parseHhmm(slot.time)!) : null;
}

/** Поставить ближайший дайджест вида kind (идемпотентно: dedupe по виду, пользователю и моменту). */
async function scheduleKind(db: D1Database, kind: DigestKind, user: User, now: number): Promise<void> {
  const fireAt = nextFireAt(kind, user, now);
  if (fireAt === null) return;
  await db
    .prepare(
      `INSERT INTO scheduled_jobs (id, kind, user_id, fire_at, status, dedupe_key)
       VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (dedupe_key) DO UPDATE SET status = 'pending' WHERE status = 'cancelled'`,
    )
    .bind(crypto.randomUUID(), kind, user.id, fireAt, `${kind}:${user.id}:${fireAt}`)
    .run();
}

/** Поставить ближайшие дайджесты всех включённых видов. */
export async function scheduleDigest(db: D1Database, user: User, now: number): Promise<void> {
  for (const kind of DIGEST_KINDS) await scheduleKind(db, kind, user, now);
}

/** Настройки поменялись: снять ожидающие дайджесты и поставить по новым. */
export async function rescheduleDigest(db: D1Database, userId: string, now: number): Promise<void> {
  await db
    .prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE user_id = ? AND kind IN (?, ?, ?) AND status = 'pending'`)
    .bind(userId, ...DIGEST_KINDS)
    .run();
  const user = await findUserById(db, userId);
  if (user && (await hasDigestSource(db, userId))) await scheduleDigest(db, user, now);
}

/** Кому вид нужен: «Сегодня» — всем, кроме выключивших (проверка в nextFireAt); остальные — только включившим. */
const WANTS: Record<DigestKind, string> = {
  [DIGEST_JOB]: "1",
  [TOMORROW_DIGEST_JOB]: "json_extract(u.settings_json, '$.tomorrowDigest') = 1",
  [WEEK_DIGEST_JOB]: "json_extract(u.settings_json, '$.weekDigest') IS NOT NULL",
};

/** Страховка раз в час: у каждого подключённого пользователя и участника дома (US-93) со включённым дайджестом есть задача. */
export async function ensureDigests(db: D1Database, now: number): Promise<void> {
  for (const kind of DIGEST_KINDS) {
    const { results } = await db
      .prepare(
        `SELECT u.id
         FROM users u
         WHERE ${WANTS[kind]}
           AND (EXISTS (SELECT 1 FROM provider_accounts a WHERE a.user_id = u.id) OR EXISTS (SELECT 1 FROM household_members m WHERE m.user_id = u.id))
           AND NOT EXISTS (SELECT 1 FROM scheduled_jobs j WHERE j.user_id = u.id AND j.kind = ? AND j.status IN ('pending', 'queued', 'running'))`,
      )
      .bind(kind)
      .all<{ id: string }>();
    for (const { id } of results) {
      const user = await findUserById(db, id);
      if (user) await scheduleKind(db, kind, user, now);
    }
  }
}

/** Период сводки (дни включительно), заголовок и текст «пусто» по виду. */
function digestPeriod(kind: DigestKind, user: User, today: Day): { from: Day; to: Day; title: MessageKey; empty?: MessageKey } {
  if (kind === TOMORROW_DIGEST_JOB) return { from: today + 1, to: today + 1, title: "digestTomorrowGreeting", empty: "digestTomorrowEmpty" };
  if (kind === WEEK_DIGEST_JOB) {
    // Вс вечером — предстоящая неделя пн–вс; пн утром — текущая
    const from = user.settings.weekDigest === "sun" ? today + 1 : today;
    return { from, to: from + 6, title: "digestWeekGreeting", empty: "digestWeekEmpty" };
  }
  return { from: today, to: today, title: "digestGreeting" };
}

export async function runDigestJob(ctx: AppContext, job: DueJob): Promise<void> {
  const kind = (DIGEST_KINDS as readonly string[]).includes(job.kind) ? (job.kind as DigestKind) : DIGEST_JOB;
  const now = ctx.clock.now();
  const user = job.user_id ? await findUserById(ctx.db, job.user_id) : null;
  if (!user || nextFireAt(kind, user, now) === null || !(await hasDigestSource(ctx.db, user.id))) return;
  // Следующая — сразу: повтор этой задачи или сбой отправки не должны оставить пользователя без следующей
  await scheduleKind(ctx.db, kind, user, Math.max(now, job.fire_at));
  if (now - job.fire_at > MAX_LATE_MS) {
    console.warn("digest skipped: too late", job.id, now - job.fire_at);
    return;
  }
  const chatId = await telegramChatOf(ctx.db, user.id);
  if (!chatId) return;

  const tz = user.home_tz;
  const today = utcToLocal(job.fire_at, tz).day;
  const period = digestPeriod(kind, user, today);
  // Участник дома без Google — общие календари дома через Google владельца (US-93)
  const provider = await digestProvider(ctx, user);
  if (!provider) return;
  let list: EventList;
  let calendars: CalendarInfo[];
  try {
    calendars = await provider.calendars();
    list = await provider.listEvents(localToUtc({ day: period.from, minutes: 0 }, tz), localToUtc({ day: period.to + 1, minutes: 0 }, tz), tz);
  } catch (e) {
    // Доступ отозван — молчим: о переподключении скажем, когда пользователь напишет сам (не каждое утро)
    if (e instanceof AuthRevoked) return;
    throw e;
  }
  const defaultId = calendars.find((c) => c.isDefault)?.id;
  const inPeriod = list.events.filter((e) => e.endDay >= period.from && e.startDay <= period.to);
  // «📌 Ваши дела сегодня» (US-93) — в утренней сводке; «📌 Ваши дела завтра» — в вечерней «Завтра» (ревью R1 #10)
  const tasks =
    kind === DIGEST_JOB
      ? await assignmentsBlock(ctx, user, today)
      : kind === TOMORROW_DIGEST_JOB
        ? await assignmentsBlock(ctx, user, today + 1, "digestAssignmentsTomorrow")
        : null;
  let parts: string[];
  if (inPeriod.length === 0 && period.empty) {
    // «Завтра встреч нет» (US-70 AC) — одной строкой, без заголовка
    parts = [t(period.empty, user.locale)];
  } else {
    // «Для кого / отводит» у событий (US-92, US-93) — во всех видах сводки
    const family = await familyLabeler(ctx.db, user.id, inPeriod, user.locale);
    parts = formatEvents(list.events, period.from, period.to, today, user.locale, (id) => calendars.length > 1 && id !== defaultId, family);
    parts[0] = `${t(period.title, user.locale)}\n\n${parts[0]}`;
  }
  if (tasks) parts[parts.length - 1] += `\n\n${tasks}`;
  appendFailedNote(parts, list.failed, user.locale);
  for (const text of parts) await ctx.telegram.sendMessage(Number(chatId), text, undefined, { html: true });
  await recordFeature(ctx.db, user.id, "digest", ctx.clock.now());
}
