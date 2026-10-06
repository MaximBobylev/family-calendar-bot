// Пользователи и их идентичности в каналах (ADR-0003: внутренний user_id ≠ telegram id).

import { dissolveStatements } from "./households";
import { parseSettings, type UserSettings } from "./settings";

export interface User {
  id: string;
  locale: string;
  home_tz: string;
  settings: UserSettings;
  /** Имя и @username в Telegram из текущего апдейта (в D1 не хранится) — для страницы привязки (tech-debt #1). */
  tgName?: string;
}

export async function findUserByTelegramId(db: D1Database, telegramId: number): Promise<User | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.locale, u.home_tz, u.settings_json
       FROM users u
       JOIN channel_identities ci ON ci.user_id = u.id
       WHERE ci.channel = 'telegram' AND ci.external_id = ?`,
    )
    .bind(String(telegramId))
    .first<{ id: string; locale: string; home_tz: string; settings_json: string }>();
  return row ? { id: row.id, locale: row.locale, home_tz: row.home_tz, settings: parseSettings(row.settings_json) } : null;
}

export async function findUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db
    .prepare("SELECT id, locale, home_tz, settings_json FROM users WHERE id = ?")
    .bind(id)
    .first<{ id: string; locale: string; home_tz: string; settings_json: string }>();
  return row ? { id: row.id, locale: row.locale, home_tz: row.home_tz, settings: parseSettings(row.settings_json) } : null;
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
  return { user: { id, locale: userLocale, home_tz: "UTC", settings: {} }, created: true };
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
    db.prepare("DELETE FROM usage_events WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM feature_usage WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM entitlements WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM oauth_states WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM calendar_aliases WHERE user_id = ?1").bind(userId),
    db.prepare(`DELETE FROM calendars WHERE account_id IN (${accounts})`).bind(userId),
    db.prepare("DELETE FROM provider_accounts WHERE user_id = ?1").bind(userId),
    // Диспетчер (R1, пока пусто): своё — удалить, у чужого — снять ссылку на пользователя
    db.prepare("DELETE FROM event_meta WHERE created_by_user_id = ?1").bind(userId),
    db.prepare("UPDATE event_meta SET responsible_user_id = NULL WHERE responsible_user_id = ?1").bind(userId),
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
