// Доменная модель события — не зависит от Google (ADR-0003).

import type { Day, Moment } from "../dates/calendar";

/** Непрозрачная ссылка на событие: аккаунт, календарь (наш id), id у провайдера. */
export interface EventRef {
  accountId: string;
  calendarId: string;
  providerEventId: string;
}

/** Напоминания события (US-42). useDefault — как настроено в календаре, overrides тогда пуст. */
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
  /** Другие названия календаря у пользователя: «общий», «семейный» (US-06). */
  aliases: string[];
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
  /** Правила повторения RFC 5545: ["RRULE:FREQ=WEEKLY;BYDAY=MO"] (US-32). */
  recurrence?: string[];
  /** Напоминания (popup), минуты до начала. Нет — как в Google (useDefault). */
  reminders?: number[];
  /** Ключ идемпотентности: повтор с тем же ключом не создаёт второе событие. */
  idempotencyKey?: string;
}

export interface CreatedEvent {
  ref: EventRef;
  link?: string;
  etag?: string;
}

/** Изменения события. Время — локальное в поясе `tz`. */
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

/** Интерфейс провайдера календаря (ADR-0003). Реализация — Google. Ошибки — классы ниже (CalendarError). */
export interface CalendarProvider {
  calendars(): Promise<CalendarInfo[]>;
  /**
   * События всех календарей пользователя в [fromUtc, toUtc), локальное время — в поясе `tz`.
   * Один календарь не загрузился — он в `failed`, остальные события есть; не загрузился ни один — ошибка.
   */
  listEvents(fromUtcMs: number, toUtcMs: number, tz: string): Promise<EventList>;
  createEvent(e: NewEvent): Promise<CreatedEvent>;
  getEvent(ref: EventRef, tz: string): Promise<CalendarEvent | null>;
  /** etag — защита от параллельных правок: если событие изменили, провайдер вернёт ошибку 412. */
  /** Возвращает новый etag — по нему отмена (US-61) поймёт, не изменили ли событие после нас. */
  updateEvent(ref: EventRef, patch: EventPatch, opts: { notify: boolean; etag?: string }): Promise<{ etag?: string }>;
  /** «gone» — событие уже удалено кем-то: для пользователя это тоже успех. */
  deleteEvent(ref: EventRef, opts: { notify: boolean; etag?: string }): Promise<"deleted" | "gone">;
  /** Отклонить приглашение (пользователь — участник, не организатор): организатор получит ответ. */
  declineEvent(ref: EventRef, tz: string): Promise<void>;
}

/** События всех календарей; календари, которые не загрузились, — отдельно: показываем остальное (tech-debt #12). */
export interface EventList {
  events: CalendarEvent[];
  failed: { id: string; title: string }[];
}

// --- Ошибки провайдера (tech-debt #12): бот не знает про Google, адаптер переводит свои ошибки в эти ---

export class CalendarError extends Error {}
/** Событие (или календарь) уже удалено. */
export class EventGone extends CalendarError {}
/** Событие изменили после того, как мы его прочитали (etag). */
export class EventConflict extends CalendarError {}
/** Нет прав на действие: календарь только для чтения, чужое событие. */
export class PermissionDenied extends CalendarError {}
/** Доступ отозван (или токен не расшифровать) — нужно переподключить (US-02). */
export class AuthRevoked extends CalendarError {}
/** Провайдер не отвечает: сеть, таймаут, 5xx, 429, лимиты. */
export class ProviderUnavailable extends CalendarError {}
