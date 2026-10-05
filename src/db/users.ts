// Пользователи и их идентичности в каналах (ADR-0003: внутренний user_id ≠ telegram id).

import { parseSettings, type UserSettings } from "./settings";

export interface User {
  id: string;
  locale: string;
  home_tz: string;
  settings: UserSettings;
}

export async function findUserByTelegramId(db: D1Database, telegramId: number): Promise<User | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.locale, u.home_tz, u.settings_json FROM users u
       JOIN channel_identities ci ON ci.user_id = u.id
       WHERE ci.channel = 'telegram' AND ci.external_id = ?`,
    )
    .bind(String(telegramId))
    .first<{ id: string; locale: string; home_tz: string; settings_json: string }>();
  return row ? { id: row.id, locale: row.locale, home_tz: row.home_tz, settings: parseSettings(row.settings_json) } : null;
}

/** Находит или создаёт пользователя для Telegram-аккаунта. Новому пользователю выдаётся entitlement `comp`. */
export async function ensureTelegramUser(
  db: D1Database,
  telegramId: number,
  now: number,
): Promise<{ user: User; created: boolean }> {
  const existing = await findUserByTelegramId(db, telegramId);
  if (existing) return { user: existing, created: false };

  const id = crypto.randomUUID();
  // Язык по умолчанию — русский, независимо от языка Telegram; смена — через /settings (US-04, US-10a)
  const userLocale = "ru";
  await db.batch([
    db.prepare("INSERT INTO users (id, created_at, locale) VALUES (?, ?, ?)").bind(id, now, userLocale),
    db
      .prepare("INSERT INTO channel_identities (channel, external_id, user_id, created_at) VALUES ('telegram', ?, ?, ?)")
      .bind(String(telegramId), id, now),
    // Пока доступ только по allowlist — все зарегистрированные получают comp (ADR-0004)
    db
      .prepare("INSERT INTO entitlements (id, user_id, plan, source, starts_at) VALUES (?, ?, 'comp', 'comp', ?)")
      .bind(crypto.randomUUID(), id, now),
  ]);
  return { user: { id, locale: userLocale, home_tz: "UTC", settings: {} }, created: true };
}
