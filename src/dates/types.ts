// Контракт парсера дат. Повторяет формат золотого корпуса (testdata/dates/README.md),
// поэтому любая реализация сверяется с одними и теми же YAML-файлами.

/** Локальное время без смещения: "2026-10-07T12:00". */
export type LocalDateTime = string;
/** Локальная дата: "2026-10-07". */
export type LocalDate = string;

export type ValueKind = "point" | "range" | "shift" | "duration" | "recurrence";

/** late_afternoon — «ближе к вечеру», «под вечер» (16–20). */
export type DayPart = "morning" | "day" | "afternoon" | "late_afternoon" | "evening" | "night";

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface ParseInput {
  /** Сырой фрагмент, вырезанный LLM. */
  text: string;
  kind: ValueKind;
  /** «Сейчас» — локальное время в `tz`. */
  now: LocalDateTime;
  /** IANA-пояс пользователя. */
  tz: string;
}

export interface Recurrence {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  by_day?: Weekday[];
  by_month?: number;
  by_month_day?: number;
  by_set_pos?: number;
  until?: LocalDate;
  count?: number;
  /** "HH:MM" */
  time?: string;
  warning?: "skips_short_months";
  /** by_month_day 29–31 в месяце без такого числа: пропустить (как RRULE по умолчанию) или последний день месяца. */
  short_months?: "skip" | "last_day";
}

export type ParseError = "unparseable" | "in_past" | "invalid_date" | "invalid_time" | "empty";

export type ParseValue =
  | { datetime: LocalDateTime }
  | { date: LocalDate | { date: LocalDate; part: DayPart } }
  | { interval: { start: LocalDateTime; end: LocalDateTime } }
  | { range: { from: LocalDate | LocalDateTime; to: LocalDate | LocalDateTime } }
  | { shift: string }
  | { duration: string }
  | { recurrence: Recurrence };

export type ParseResult = ParseValue | { ambiguous: ParseValue[] } | { error: ParseError };

export type DateParser = (input: ParseInput) => ParseResult;
