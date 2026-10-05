// OAuth state, аккаунты провайдеров и календари.

import { pickDefaultCalendar } from "../calendar/sync";
import type { GoogleCalendarListEntry } from "../google/calendar-api";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** tgName — кому выдана ссылка: показывается на странице перед экраном согласия (tech-debt #1). */
export async function createOAuthState(db: D1Database, state: string, userId: string, now: number, tgName?: string): Promise<void> {
  await db
    .prepare("INSERT INTO oauth_states (state, user_id, created_at, expires_at, tg_name) VALUES (?, ?, ?, ?, ?)")
    .bind(state, userId, now, now + OAUTH_STATE_TTL_MS, tgName ?? null)
    .run();
}

/** Действующая (не использована, не истекла) ссылка — не «гасит» её. */
export async function peekOAuthState(db: D1Database, state: string, now: number): Promise<{ userId: string; tgName: string | null; locale: string } | null> {
  const row = await db
    .prepare(
      `SELECT s.user_id, s.tg_name, u.locale
       FROM oauth_states s
       JOIN users u ON u.id = s.user_id
       WHERE s.state = ? AND s.used_at IS NULL AND s.expires_at > ?`,
    )
    .bind(state, now)
    .first<{ user_id: string; tg_name: string | null; locale: string }>();
  return row ? { userId: row.user_id, tgName: row.tg_name, locale: row.locale } : null;
}

/**
 * Переход на экран согласия (POST /oauth/google/start): к действующей ссылке привязываются PKCE verifier
 * (зашифрован) и хеш cookie браузера (tracks/telegram-login.md, A4/A5). Повторный переход (вторая вкладка,
 * другой браузер) перезаписывает: callback пройдёт только в браузере, нажавшем «Продолжить» последним.
 * false — ссылка не действует (использована, истекла, неизвестна).
 */
export async function bindOAuthState(db: D1Database, state: string, now: number, bind: { codeVerifierEnc: string; browserBinding: string }): Promise<boolean> {
  const res = await db
    .prepare("UPDATE oauth_states SET code_verifier_enc = ?, browser_binding = ? WHERE state = ? AND used_at IS NULL AND expires_at > ?")
    .bind(bind.codeVerifierEnc, bind.browserBinding, state, now)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export type ConsumeStateResult =
  | { ok: true; userId: string; tgName: string | null; codeVerifierEnc: string | null; browserBinding: string | null }
  | { ok: false; reason: "unknown" | "used" | "expired" };

/** Одноразово «гасит» state. Повторное использование и протухшие — ошибка (US-02). */
export async function consumeOAuthState(db: D1Database, state: string, now: number): Promise<ConsumeStateResult> {
  const row = await db
    .prepare(
      `UPDATE oauth_states
       SET used_at = ?
       WHERE state = ? AND used_at IS NULL AND expires_at > ?
       RETURNING user_id, tg_name, code_verifier_enc, browser_binding`,
    )
    .bind(now, state, now)
    .first<{ user_id: string; tg_name: string | null; code_verifier_enc: string | null; browser_binding: string | null }>();
  if (row) return { ok: true, userId: row.user_id, tgName: row.tg_name, codeVerifierEnc: row.code_verifier_enc, browserBinding: row.browser_binding };
  const existing = await db
    .prepare("SELECT used_at, expires_at FROM oauth_states WHERE state = ?")
    .bind(state)
    .first<{ used_at: number | null; expires_at: number }>();
  if (!existing) return { ok: false, reason: "unknown" };
  return { ok: false, reason: existing.used_at ? "used" : "expired" };
}

export interface LinkedAccount {
  accountId: string;
  email: string;
  timeZone: string;
  writableCalendars: number;
  /** Переподключили тот же аккаунт: календари, алиасы и выбор основного сохранены (tech-debt #19). */
  relinked: boolean;
  /** Заменённый другой аккаунт — его токен стоит отозвать (US-03). */
  replaced?: StoredCredentials;
}

export interface StoredCredentials {
  credentialsEnc: string;
  emailHash: string | null;
}

/**
 * Сохраняет привязку Google. В R0 у пользователя один аккаунт (схема допускает несколько, ADR-0003).
 * Другой аккаунт заменяет прежний вместе с календарями и алиасами (US-02).
 * Тот же аккаунт (переподключение) — upsert: наши id календарей не меняются, поэтому алиасы, основной календарь
 * и ссылки в диалоге переживают переподключение; исчезнувшие календари удаляются, новые добавляются (tech-debt #19).
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
  const writable = (c: GoogleCalendarListEntry) => c.accessRole === "writer" || c.accessRole === "owner";
  const writableCalendars = args.calendars.filter(writable).length;
  const existing = await db
    .prepare("SELECT id, email, email_hash, credentials_enc FROM provider_accounts WHERE user_id = ? AND provider = 'google'")
    .bind(args.userId)
    .first<{ id: string; email: string | null; email_hash: string | null; credentials_enc: string }>();

  if (existing && existing.email?.toLowerCase() === args.email.toLowerCase()) {
    const accountId = existing.id;
    const prevDefault = await db
      .prepare("SELECT provider_calendar_id FROM calendars WHERE account_id = ? AND is_default = 1")
      .bind(accountId)
      .first<{ provider_calendar_id: string }>();
    const defaultId = pickDefaultCalendar(
      prevDefault?.provider_calendar_id,
      args.calendars.map((c) => ({ id: c.id, writable: writable(c), ...(c.primary ? { primary: true } : {}) })),
    );
    await db.batch([
      db
        .prepare("UPDATE provider_accounts SET credentials_enc = ?, granted_scopes = ?, email_hash = ? WHERE id = ?")
        .bind(args.credentialsEnc, args.scopes, args.emailHash, accountId),
      // Исчезнувшие календари — вместе с их алиасами (ON DELETE CASCADE)
      db
        .prepare("DELETE FROM calendars WHERE account_id = ? AND provider_calendar_id NOT IN (SELECT value FROM json_each(?))")
        .bind(accountId, JSON.stringify(args.calendars.map((c) => c.id))),
      ...args.calendars.map((c) =>
        db
          .prepare(
            `INSERT INTO calendars (id, account_id, provider_calendar_id, title, time_zone, writable, is_default)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (account_id, provider_calendar_id) DO UPDATE SET
               title = excluded.title, time_zone = excluded.time_zone, writable = excluded.writable, is_default = excluded.is_default`,
          )
          .bind(crypto.randomUUID(), accountId, c.id, c.summary, c.timeZone ?? null, writable(c) ? 1 : 0, c.id === defaultId ? 1 : 0),
      ),
    ]);
    // Пояс не трогаем: пользователь мог выбрать его в /settings (US-07)
    const tz = await db.prepare("SELECT home_tz FROM users WHERE id = ?").bind(args.userId).first<{ home_tz: string }>();
    return { accountId, email: args.email, timeZone: tz?.home_tz ?? "UTC", writableCalendars, relinked: true };
  }

  const accountId = crypto.randomUUID();
  const primary = args.calendars.find((c) => c.primary);
  const timeZone = primary?.timeZone ?? "UTC";
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

  return {
    accountId,
    email: args.email,
    timeZone,
    writableCalendars,
    relinked: false,
    ...(existing ? { replaced: { credentialsEnc: existing.credentials_enc, emailHash: existing.email_hash } } : {}),
  };
}

export async function googleCredentials(db: D1Database, userId: string): Promise<StoredCredentials | null> {
  const row = await db
    .prepare("SELECT credentials_enc, email_hash FROM provider_accounts WHERE user_id = ? AND provider = 'google'")
    .bind(userId)
    .first<{ credentials_enc: string; email_hash: string | null }>();
  return row ? { credentialsEnc: row.credentials_enc, emailHash: row.email_hash } : null;
}

/**
 * Этот Google-аккаунт подключён и у другого пользователя бота. Отзыв в Google снимает разрешение приложения
 * целиком — отключил бы и его привязку (US-02: привязки независимы), поэтому тогда не отзываем.
 */
export async function linkedElsewhere(db: D1Database, emailHash: string | null, userId: string): Promise<boolean> {
  if (!emailHash) return false;
  const row = await db
    .prepare("SELECT 1 FROM provider_accounts WHERE provider = 'google' AND email_hash = ? AND user_id <> ? LIMIT 1")
    .bind(emailHash, userId)
    .first();
  return row !== null;
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
