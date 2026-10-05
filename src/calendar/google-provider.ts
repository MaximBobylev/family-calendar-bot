// CalendarProvider для Google: календари из D1, события из Google Calendar API.

import type { Config } from "../config";
import { decryptSecret } from "../crypto";
import { formatDate, formatMoment, makeDay, utcToLocal, type Moment } from "../dates/calendar";
import { GoogleAuthError, refreshAccessToken } from "../google/auth";
import { deleteEvent, getEvent, GoogleApiError, insertEvent, listEvents, patchEvent, type GoogleEvent } from "../google/calendar-api";
import type { CalendarEvent, CalendarInfo, CalendarProvider, CreatedEvent, EventPatch, EventRef, NewEvent } from "./model";

/** Типы событий, которые не показываем (US-20). */
const HIDDEN_EVENT_TYPES = new Set(["workingLocation", "focusTime"]);

function dayOf(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return makeDay(y!, m!, d!);
}

export function toDomainEvent(e: GoogleEvent, cal: CalendarInfo, tz: string): CalendarEvent | null {
  if (e.status === "cancelled" || HIDDEN_EVENT_TYPES.has(e.eventType ?? "")) return null;
  // Отклонённые приглашения скрываем (US-20)
  if (e.attendees?.some((a) => a.self && a.responseStatus === "declined")) return null;

  const base = {
    ref: { accountId: cal.accountId, calendarId: cal.id, providerEventId: e.id },
    calendarTitle: cal.title,
    title: e.summary?.trim() || "—",
    ...(e.location ? { location: e.location } : {}),
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

export class GoogleCalendarProvider implements CalendarProvider {
  private accessToken?: string;

  constructor(
    private readonly config: Config,
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  async calendars(): Promise<CalendarInfo[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.account_id, c.provider_calendar_id, c.title, c.writable, c.is_default
         FROM calendars c JOIN provider_accounts a ON a.id = c.account_id
         WHERE a.user_id = ? AND a.provider = 'google'
         ORDER BY c.is_default DESC, c.title`,
      )
      .bind(this.userId)
      .all<{ id: string; account_id: string; provider_calendar_id: string; title: string; writable: number; is_default: number }>();
    return results.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      providerCalendarId: r.provider_calendar_id,
      title: r.title,
      writable: r.writable === 1,
      isDefault: r.is_default === 1,
    }));
  }

  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const row = await this.db
      .prepare("SELECT credentials_enc FROM provider_accounts WHERE user_id = ? AND provider = 'google'")
      .bind(this.userId)
      .first<{ credentials_enc: string }>();
    if (!row) throw new Error("no google account");
    // Не расшифровался (сменили ключ) — для пользователя это как отозванный доступ: переподключить
    const refresh = await decryptSecret(row.credentials_enc, this.config.tokenEncryptionKey).catch(() => {
      throw new GoogleAuthError("refresh token cannot be decrypted", true);
    });
    this.accessToken = await refreshAccessToken(this.config, refresh);
    return this.accessToken;
  }

  async listEvents(fromUtcMs: number, toUtcMs: number, tz: string): Promise<CalendarEvent[]> {
    const token = await this.token();
    const calendars = await this.calendars();
    const perCalendar = await Promise.all(
      calendars.map(async (cal) => {
        const raw = await listEvents(
          this.config.googleApiBase, token, cal.providerCalendarId,
          new Date(fromUtcMs).toISOString(), new Date(toUtcMs).toISOString(), tz,
        );
        return raw.map((e) => toDomainEvent(e, cal, tz)).filter((e): e is CalendarEvent => e !== null);
      }),
    );
    return perCalendar.flat();
  }

  private async calendar(id: string): Promise<CalendarInfo> {
    const cal = (await this.calendars()).find((c) => c.id === id);
    if (!cal) throw new Error(`unknown calendar ${id}`);
    return cal;
  }

  async createEvent(e: NewEvent): Promise<CreatedEvent> {
    const cal = await this.calendar(e.calendarId);
    // Собственный id (base32hex) — повтор той же вставки даёт 409, а не дубль события (ревью 2026-10-05)
    const id = e.idempotencyKey ? `cab${e.idempotencyKey.toLowerCase().replace(/[^0-9a-v]/g, "")}` : undefined;
    const time = e.allDay
      ? { start: { date: formatDate(e.startDay) }, end: { date: formatDate(e.endDay + 1) } } // end.date — исключающая
      : { start: { dateTime: `${formatMoment(e.start!)}:00`, timeZone: e.tz }, end: { dateTime: `${formatMoment(e.end!)}:00`, timeZone: e.tz } };
    const created = await insertEvent(this.config.googleApiBase, await this.token(), cal.providerCalendarId, {
      ...(id ? { id } : {}),
      summary: e.title,
      ...(e.location ? { location: e.location } : {}),
      ...time,
    });
    return { ref: { accountId: cal.accountId, calendarId: cal.id, providerEventId: created.id }, ...(created.htmlLink ? { link: created.htmlLink } : {}) };
  }

  async renameEvent(ref: EventRef, title: string): Promise<void> {
    const cal = await this.calendar(ref.calendarId);
    await patchEvent(this.config.googleApiBase, await this.token(), cal.providerCalendarId, ref.providerEventId, { summary: title });
  }

  async getEvent(ref: EventRef, tz: string): Promise<CalendarEvent | null> {
    const cal = await this.calendar(ref.calendarId);
    const raw = await getEvent(this.config.googleApiBase, await this.token(), cal.providerCalendarId, ref.providerEventId, tz);
    return raw ? toDomainEvent(raw, cal, tz) : null;
  }

  async updateEvent(ref: EventRef, patch: EventPatch, opts: { notify: boolean; etag?: string }): Promise<void> {
    const cal = await this.calendar(ref.calendarId);
    const time = (m: Moment) => ({ dateTime: `${formatMoment(m)}:00`, timeZone: patch.tz });
    await patchEvent(
      this.config.googleApiBase, await this.token(), cal.providerCalendarId, ref.providerEventId,
      {
        ...(patch.title !== undefined ? { summary: patch.title } : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
        ...(patch.start ? { start: time(patch.start) } : {}),
        ...(patch.end ? { end: time(patch.end) } : {}),
      },
      { sendUpdates: opts.notify ? "all" : "none", ...(opts.etag ? { etag: opts.etag } : {}) },
    );
  }

  async deleteEvent(ref: EventRef, opts: { notify: boolean; etag?: string }): Promise<"deleted" | "gone"> {
    const cal = await this.calendar(ref.calendarId);
    return deleteEvent(this.config.googleApiBase, await this.token(), cal.providerCalendarId, ref.providerEventId, {
      sendUpdates: opts.notify ? "all" : "none",
      ...(opts.etag ? { etag: opts.etag } : {}),
    });
  }

  async declineEvent(ref: EventRef, tz: string): Promise<void> {
    const cal = await this.calendar(ref.calendarId);
    const token = await this.token();
    const raw = await getEvent(this.config.googleApiBase, token, cal.providerCalendarId, ref.providerEventId, tz);
    if (!raw) throw new GoogleApiError("event not found", 404);
    const attendees = (raw.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus: "declined" } : a));
    await patchEvent(this.config.googleApiBase, token, cal.providerCalendarId, ref.providerEventId, { attendees }, { sendUpdates: "all" });
  }
}
