// Доменная модель события — не зависит от Google (ADR-0003).

import type { Day, Moment } from "../dates/calendar";

export interface EventRef {
  accountId: string;
  calendarId: string;
  providerEventId: string;
}

/** useDefault — как настроено в календаре, overrides тогда пуст. */
export interface EventReminders {
  useDefault: boolean;
  overrides: { method: "popup" | "email"; minutes: number }[];
}

/** Google: не больше 5 напоминаний у события, каждое — не раньше чем за 4 недели. */
export const MAX_REMINDERS = 5;
export const MAX_REMINDER_MIN = 40320;

export interface CalendarEvent {
  ref: EventRef;
  calendarTitle: string;
  title: string;
  location?: string;
  description?: string;
  /** Нет — как в календаре (useDefault). */
  reminders?: EventReminders;
  conferenceUrl?: string;
  /** Событие на весь день: startDay…endDay включительно. */
  allDay: boolean;
  startDay: Day;
  endDay: Day;
  /** Для событий со временем — локальное время пользователя. */
  start?: Moment;
  end?: Moment;
  free: boolean;
  organizerIsSelf: boolean;
  hasOtherAttendees: boolean;
  recurring: boolean;
  seriesId?: string;
  etag?: string;
}

export interface CalendarInfo {
  id: string;
  accountId: string;
  providerCalendarId: string;
  title: string;
  writable: boolean;
  isDefault: boolean;
  aliases: string[];
  timeZone?: string;
}

/** Новое событие: время — локальное в поясе `tz`. */
export interface NewEvent {
  calendarId: string;
  title: string;
  tz: string;
  allDay: boolean;
  startDay: Day;
  /** Для событий на весь день — включительно. */
  endDay: Day;
  start?: Moment;
  end?: Moment;
  location?: string;
  description?: string;
  /** RFC 5545: ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. */
  recurrence?: string[];
  /** Минуты до начала (popup). Нет — как в Google (useDefault). */
  reminders?: number[];
  idempotencyKey?: string;
}

export interface CreatedEvent {
  ref: EventRef;
  link?: string;
  etag?: string;
}

/** Время — локальное в поясе `tz`. */
export interface EventPatch {
  tz: string;
  title?: string;
  /** Пустая строка — убрать место. */
  location?: string;
  /** Пустая строка — убрать описание. */
  description?: string;
  reminders?: EventReminders;
  start?: Moment;
  end?: Moment;
}

export interface CalendarProvider {
  calendars(): Promise<CalendarInfo[]>;
  /** Один календарь не загрузился — он в `failed`, остальные события есть; не загрузился ни один — ошибка. */
  listEvents(fromUtcMs: number, toUtcMs: number, tz: string): Promise<EventList>;
  createEvent(e: NewEvent): Promise<CreatedEvent>;
  getEvent(ref: EventRef, tz: string): Promise<CalendarEvent | null>;
  /** С etag чужая правка даёт EventConflict; новый etag нужен отмене (US-61) — понять, не изменили ли событие после нас. */
  updateEvent(ref: EventRef, patch: EventPatch, opts: { notify: boolean; etag?: string }): Promise<{ etag?: string }>;
  /** «gone» — событие уже удалено кем-то: для пользователя это тоже успех. */
  deleteEvent(ref: EventRef, opts: { notify: boolean; etag?: string }): Promise<"deleted" | "gone">;
  declineEvent(ref: EventRef, tz: string): Promise<void>;
}

export interface EventList {
  events: CalendarEvent[];
  failed: { id: string; title: string }[];
}

export class CalendarError extends Error {}
/** И когда удалён сам календарь. */
export class EventGone extends CalendarError {}
export class EventConflict extends CalendarError {}
export class PermissionDenied extends CalendarError {}
/** И когда токен не расшифровать: для пользователя то же — переподключить (US-02). */
export class AuthRevoked extends CalendarError {}
/** Сеть, таймаут, 5xx, а также 429 и лимиты. */
export class ProviderUnavailable extends CalendarError {}
