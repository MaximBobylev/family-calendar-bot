// OAuth state, аккаунты провайдеров и календари.

import type { GoogleCalendarListEntry } from "../google/calendar-api";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export async function createOAuthState(db: D1Database, state: string, userId: string, now: number): Promise<void> {
  await db
    .prepare("INSERT INTO oauth_states (state, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(state, userId, now, now + OAUTH_STATE_TTL_MS)
    .run();
}

export type ConsumeStateResult = { ok: true; userId: string } | { ok: false; reason: "unknown" | "used" | "expired" };

/** Одноразово «гасит» state. Повторное использование и протухшие — ошибка (US-02). */
export async function consumeOAuthState(db: D1Database, state: string, now: number): Promise<ConsumeStateResult> {
  const row = await db
    .prepare("UPDATE oauth_states SET used_at = ? WHERE state = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id")
    .bind(now, state, now)
    .first<{ user_id: string }>();
  if (row) return { ok: true, userId: row.user_id };
  const existing = await db.prepare("SELECT used_at, expires_at FROM oauth_states WHERE state = ?").bind(state).first<{ used_at: number | null; expires_at: number }>();
  if (!existing) return { ok: false, reason: "unknown" };
  return { ok: false, reason: existing.used_at ? "used" : "expired" };
}

export interface LinkedAccount {
  accountId: string;
  email: string;
  timeZone: string;
  writableCalendars: number;
}

/**
 * Сохраняет привязку Google. В R0 у пользователя один аккаунт: новая привязка заменяет старую
 * вместе с календарями и алиасами (US-02), хотя схема допускает несколько (ADR-0003).
 */
export async function saveGoogleAccount(
  db: D1Database,
  args: {
    userId: string;
    email: string;
    emailHash: string;
    credentialsEnc: string;
    scopes: string;
    calendars: GoogleCalendarListEntry[];
    now: number;
  },
): Promise<LinkedAccount> {
  const accountId = crypto.randomUUID();
  const primary = args.calendars.find((c) => c.primary);
  const timeZone = primary?.timeZone ?? "UTC";
  const writable = (c: GoogleCalendarListEntry) => c.accessRole === "writer" || c.accessRole === "owner";

  await db.batch([
    db.prepare("DELETE FROM calendar_aliases WHERE user_id = ?").bind(args.userId),
    db.prepare("DELETE FROM provider_accounts WHERE user_id = ? AND provider = 'google'").bind(args.userId),
    db
      .prepare(
        `INSERT INTO provider_accounts (id, user_id, provider, email, email_hash, credentials_enc, granted_scopes, created_at)
         VALUES (?, ?, 'google', ?, ?, ?, ?, ?)`,
      )
      .bind(accountId, args.userId, args.email, args.emailHash, args.credentialsEnc, args.scopes, args.now),
    ...args.calendars.map((c) =>
      db
        .prepare(
          `INSERT INTO calendars (id, account_id, provider_calendar_id, title, time_zone, writable, is_default)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), accountId, c.id, c.summary, c.timeZone ?? null, writable(c) ? 1 : 0, c.primary ? 1 : 0),
    ),
    db.prepare("UPDATE users SET home_tz = ? WHERE id = ?").bind(timeZone, args.userId),
  ]);

  return { accountId, email: args.email, timeZone, writableCalendars: args.calendars.filter(writable).length };
}

export async function hasGoogleAccount(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM provider_accounts WHERE user_id = ? AND provider = 'google'").bind(userId).first();
  return row !== null;
}

export async function telegramChatOf(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT external_id FROM channel_identities WHERE user_id = ? AND channel = 'telegram'")
    .bind(userId)
    .first<{ external_id: string }>();
  return row?.external_id ?? null;
}

export async function userLocale(db: D1Database, userId: string): Promise<string> {
  const row = await db.prepare("SELECT locale FROM users WHERE id = ?").bind(userId).first<{ locale: string }>();
  return row?.locale ?? "ru";
}
