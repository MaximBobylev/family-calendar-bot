// Пользователи и их идентичности в каналах: внутренний user_id ≠ telegram id (ADR-0003).

import { formatDate, utcToLocal } from "../dates/calendar";
import { dissolveStatements } from "./households";
import { parseSettings, type UserSettings } from "./settings";

export interface User {
  id: string;
  locale: string;
  /** Пояс поездки, иначе домашний: в нём считаются все даты, сводки и напоминания. */
  tz: string;
  home_tz: string;
  /** until — по поясу поездки; нужен только для вопроса «Вернулись?». */
  trip?: { tz: string; until?: string };
  settings: UserSettings;
  /** Из текущего апдейта, в D1 не хранится. */
  tgName?: string;
}

interface UserRow {
  id: string;
  locale: string;
  home_tz: string;
  trip_tz: string | null;
  /** Полночь дня окончания по поясу поездки, мс UTC. */
  trip_until: number | null;
  settings_json: string;
}

const USER_COLUMNS = "u.id, u.locale, u.home_tz, u.trip_tz, u.trip_until, u.settings_json";

const toUser = (r: UserRow): User => ({
  id: r.id,
  locale: r.locale,
  tz: r.trip_tz ?? r.home_tz,
  home_tz: r.home_tz,
  ...(r.trip_tz ? { trip: { tz: r.trip_tz, ...(r.trip_until !== null ? { until: formatDate(utcToLocal(r.trip_until, r.trip_tz).day) } : {}) } } : {}),
  settings: parseSettings(r.settings_json),
});

export async function findUserByTelegramId(db: D1Database, telegramId: number): Promise<User | null> {
  const row = await db
    .prepare(
      `SELECT ${USER_COLUMNS}
       FROM users u
       JOIN channel_identities ci ON ci.user_id = u.id
       WHERE ci.channel = 'telegram' AND ci.external_id = ?`,
    )
    .bind(String(telegramId))
    .first<UserRow>();
  return row ? toUser(row) : null;
}

export async function findUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`).bind(id).first<UserRow>();
  return row ? toUser(row) : null;
}

export async function ensureTelegramUser(db: D1Database, telegramId: number, now: number): Promise<{ user: User; created: boolean }> {
  const existing = await findUserByTelegramId(db, telegramId);
  if (existing) return { user: existing, created: false };

  const id = crypto.randomUUID();
  // Язык по умолчанию — русский, независимо от языка Telegram; смена — через /settings (US-04, US-10a)
  const userLocale = "ru";
  await db.batch([
    db.prepare("INSERT INTO users (id, created_at, locale) VALUES (?, ?, ?)").bind(id, now, userLocale),
    db.prepare("INSERT INTO channel_identities (channel, external_id, user_id, created_at) VALUES ('telegram', ?, ?, ?)").bind(String(telegramId), id, now),
    // Пока доступ только по allowlist — все зарегистрированные получают comp (ADR-0004)
    db.prepare("INSERT INTO entitlements (id, user_id, plan, source, starts_at) VALUES (?, ?, 'comp', 'comp', ?)").bind(crypto.randomUUID(), id, now),
  ]);
  return { user: { id, locale: userLocale, tz: "UTC", home_tz: "UTC", settings: {} }, created: true };
}

/** После удаления — как новый (US-03). Явно по каждой таблице, не полагаясь только на ON DELETE CASCADE. */
export async function deleteUserData(db: D1Database, userId: string, telegramId: number): Promise<void> {
  const accounts = "SELECT id FROM provider_accounts WHERE user_id = ?1";
  await db.batch([
    db
      .prepare(
        `DELETE FROM inbox
         WHERE json_extract(payload_json, '$.message.from.id') = ?1
            OR json_extract(payload_json, '$.callback_query.from.id') = ?1
            OR json_extract(payload_json, '$.edited_message.from.id') = ?1`,
      )
      .bind(telegramId),
    db.prepare("DELETE FROM pending_actions WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM dialog_state WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM conversations WHERE channel = 'telegram' AND chat_id = ?1 AND kind = 'private'").bind(String(telegramId)),
    db.prepare("DELETE FROM scheduled_jobs WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM change_notices WHERE user_id = ?1 OR chat_id = ?2").bind(userId, String(telegramId)),
    db.prepare("DELETE FROM bot_writes WHERE author_user_id = ?1").bind(userId),
    db.prepare("DELETE FROM usage_events WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM feature_usage WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM date_metrics WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM entitlements WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM oauth_states WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM calendar_aliases WHERE user_id = ?1").bind(userId),
    db.prepare(`DELETE FROM calendars WHERE account_id IN (${accounts})`).bind(userId),
    db.prepare("DELETE FROM provider_accounts WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM event_meta WHERE created_by_user_id = ?1").bind(userId),
    db.prepare("UPDATE event_meta SET responsible_user_id = NULL WHERE responsible_user_id = ?1").bind(userId),
    // До поручений, которые он создал
    db.prepare("DELETE FROM assignment_messages WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM assignments WHERE created_by = ?1").bind(userId),
    db.prepare("UPDATE assignments SET assignee_user_id = NULL WHERE assignee_user_id = ?1").bind(userId),
    db.prepare("DELETE FROM household_members WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM inline_events WHERE created_by_tg = ?1").bind(String(telegramId)),
    db.prepare("DELETE FROM inline_adds WHERE telegram_id = ?1").bind(String(telegramId)),
    ...dissolveStatements(db, "SELECT id FROM households WHERE owner_user_id = ?1", userId),
    db.prepare("DELETE FROM household_invites WHERE created_by = ?1").bind(userId),
    db.prepare("DELETE FROM households WHERE owner_user_id = ?1").bind(userId),
    db.prepare("DELETE FROM channel_identities WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?1").bind(userId),
  ]);
}
