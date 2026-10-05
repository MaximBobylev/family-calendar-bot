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
  /** Есть другие участники — изменения им уходят уведомлением (US-40). */
  hasOtherAttendees: boolean;
  recurring: boolean;
  /** id серии у провайдера — для изменения «всех» (US-43). */
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
  /** Ключ идемпотентности: повтор с тем же ключом не создаёт второе событие. */
  idempotencyKey?: string;
}

export interface CreatedEvent {
  ref: EventRef;
  link?: string;
}

/** Изменения события. Время — локальное в поясе `tz`. */
export interface EventPatch {
  tz: string;
  title?: string;
  location?: string;
  start?: Moment;
  end?: Moment;
}

/** Интерфейс провайдера календаря (ADR-0003). Реализация — Google. */
export interface CalendarProvider {
  calendars(): Promise<CalendarInfo[]>;
  /** События всех календарей пользователя в [fromUtc, toUtc), локальное время — в поясе `tz`. */
  listEvents(fromUtcMs: number, toUtcMs: number, tz: string): Promise<CalendarEvent[]>;
  createEvent(e: NewEvent): Promise<CreatedEvent>;
  renameEvent(ref: EventRef, title: string): Promise<void>;
  getEvent(ref: EventRef, tz: string): Promise<CalendarEvent | null>;
  /** etag — защита от параллельных правок: если событие изменили, провайдер вернёт ошибку 412. */
  updateEvent(ref: EventRef, patch: EventPatch, opts: { notify: boolean; etag?: string }): Promise<void>;
}
