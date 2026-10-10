// Экземпляр живёт одно действие (апдейт): календари читаются из D1 один раз, access token — из кеша в D1,
// на 401 — одно обновление и повтор (tech-debt #13).

import type { Clock } from "../clock";
import type { Config } from "../config";
import { aadFor, decryptSecret, encryptSecret } from "../crypto";
import { formatDate, formatMoment, makeDay, utcToLocal, type Moment } from "../dates/calendar";
import { googleTokens, saveAccessToken, type GoogleTokens } from "../db/accounts";
import { refreshAccessToken } from "../google/auth";
import { GoogleApiError } from "../google/errors";
import { accessTokenExpiresAt, accessTokenUsable } from "../google/token-cache";
import {
  deleteEvent,
  getEvent,
  insertEvent,
  listEvents,
  patchEvent,
  stopChannel,
  syncEvents,
  watchEvents,
  type GoogleEvent,
  type SyncPage,
} from "../google/calendar-api";
import { toCalendarError } from "./google-errors";
import {
  AuthRevoked,
  EventGone,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarProvider,
  type CreatedEvent,
  type EventList,
  type EventPatch,
  type EventRef,
  type NewEvent,
} from "./model";

/** Синк по ней обновляет снимок сразу, чтобы эхо push от нашей же записи не дало «изменения» (US-72). event null — удалено. */
export interface BotWrite {
  calendar: CalendarInfo;
  op: "create" | "update" | "delete";
  eventId: string;
  event: GoogleEvent | null;
  /** Нужно для «перенесено», когда прежнего снимка нет. */
  timeChanged: boolean;
}
export type WriteListener = (w: BotWrite) => Promise<void>;

const HIDDEN_EVENT_TYPES = new Set(["workingLocation", "focusTime"]);

function dayOf(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return makeDay(y!, m!, d!);
}

export function toDomainEvent(e: GoogleEvent, cal: CalendarInfo, tz: string): CalendarEvent | null {
  if (e.status === "cancelled" || HIDDEN_EVENT_TYPES.has(e.eventType ?? "")) return null;
  if (e.attendees?.some((a) => a.self && a.responseStatus === "declined")) return null;

  const base = {
    ref: { accountId: cal.accountId, calendarId: cal.id, providerEventId: e.id },
    calendarTitle: cal.title,
    title: e.summary?.trim() || "—",
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description } : {}),
    ...(e.reminders ? { reminders: { useDefault: e.reminders.useDefault ?? false, overrides: e.reminders.overrides ?? [] } } : {}),
    ...(e.hangoutLink ? { conferenceUrl: e.hangoutLink } : {}),
    free: e.transparency === "transparent",
    organizerIsSelf: e.organizer?.self ?? true,
    hasOtherAttendees: (e.attendees ?? []).some((a) => !a.self),
    recurring: !!e.recurringEventId,
    ...(e.recurringEventId ? { seriesId: e.recurringEventId } : {}),
    ...(e.etag ? { etag: e.etag } : {}),
  };

  if (e.start.date && e.end.date) {
    // В Google end.date — исключающая
    return { ...base, allDay: true, startDay: dayOf(e.start.date), endDay: dayOf(e.end.date) - 1 };
  }
  if (!e.start.dateTime || !e.end.dateTime) return null;
  const start = utcToLocal(Date.parse(e.start.dateTime), tz);
  const end = utcToLocal(Date.parse(e.end.dateTime), tz);
  return { ...base, allDay: false, start, end, startDay: start.day, endDay: end.day };
}

async function google<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toCalendarError(e);
  }
}

export class GoogleCalendarProvider implements CalendarProvider {
  /** Промис, а не строка: параллельные запросы не обновляют токен дважды. */
  private tokenP?: Promise<string>;
  /** По этому токену уже запущено обновление после 401. */
  private rejectedToken?: string;
  private calendarsP?: Promise<CalendarInfo[]>;

  constructor(
    private readonly config: Config,
    private readonly db: D1Database,
    private readonly userId: string,
    private readonly clock: Clock,
    /** Общие календари дома (US-90); не задано — все календари пользователя. */
    private readonly onlyCalendarIds?: readonly string[],
    private readonly onWrite?: WriteListener,
    /** Основной общий календарь дома — вместо основного календаря владельца. */
    private readonly defaultOverride?: string,
  ) {}

  private async written(w: BotWrite): Promise<void> {
    if (!this.onWrite) return;
    try {
      await this.onWrite(w);
    } catch (e) {
      console.error("write listener failed", e instanceof Error ? e.message : e);
    }
  }

  calendars(): Promise<CalendarInfo[]> {
    this.calendarsP ??= this.loadCalendars().catch((e) => {
      this.calendarsP = undefined;
      throw e;
    });
    return this.calendarsP;
  }

  private async loadCalendars(): Promise<CalendarInfo[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.account_id, c.provider_calendar_id, c.title, c.writable, c.is_default, c.time_zone,
                (SELECT json_group_array(alias) FROM calendar_aliases al WHERE al.calendar_id = c.id AND al.user_id = a.user_id) AS aliases
         FROM calendars c
         JOIN provider_accounts a ON a.id = c.account_id
         WHERE a.user_id = ? AND a.provider = 'google'
         ORDER BY c.is_default DESC, c.title`,
      )
      .bind(this.userId)
      .all<{
        id: string;
        account_id: string;
        provider_calendar_id: string;
        title: string;
        writable: number;
        is_default: number;
        time_zone: string | null;
        aliases: string | null;
      }>();
    const only = this.onlyCalendarIds;
    return results
      .filter((r) => !only || only.includes(r.id))
      .map((r) => ({
        id: r.id,
        accountId: r.account_id,
        providerCalendarId: r.provider_calendar_id,
        title: r.title,
        writable: r.writable === 1,
        isDefault: this.defaultOverride ? r.id === this.defaultOverride : r.is_default === 1,
        aliases: (JSON.parse(r.aliases ?? "[]") as string[]).sort(),
        ...(r.time_zone ? { timeZone: r.time_zone } : {}),
      }));
  }

  private token(): Promise<string> {
    this.tokenP ??= this.loadToken(false).catch((e) => {
      this.tokenP = undefined;
      throw e;
    });
    return this.tokenP;
  }

  private async loadToken(force: boolean): Promise<string> {
    const row = await googleTokens(this.db, this.userId);
    // Аккаунт отключили в параллельном апдейте — для пользователя это как отозванный доступ
    if (!row) throw new AuthRevoked("no google account");
    if (!force && row.accessTokenEnc && accessTokenUsable(row.accessExpiresAt, this.clock.now())) {
      // Не расшифровался (сменили ключ) — просто обновим
      const cached = await decryptSecret(row.accessTokenEnc, this.config.tokenKeys, aadFor.access(row.accountId)).catch(() => null);
      if (cached) return cached;
    }
    return this.refresh(row);
  }

  private async refresh(row: GoogleTokens): Promise<string> {
    // Не расшифровался (сменили ключ) — для пользователя это как отозванный доступ
    const refresh = await decryptSecret(row.credentialsEnc, this.config.tokenKeys, aadFor.account(row.accountId)).catch(() => {
      throw new AuthRevoked("refresh token cannot be decrypted");
    });
    const fresh = await google(() => refreshAccessToken(this.config, refresh));
    // Кеш — оптимизация: не записался (D1) — действие всё равно выполняем
    try {
      const sealed = await encryptSecret(fresh.accessToken, this.config.tokenKeys, aadFor.access(row.accountId));
      await saveAccessToken(this.db, row.accountId, sealed, accessTokenExpiresAt(this.clock.now(), fresh.expiresInSec));
    } catch (e) {
      console.warn("access token cache write failed", e instanceof Error ? e.message : e);
    }
    return fresh.accessToken;
  }

  /**
   * 401 — токен из кеша отозван или истёк раньше срока: обновить один раз и повторить (параллельные 401 на тот же токен
   * обновляют его один раз). Если доступ отозван, обновление даст invalid_grant → AuthRevoked (US-02).
   */
  private api<T>(call: (token: string) => Promise<T>): Promise<T> {
    return google(async () => {
      const token = await this.token();
      try {
        return await call(token);
      } catch (e) {
        if (!(e instanceof GoogleApiError && e.status === 401)) throw e;
        return call(await this.renewAfter401(token));
      }
    });
  }

  private renewAfter401(rejected: string): Promise<string> {
    if (this.rejectedToken !== rejected) {
      this.rejectedToken = rejected;
      this.tokenP = this.loadToken(true);
    }
    return this.tokenP!;
  }

  async listEvents(fromUtcMs: number, toUtcMs: number, tz: string): Promise<EventList> {
    const calendars = await this.calendars();
    const settled = await Promise.allSettled(
      calendars.map(async (cal) => {
        const raw = await this.api((token) =>
          listEvents(this.config.googleApiBase, token, cal.providerCalendarId, new Date(fromUtcMs).toISOString(), new Date(toUtcMs).toISOString(), tz),
        );
        return raw.map((e) => toDomainEvent(e, cal, tz)).filter((e): e is CalendarEvent => e !== null);
      }),
    );
    const result: EventList = { events: [], failed: [] };
    settled.forEach((r, i) => {
      const cal = calendars[i]!;
      if (r.status === "fulfilled") result.events.push(...r.value);
      else {
        console.warn("calendar list failed", cal.id, r.reason instanceof Error ? r.reason.message : r.reason);
        result.failed.push({ id: cal.id, title: cal.title });
      }
    });
    const firstError = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    // Не загрузился ни один — это не «встреч нет», а ошибка
    if (firstError && result.failed.length === calendars.length) throw firstError.reason;
    return result;
  }

  private async calendar(id: string): Promise<CalendarInfo> {
    const cal = (await this.calendars()).find((c) => c.id === id);
    // Календарь пропал после переподключения без него (tech-debt #19)
    if (!cal) throw new EventGone(`unknown calendar ${id}`);
    return cal;
  }

  async createEvent(e: NewEvent): Promise<CreatedEvent> {
    const cal = await this.calendar(e.calendarId);
    // Свой id (Google принимает только base32hex): повтор той же вставки даёт 409, а не дубль события
    const id = e.idempotencyKey ? `cab${e.idempotencyKey.toLowerCase().replace(/[^0-9a-v]/g, "")}` : undefined;
    const time = e.allDay
      ? { start: { date: formatDate(e.startDay) }, end: { date: formatDate(e.endDay + 1) } } // end.date — исключающая
      : { start: { dateTime: `${formatMoment(e.start!)}:00`, timeZone: e.tz }, end: { dateTime: `${formatMoment(e.end!)}:00`, timeZone: e.tz } };
    const created = await this.api((token) =>
      insertEvent(this.config.googleApiBase, token, cal.providerCalendarId, {
        ...(id ? { id } : {}),
        summary: e.title,
        ...(e.location ? { location: e.location } : {}),
        ...(e.description ? { description: e.description } : {}),
        ...(e.recurrence ? { recurrence: e.recurrence } : {}),
        ...(e.reminders ? { reminders: { useDefault: false, overrides: e.reminders.map((minutes) => ({ method: "popup" as const, minutes })) } } : {}),
        ...time,
      }),
    );
    await this.written({ calendar: cal, op: "create", eventId: created.id, event: created, timeChanged: true });
    return {
      ref: { accountId: cal.accountId, calendarId: cal.id, providerEventId: created.id },
      ...(created.htmlLink ? { link: created.htmlLink } : {}),
      ...(created.etag ? { etag: created.etag } : {}),
    };
  }

  async getEvent(ref: EventRef, tz: string): Promise<CalendarEvent | null> {
    const cal = await this.calendar(ref.calendarId);
    const raw = await this.api((token) => getEvent(this.config.googleApiBase, token, cal.providerCalendarId, ref.providerEventId, tz));
    return raw ? toDomainEvent(raw, cal, tz) : null;
  }

  async updateEvent(ref: EventRef, patch: EventPatch, opts: { notify: boolean; etag?: string }): Promise<{ etag?: string }> {
    const cal = await this.calendar(ref.calendarId);
    const time = (m: Moment) => ({ dateTime: `${formatMoment(m)}:00`, timeZone: patch.tz });
    const updated = await this.api((token) =>
      patchEvent(
        this.config.googleApiBase,
        token,
        cal.providerCalendarId,
        ref.providerEventId,
        {
          ...(patch.title !== undefined ? { summary: patch.title } : {}),
          ...(patch.location !== undefined ? { location: patch.location } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          // PATCH сливает вложенные объекты: overrides передаём всегда (пустой — при useDefault), иначе старые останутся
          ...(patch.reminders
            ? { reminders: { useDefault: patch.reminders.useDefault, overrides: patch.reminders.useDefault ? [] : patch.reminders.overrides } }
            : {}),
          ...(patch.start ? { start: time(patch.start) } : {}),
          ...(patch.end ? { end: time(patch.end) } : {}),
        },
        { sendUpdates: opts.notify ? "all" : "none", ...(opts.etag ? { etag: opts.etag } : {}) },
      ),
    );
    await this.written({ calendar: cal, op: "update", eventId: ref.providerEventId, event: updated, timeChanged: !!(patch.start || patch.end) });
    return updated.etag ? { etag: updated.etag } : {};
  }

  async deleteEvent(ref: EventRef, opts: { notify: boolean; etag?: string }): Promise<"deleted" | "gone"> {
    const cal = await this.calendar(ref.calendarId);
    const result = await this.api((token) =>
      deleteEvent(this.config.googleApiBase, token, cal.providerCalendarId, ref.providerEventId, {
        sendUpdates: opts.notify ? "all" : "none",
        ...(opts.etag ? { etag: opts.etag } : {}),
      }),
    );
    await this.written({ calendar: cal, op: "delete", eventId: ref.providerEventId, event: null, timeChanged: false });
    return result;
  }

  async declineEvent(ref: EventRef, tz: string): Promise<void> {
    const cal = await this.calendar(ref.calendarId);
    const raw = await this.api((token) => getEvent(this.config.googleApiBase, token, cal.providerCalendarId, ref.providerEventId, tz));
    if (!raw) throw new EventGone("event not found");
    const attendees = (raw.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus: "declined" } : a));
    const updated = await this.api((token) =>
      patchEvent(this.config.googleApiBase, token, cal.providerCalendarId, ref.providerEventId, { attendees }, { sendUpdates: "all" }),
    );
    await this.written({ calendar: cal, op: "update", eventId: ref.providerEventId, event: updated, timeChanged: false });
  }

  // Синк (ADR-0005 §2) есть только у Google — поэтому вне интерфейса CalendarProvider.

  /** Истёкший syncToken — SyncTokenExpired, а не ошибка календаря. */
  syncEvents(providerCalendarId: string, opts: { syncToken?: string; timeMin?: string; timeMax?: string }): Promise<SyncPage> {
    return this.api((token) => syncEvents(this.config.googleApiBase, token, providerCalendarId, opts));
  }

  watch(providerCalendarId: string, channel: { id: string; token: string; address: string; expiration: number }) {
    return this.api((token) => watchEvents(this.config.googleApiBase, token, providerCalendarId, channel));
  }

  stopChannel(channel: { id: string; resourceId: string }): Promise<void> {
    return this.api((token) => stopChannel(this.config.googleApiBase, token, channel));
  }
}
