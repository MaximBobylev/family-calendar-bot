// Доменная модель события — не зависит от Google (ADR-0003).

import type { Day, Moment } from "../dates/calendar";

/** Непрозрачная ссылка на событие: аккаунт, календарь (наш id), id у провайдера. */
export interface EventRef {
  accountId: string;
  calendarId: string;
  providerEventId: string;
}

export interface CalendarEvent {
  ref: EventRef;
  calendarTitle: string;
  title: string;
  location?: string;
  conferenceUrl?: string;
  /** Событие на весь день: startDay…endDay включительно. */
  allDay: boolean;
  startDay: Day;
  endDay: Day;
  /** Для событий со временем — локальное время пользователя. */
  start?: Moment;
  end?: Moment;
  /** «Свободен» (transparency=transparent). */
  free: boolean;
  organizerIsSelf: boolean;
  recurring: boolean;
  etag?: string;
}

export interface CalendarInfo {
  id: string;
  accountId: string;
  providerCalendarId: string;
  title: string;
  writable: boolean;
  isDefault: boolean;
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
}

export interface CreatedEvent {
  ref: EventRef;
  link?: string;
}

/** Интерфейс провайдера календаря (ADR-0003). Реализация — Google. */
export interface CalendarProvider {
  calendars(): Promise<CalendarInfo[]>;
  /** События всех календарей пользователя в [fromUtc, toUtc), локальное время — в поясе `tz`. */
  listEvents(fromUtcMs: number, toUtcMs: number, tz: string): Promise<CalendarEvent[]>;
  createEvent(e: NewEvent): Promise<CreatedEvent>;
  renameEvent(ref: EventRef, title: string): Promise<void>;
}
