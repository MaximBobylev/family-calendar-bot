// Настройки пользователя (US-04) живут в нескольких местах: settings_json, locale, home_tz, calendars.is_default, calendar_aliases.

import { localToUtc, parseLocal } from "../dates/calendar";

export interface UserSettings {
  /** Нет — 60. */
  durationMin?: number;
  /** Минуты до начала. Нет — как в Google (useDefault); [] — без напоминаний. */
  reminders?: number[];
  /** Минуты до полуночи дня события. Нет — без напоминаний. */
  allDayReminders?: number[];
  digestOff?: boolean;
  /** «ЧЧ:ММ» по поясу пользователя. Нет — 08:00. */
  digestTime?: string;
  /** Сводка «Завтра» в 21:00. */
  tomorrowDigest?: boolean;
  /** вс 20:00 или пн 08:00. Нет — выключена. */
  weekDigest?: "sun" | "mon";
  changeNotifyOff?: boolean;
  /** Нет — не напоминать. */
  tgReminderMin?: number;
}

export const DEFAULT_DURATION_MIN = 60;
export const DEFAULT_DIGEST_TIME = "08:00";

export function parseSettings(json: string | null | undefined): UserSettings {
  try {
    const s = JSON.parse(json ?? "{}") as UserSettings;
    return typeof s === "object" && s ? s : {};
  } catch {
    return {};
  }
}

export async function getSettings(db: D1Database, userId: string): Promise<UserSettings> {
  const row = await db.prepare("SELECT settings_json FROM users WHERE id = ?").bind(userId).first<{ settings_json: string }>();
  return parseSettings(row?.settings_json);
}

/** undefined в patch — убрать ключ (вернуть умолчание). */
export async function updateSettings(db: D1Database, userId: string, patch: Partial<Record<keyof UserSettings, unknown>>): Promise<void> {
  const next: Record<string, unknown> = { ...(await getSettings(db, userId)), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  await db.prepare("UPDATE users SET settings_json = ? WHERE id = ?").bind(JSON.stringify(next), userId).run();
}

export async function setLocale(db: D1Database, userId: string, locale: "ru" | "en"): Promise<void> {
  await db.prepare("UPDATE users SET locale = ? WHERE id = ?").bind(locale, userId).run();
}

export async function setHomeTz(db: D1Database, userId: string, tz: string): Promise<void> {
  await db.prepare("UPDATE users SET home_tz = ?, trip_tz = NULL, trip_until = NULL WHERE id = ?").bind(tz, userId).run();
}

/** users.trip_until — INTEGER: полночь дня окончания по поясу поездки, мс UTC. */
const untilMs = (until: string | null, tz: string) => (until ? localToUtc({ day: parseLocal(`${until}T00:00`).day, minutes: 0 }, tz) : null);

export async function setTrip(db: D1Database, userId: string, tz: string, until: string | null): Promise<void> {
  await db.prepare("UPDATE users SET trip_tz = ?, trip_until = ? WHERE id = ?").bind(tz, untilMs(until, tz), userId).run();
}

export async function setTripUntil(db: D1Database, userId: string, tz: string, until: string | null): Promise<void> {
  await db.prepare("UPDATE users SET trip_until = ? WHERE id = ? AND trip_tz = ?").bind(untilMs(until, tz), userId, tz).run();
}

export async function endTrip(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE users SET trip_tz = NULL, trip_until = NULL WHERE id = ?").bind(userId).run();
}

export const TRIP_CHECK_JOB = "trip_check";

export function cancelTripChecks(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE user_id = ? AND kind = ? AND status = 'pending'").bind(userId, TRIP_CHECK_JOB);
}

export async function scheduleTripCheck(db: D1Database, userId: string, fireAt: number): Promise<void> {
  await db.batch([
    cancelTripChecks(db, userId),
    db
      .prepare(
        `INSERT INTO scheduled_jobs (id, kind, user_id, fire_at, status, dedupe_key)
         VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (dedupe_key) DO UPDATE SET status = 'pending'`,
      )
      .bind(crypto.randomUUID(), TRIP_CHECK_JOB, userId, fireAt, `${TRIP_CHECK_JOB}:${userId}:${fireAt}`),
  ]);
}

export async function setDefaultCalendar(db: D1Database, userId: string, calendarId: string): Promise<boolean> {
  const own = await db
    .prepare(
      `SELECT c.account_id
       FROM calendars c
       JOIN provider_accounts a ON a.id = c.account_id
       WHERE c.id = ? AND a.user_id = ? AND c.writable = 1`,
    )
    .bind(calendarId, userId)
    .first<{ account_id: string }>();
  if (!own) return false;
  await db.prepare("UPDATE calendars SET is_default = (id = ?) WHERE account_id = ?").bind(calendarId, own.account_id).run();
  return true;
}

const MAX_ALIAS_LEN = 40;
const MAX_ALIASES = 20;

export const normalizeAlias = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/^[«"']+|[»"']+$/g, "")
    .replace(/\s+/g, " ");

/** Алиас уникален у пользователя — у другого календаря он снимается. */
export async function addAliases(db: D1Database, userId: string, calendarId: string, aliases: string[]): Promise<string[]> {
  const clean = [...new Set(aliases.map(normalizeAlias).filter((a) => a.length > 0 && a.length <= MAX_ALIAS_LEN))].slice(0, MAX_ALIASES);
  if (clean.length === 0) return [];
  await db.batch(
    clean.map((a) =>
      db
        .prepare(
          `INSERT INTO calendar_aliases (user_id, alias, calendar_id)
           VALUES (?, ?, ?)
           ON CONFLICT (user_id, alias) DO UPDATE SET calendar_id = excluded.calendar_id`,
        )
        .bind(userId, a, calendarId),
    ),
  );
  return clean;
}

export async function clearAliases(db: D1Database, userId: string, calendarId: string): Promise<void> {
  await db.prepare("DELETE FROM calendar_aliases WHERE user_id = ? AND calendar_id = ?").bind(userId, calendarId).run();
}
