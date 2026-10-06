// D1 для синхронизации календарей (ADR-0005 §2, миграция 0012): calendar_sync (подписка на календарь провайдера),
// event_snapshots (последнее состояние событий), bot_writes (журнал записей бота), change_notices (outbox уведомлений US-72),
// и связь «календарь → чаты», где он виден.

import { parseSettings, type UserSettings } from "./settings";
import type { Snapshot } from "../sync/logic";

/** Подписные календари (праздники, дни рождения контактов) не синхронизируем: только чтение, изменений от людей нет. */
const SKIP_CALENDAR = "%@group.v.calendar.google.com";

export interface SyncRow {
  pcid: string;
  ownerCalendarId: string | null;
  syncToken: string | null;
  baselineAt: number | null;
  lastSyncAt: number | null;
  lastChangeAt: number | null;
  channelId: string | null;
  channelToken: string | null;
  channelResourceId: string | null;
  channelExpiresAt: number | null;
}

interface SyncDbRow {
  provider_calendar_id: string;
  owner_calendar_id: string | null;
  sync_token: string | null;
  baseline_at: number | null;
  last_sync_at: number | null;
  last_change_at: number | null;
  channel_id: string | null;
  channel_token: string | null;
  channel_resource_id: string | null;
  channel_expires_at: number | null;
  /** Здоровье синка для админки (миграция 0016): ok | unavailable | error, класс ошибки, пересинхронизация после 410. */
  last_outcome?: string | null;
  last_error_at?: number | null;
  last_error?: string | null;
  last_resync_at?: number | null;
}

const toSyncRow = (r: SyncDbRow): SyncRow => ({
  pcid: r.provider_calendar_id,
  ownerCalendarId: r.owner_calendar_id,
  syncToken: r.sync_token,
  baselineAt: r.baseline_at,
  lastSyncAt: r.last_sync_at,
  lastChangeAt: r.last_change_at,
  channelId: r.channel_id,
  channelToken: r.channel_token,
  channelResourceId: r.channel_resource_id,
  channelExpiresAt: r.channel_expires_at,
});

export async function getSyncRow(db: D1Database, pcid: string): Promise<SyncRow | null> {
  const r = await db.prepare("SELECT * FROM calendar_sync WHERE provider_calendar_id = ?").bind(pcid).first<SyncDbRow>();
  return r ? toSyncRow(r) : null;
}

export async function syncRowByChannel(db: D1Database, channelId: string): Promise<SyncRow | null> {
  const r = await db.prepare("SELECT * FROM calendar_sync WHERE channel_id = ?").bind(channelId).first<SyncDbRow>();
  return r ? toSyncRow(r) : null;
}

/** Строки calendar_sync для всех подключённых календарей (кроме подписных); вернуть id календарей провайдера. */
export async function ensureSyncRows(db: D1Database, userId?: string): Promise<string[]> {
  const filter = userId ? "AND a.user_id = ?2" : "";
  const { results } = await db
    .prepare(
      `SELECT DISTINCT c.provider_calendar_id AS pcid
       FROM calendars c
       JOIN provider_accounts a ON a.id = c.account_id
       WHERE a.provider = 'google' AND c.provider_calendar_id NOT LIKE ?1 ${filter}`,
    )
    .bind(SKIP_CALENDAR, ...(userId ? [userId] : []))
    .all<{ pcid: string }>();
  if (results.length) {
    await db.batch(results.map((r) => db.prepare("INSERT OR IGNORE INTO calendar_sync (provider_calendar_id) VALUES (?)").bind(r.pcid)));
  }
  return results.map((r) => r.pcid);
}

/** Чей календарь читает синк: прежний владелец, если он ещё подключён, иначе — строка с правом записи, иначе любая. */
export async function pickOwner(db: D1Database, pcid: string, current: string | null): Promise<{ calendarId: string; userId: string } | null> {
  const r = await db
    .prepare(
      `SELECT c.id, a.user_id
       FROM calendars c
       JOIN provider_accounts a ON a.id = c.account_id
       WHERE c.provider_calendar_id = ? AND a.provider = 'google'
       ORDER BY (c.id = ?) DESC, c.writable DESC, a.created_at, a.rowid, c.rowid
       LIMIT 1`,
    )
    .bind(pcid, current ?? "")
    .first<{ id: string; user_id: string }>();
  return r ? { calendarId: r.id, userId: r.user_id } : null;
}

/** Захватить календарь на синк (один синк за раз). false — уже идёт другой. */
export async function acquireLease(db: D1Database, pcid: string, now: number, ttlMs: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE calendar_sync SET lease_until = ?1 WHERE provider_calendar_id = ?2 AND (lease_until IS NULL OR lease_until < ?3)")
    .bind(now + ttlMs, pcid, now)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function releaseLease(db: D1Database, pcid: string): Promise<void> {
  await db.prepare("UPDATE calendar_sync SET lease_until = NULL WHERE provider_calendar_id = ?").bind(pcid).run();
}

export function updateSyncRow(db: D1Database, pcid: string, patch: Partial<Record<keyof SyncDbRow, string | number | null>>): D1PreparedStatement {
  const keys = Object.keys(patch);
  return db
    .prepare(`UPDATE calendar_sync SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")} WHERE provider_calendar_id = ?1`)
    .bind(pcid, ...keys.map((k) => patch[k as keyof SyncDbRow] ?? null));
}

/** Календарь больше никем не подключён: убрать подписку, снимки, журнал, ожидающие напоминания. */
export async function dropSync(db: D1Database, pcid: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM calendar_sync WHERE provider_calendar_id = ?").bind(pcid),
    db.prepare("DELETE FROM event_snapshots WHERE provider_calendar_id = ?").bind(pcid),
    db.prepare("DELETE FROM bot_writes WHERE provider_calendar_id = ?").bind(pcid),
  ]);
}

/** Подписки календарей, которых не осталось ни у кого (отключение, замена аккаунта). */
export async function orphanSyncs(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT provider_calendar_id AS pcid FROM calendar_sync s WHERE NOT EXISTS (SELECT 1 FROM calendars c WHERE c.provider_calendar_id = s.provider_calendar_id)",
    )
    .all<{ pcid: string }>();
  return results.map((r) => r.pcid);
}

/** Каналы push, открытые токеном этого пользователя (их может остановить только он — перед отключением, US-03). */
export async function channelsOwnedBy(db: D1Database, userId: string): Promise<SyncRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.*
       FROM calendar_sync s
       JOIN calendars c ON c.id = s.owner_calendar_id
       JOIN provider_accounts a ON a.id = c.account_id
       WHERE a.user_id = ? AND s.channel_id IS NOT NULL`,
    )
    .bind(userId)
    .all<SyncDbRow>();
  return results.map(toSyncRow);
}

// --- Снимки событий -------------------------------------------------------------------------------------------------

interface SnapshotDbRow {
  event_id: string;
  series_id: string | null;
  status: string;
  title: string | null;
  location: string | null;
  conference_url: string | null;
  html_link: string | null;
  organizer: string | null;
  all_day: number;
  start_ms: number | null;
  end_ms: number | null;
  start_date: string | null;
  end_date: string | null;
  declined: number;
  etag: string | null;
}

const toSnapshot = (r: SnapshotDbRow): Snapshot => ({
  eventId: r.event_id,
  ...(r.series_id ? { seriesId: r.series_id } : {}),
  status: r.status,
  title: r.title ?? "—",
  ...(r.location ? { location: r.location } : {}),
  ...(r.conference_url ? { conferenceUrl: r.conference_url } : {}),
  ...(r.html_link ? { htmlLink: r.html_link } : {}),
  ...(r.organizer ? { organizer: r.organizer } : {}),
  allDay: r.all_day === 1,
  startMs: r.start_ms,
  endMs: r.end_ms,
  ...(r.start_date ? { startDate: r.start_date } : {}),
  ...(r.end_date ? { endDate: r.end_date } : {}),
  declined: r.declined === 1,
  ...(r.etag ? { etag: r.etag } : {}),
});

export async function snapshotsByIds(db: D1Database, pcid: string, ids: string[]): Promise<Map<string, Snapshot>> {
  if (ids.length === 0) return new Map();
  const { results } = await db
    .prepare("SELECT * FROM event_snapshots WHERE provider_calendar_id = ? AND event_id IN (SELECT value FROM json_each(?))")
    .bind(pcid, JSON.stringify(ids))
    .all<SnapshotDbRow>();
  return new Map(results.map((r) => [r.event_id, toSnapshot(r)]));
}

/** Снимки с началом в [from, to) — окно полной синхронизации и горизонт напоминаний. */
export async function snapshotsBetween(db: D1Database, pcid: string, from: number, to: number): Promise<Snapshot[]> {
  const { results } = await db
    .prepare("SELECT * FROM event_snapshots WHERE provider_calendar_id = ? AND start_ms >= ? AND start_ms < ?")
    .bind(pcid, from, to)
    .all<SnapshotDbRow>();
  return results.map(toSnapshot);
}

/**
 * Записать снимки — одним запросом на сотню (json_each): на Workers Free у вызова лимит числа запросов к D1,
 * а полная синхронизация — это сотни событий.
 */
export function upsertSnapshots(db: D1Database, pcid: string, snaps: Snapshot[], now: number): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < snaps.length; i += 100) {
    const rows = snaps.slice(i, i + 100).map((s) => ({
      e: s.eventId,
      sr: s.seriesId ?? null,
      st: s.status,
      ti: s.title,
      lo: s.location ?? null,
      cu: s.conferenceUrl ?? null,
      hl: s.htmlLink ?? null,
      or: s.organizer ?? null,
      ad: s.allDay ? 1 : 0,
      sm: s.startMs,
      em: s.endMs,
      sd: s.startDate ?? null,
      ed: s.endDate ?? null,
      dc: s.declined ? 1 : 0,
      et: s.etag ?? null,
    }));
    out.push(
      db
        .prepare(
          `INSERT INTO event_snapshots (provider_calendar_id, event_id, series_id, status, title, location, conference_url, html_link, organizer,
                                        all_day, start_ms, end_ms, start_date, end_date, declined, etag, synced_at)
           SELECT ?1, j.value ->> '$.e', j.value ->> '$.sr', j.value ->> '$.st', j.value ->> '$.ti', j.value ->> '$.lo', j.value ->> '$.cu',
                  j.value ->> '$.hl', j.value ->> '$.or', j.value ->> '$.ad', j.value ->> '$.sm', j.value ->> '$.em', j.value ->> '$.sd',
                  j.value ->> '$.ed', j.value ->> '$.dc', j.value ->> '$.et', ?3
           FROM json_each(?2) j WHERE true
           ON CONFLICT (provider_calendar_id, event_id) DO UPDATE SET
             series_id = excluded.series_id, status = excluded.status, title = excluded.title, location = excluded.location,
             conference_url = excluded.conference_url, html_link = excluded.html_link, organizer = excluded.organizer,
             all_day = excluded.all_day, start_ms = excluded.start_ms, end_ms = excluded.end_ms, start_date = excluded.start_date,
             end_date = excluded.end_date, declined = excluded.declined, etag = excluded.etag, synced_at = excluded.synced_at`,
        )
        .bind(pcid, JSON.stringify(rows), now),
    );
  }
  return out;
}

export const deleteSnapshots = (db: D1Database, pcid: string, ids: string[]) =>
  db.prepare("DELETE FROM event_snapshots WHERE provider_calendar_id = ? AND event_id IN (SELECT value FROM json_each(?))").bind(pcid, JSON.stringify(ids));

/** Ретеншн: прошедшие события (2 дня после конца), журнал записей бота — 2 дня. */
export function pruneStatements(db: D1Database, pcid: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM event_snapshots WHERE provider_calendar_id = ? AND coalesce(end_ms, start_ms) < ?").bind(pcid, now - 2 * 86_400_000),
    db.prepare("DELETE FROM bot_writes WHERE provider_calendar_id = ? AND at < ?").bind(pcid, now - 2 * 86_400_000),
  ];
}

// --- Журнал записей бота ---------------------------------------------------------------------------------------------

export interface BotWriteRow {
  eventId: string;
  etag: string | null;
  chatId: string;
  authorUserId: string | null;
  authorName: string | null;
  at: number;
}

export function insertBotWrite(db: D1Database, pcid: string, w: Omit<BotWriteRow, never>): D1PreparedStatement {
  return db
    .prepare("INSERT INTO bot_writes (provider_calendar_id, event_id, etag, chat_id, author_user_id, author_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(pcid, w.eventId, w.etag, w.chatId, w.authorUserId, w.authorName, w.at);
}

/** Записи бота по событиям (их id или id серии) с момента since — новые первыми. */
export async function botWritesFor(db: D1Database, pcid: string, ids: string[], since: number): Promise<BotWriteRow[]> {
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT event_id, etag, chat_id, author_user_id, author_name, at FROM bot_writes
       WHERE provider_calendar_id = ? AND at >= ? AND event_id IN (SELECT value FROM json_each(?))
       ORDER BY at DESC`,
    )
    .bind(pcid, since, JSON.stringify(ids))
    .all<{ event_id: string; etag: string | null; chat_id: string; author_user_id: string | null; author_name: string | null; at: number }>();
  return results.map((r) => ({ eventId: r.event_id, etag: r.etag, chatId: r.chat_id, authorUserId: r.author_user_id, authorName: r.author_name, at: r.at }));
}

// --- Календарь → чаты ------------------------------------------------------------------------------------------------

/** Чат, где виден календарь: личный чат пользователя или групповой чат дома. */
export interface CalendarChat {
  chatId: string;
  /** Чей это личный чат (для группового чата дома — нет). */
  userId: string | null;
  locale: string;
  tz: string;
  settings: UserSettings;
  /** Календарь доступен в этом чате на запись — уведомления по умолчанию только о таких (US-72). */
  writable: boolean;
}

/**
 * «Календарь → чаты» (US-72, US-71): все чаты, где календарь виден, без повторов по чату:
 * 1) личные чаты пользователей, у которых подключён этот календарь провайдера (тот же provider_calendar_id в разных аккаунтах);
 * 2) личные чаты участников дома, у которых этого календаря нет в своём Google, если он — общий календарь их дома (видят
 *    его через Google владельца, ревью R1 блокер 1, QA-01/08);
 * 3) групповые чаты, привязанные к дому с этим общим календарём (US-94): язык и пояс — владельца дома, настройки — по умолчанию.
 */
export async function chatsForCalendar(db: D1Database, pcid: string): Promise<CalendarChat[]> {
  const { results } = await db
    .prepare(
      `SELECT chat_id, user_id, locale, home_tz, settings_json, max(writable) AS writable
       FROM (
         SELECT ci.external_id AS chat_id, u.id AS user_id, u.locale, u.home_tz, u.settings_json, c.writable
         FROM calendars c
         JOIN provider_accounts a ON a.id = c.account_id
         JOIN users u ON u.id = a.user_id
         JOIN channel_identities ci ON ci.user_id = u.id AND ci.channel = 'telegram'
         WHERE c.provider_calendar_id = ?1
         UNION ALL
         SELECT ci.external_id, u.id, u.locale, u.home_tz, u.settings_json, c.writable
         FROM calendars c
         JOIN household_calendars hc ON hc.calendar_id = c.id
         JOIN household_members m ON m.household_id = hc.household_id
         JOIN users u ON u.id = m.user_id
         JOIN channel_identities ci ON ci.user_id = u.id AND ci.channel = 'telegram'
         WHERE c.provider_calendar_id = ?1
           AND NOT EXISTS (SELECT 1 FROM calendars oc JOIN provider_accounts pa ON pa.id = oc.account_id
                           WHERE pa.user_id = u.id AND oc.provider_calendar_id = ?1)
         UNION ALL
         SELECT cv.chat_id, NULL, o.locale, o.home_tz, '{}', c.writable
         FROM calendars c
         JOIN household_calendars hc ON hc.calendar_id = c.id
         JOIN households h ON h.id = hc.household_id
         JOIN users o ON o.id = h.owner_user_id
         JOIN conversations cv ON cv.household_id = h.id AND cv.kind = 'group'
         WHERE c.provider_calendar_id = ?1
       )
       GROUP BY chat_id
       ORDER BY chat_id`,
    )
    .bind(pcid)
    .all<{ chat_id: string; user_id: string | null; locale: string; home_tz: string; settings_json: string; writable: number }>();
  return results.map((r) => ({
    chatId: r.chat_id,
    userId: r.user_id,
    locale: r.locale,
    tz: r.home_tz,
    settings: parseSettings(r.settings_json),
    writable: r.writable === 1,
  }));
}

/**
 * Календари провайдера, которые видит пользователь (для напоминаний US-71): свои подключённые и общие календари его дома
 * (участник видит их через Google владельца, QA-02).
 */
export async function userCalendarIds(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT c.provider_calendar_id AS pcid
       FROM calendars c JOIN provider_accounts a ON a.id = c.account_id
       WHERE a.user_id = ?1
       UNION
       SELECT c.provider_calendar_id
       FROM household_members m
       JOIN household_calendars hc ON hc.household_id = m.household_id
       JOIN calendars c ON c.id = hc.calendar_id
       WHERE m.user_id = ?1`,
    )
    .bind(userId)
    .all<{ pcid: string }>();
  return results.map((r) => r.pcid);
}

// --- Outbox уведомлений ------------------------------------------------------------------------------------------------

export interface NoticeRow {
  chatId: string;
  userId: string | null;
  noticeJson: string;
  deliverAt: number;
}

/** Строки outbox — одним запросом (json_each). */
export function insertNotices(db: D1Database, rows: NoticeRow[], now: number): D1PreparedStatement[] {
  if (rows.length === 0) return [];
  const data = rows.map((r) => ({ id: crypto.randomUUID(), c: r.chatId, u: r.userId, n: r.noticeJson, d: r.deliverAt }));
  return [
    db
      .prepare(
        `INSERT INTO change_notices (id, chat_id, user_id, notice_json, created_at, deliver_at, status)
         SELECT j.value ->> '$.id', j.value ->> '$.c', j.value ->> '$.u', j.value ->> '$.n', ?2, j.value ->> '$.d', 'queued'
         FROM json_each(?1) j`,
      )
      .bind(JSON.stringify(data), now),
  ];
}

/** Забрать наступившие уведомления чата на отправку (queued → sending). */
export async function claimDueNotices(db: D1Database, chatId: string, now: number): Promise<{ id: string; notice_json: string }[]> {
  const { results } = await db
    .prepare(
      `UPDATE change_notices SET status = 'sending', sent_at = ?2
       WHERE chat_id = ?1 AND status = 'queued' AND deliver_at <= ?2
       RETURNING id, notice_json, created_at`,
    )
    .bind(chatId, now)
    .all<{ id: string; notice_json: string; created_at: number }>();
  return results.sort((a, b) => a.created_at - b.created_at);
}

export async function sentRecently(db: D1Database, chatId: string, since: number): Promise<number> {
  const r = await db
    .prepare("SELECT count(*) AS n FROM change_notices WHERE chat_id = ? AND status = 'sent' AND sent_at >= ?")
    .bind(chatId, since)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function finishNotices(db: D1Database, ids: string[], status: "sent" | "queued", now: number): Promise<void> {
  if (ids.length === 0) return;
  await db
    .prepare("UPDATE change_notices SET status = ?1, sent_at = ?2 WHERE id IN (SELECT value FROM json_each(?3))")
    .bind(status, status === "sent" ? now : null, JSON.stringify(ids))
    .run();
}

/** Ретеншн outbox: отправленные — 2 дня; зависшие в sending (оборвалась отправка) — вернуть в queued через 10 минут. */
export async function pruneNotices(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM change_notices WHERE status = 'sent' AND sent_at < ?").bind(now - 2 * 86_400_000),
    db.prepare("UPDATE change_notices SET status = 'queued' WHERE status = 'sending' AND sent_at < ?").bind(now - 10 * 60_000),
  ]);
}
