// CalendarProvider для Google: календари из D1, события из Google Calendar API.

import type { Config } from "../config";
import { decryptSecret } from "../crypto";
import { makeDay, utcToLocal } from "../dates/calendar";
import { refreshAccessToken } from "../google/auth";
import { listEvents, type GoogleEvent } from "../google/calendar-api";
import type { CalendarEvent, CalendarInfo, CalendarProvider } from "./model";

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
    recurring: !!e.recurringEventId,
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
    const refresh = await decryptSecret(row.credentials_enc, this.config.tokenEncryptionKey);
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
}
