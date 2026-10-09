// Пользователи и их идентичности в каналах (ADR-0003: внутренний user_id ≠ telegram id).

import { formatDate, utcToLocal } from "../dates/calendar";
import { dissolveStatements } from "./households";
import { parseSettings, type UserSettings } from "./settings";

export interface User {
  id: string;
  locale: string;
  /** Текущий пояс: поездки (US-07), иначе домашний — все даты, сводки и напоминания считаются в нём. */
  tz: string;
  /** Домашний пояс (из Google при привязке, /settings, «я переехал»). */
  home_tz: string;
  /** Поездка: временный пояс поверх домашнего; until — день окончания по её поясу (только для вопроса «Вернулись?»). */
  trip?: { tz: string; until?: string };
  settings: UserSettings;
  /** Имя и @username в Telegram из текущего апдейта (в D1 не хранится) — для страницы привязки (tech-debt #1). */
  tgName?: string;
}

interface UserRow {
  id: string;
  locale: string;
  home_tz: string;
  trip_tz: string | null;
  /** Полночь дня окончания по поясу поездки, мс UTC (столбец из 0001). */
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

/** Находит или создаёт пользователя для Telegram-аккаунта. Новому пользователю выдаётся entitlement `comp`. */
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

/**
 * Удалить пользователя и всё, что с ним связано (US-03): после этого он — как новый. Явно по каждой таблице,
 * не полагаясь только на ON DELETE CASCADE. Inbox — по Telegram id отправителя в сохранённом апдейте.
 * В одном batch — атомарно.
 */
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
    // Синхронизация (US-72): исходящие уведомления ему и его имя в журнале записей бота
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
    // Диспетчер (R1, пока пусто): своё — удалить, у чужого — снять ссылку на пользователя
    db.prepare("DELETE FROM event_meta WHERE created_by_user_id = ?1").bind(userId),
    db.prepare("UPDATE event_meta SET responsible_user_id = NULL WHERE responsible_user_id = ?1").bind(userId),
    // Сообщения поручений ему (его чат) — до поручений, которые он создал (US-91)
    db.prepare("DELETE FROM assignment_messages WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM assignments WHERE created_by = ?1").bind(userId),
    db.prepare("UPDATE assignments SET assignee_user_id = NULL WHERE assignee_user_id = ?1").bind(userId),
    db.prepare("DELETE FROM household_members WHERE user_id = ?1").bind(userId),
    // Inline-карточки (US-95): свои события и отметки «добавил»
    db.prepare("DELETE FROM inline_events WHERE created_by_tg = ?1").bind(String(telegramId)),
    db.prepare("DELETE FROM inline_adds WHERE telegram_id = ?1").bind(String(telegramId)),
    // Дом владельца: отвязать чаты, убрать участников, детей, общие календари, приглашения (US-90)
    ...dissolveStatements(db, "SELECT id FROM households WHERE owner_user_id = ?1", userId),
    db.prepare("DELETE FROM household_invites WHERE created_by = ?1").bind(userId),
    db.prepare("DELETE FROM households WHERE owner_user_id = ?1").bind(userId),
    db.prepare("DELETE FROM channel_identities WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?1").bind(userId),
  ]);
}
