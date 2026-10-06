// US-95, чистый: inline-запрос «завтра 19:00 футбол» → событие(я) карточки, её текст, ссылка-шаблон Google Calendar,
// файл .ics, разбор callback_data и deep link. Даты — детерминированным парсером из текста, без LLM (ADR-0005 п.3).

import { addMinutes, formatDate, formatMoment, localToUtc, parseLocal, utcToLocal, type Day, type Moment } from "../../dates/calendar";
import { durationToMinutes } from "../../dates/duration";
import { cleanTitle, extractDateSpans } from "../../dates/extract";
import { parseDateFragment, type ParseValue } from "../../dates";
import { dateLabel, escapeHtml, hhmm } from "../format";
import { t } from "../messages";

/** Событие карточки — то, что хранится по токену (inline_events.payload_json). */
export interface InlineEvent {
  title: string;
  allDay: boolean;
  /** UTC, мс — для события со временем. */
  start?: number;
  end?: number;
  /** «Весь день»: даты включительно, YYYY-MM-DD. */
  startDate?: string;
  endDate?: string;
  /** Пояс автора: в нём показываем время на карточке и в ссылке-шаблоне. */
  tz: string;
  location?: string;
  /** Язык карточки (автора). */
  locale: string;
}

const DAY_MS = 86_400_000;
/** Длиннее — не название, а текст; Telegram ограничивает и сам запрос (256 символов). */
const MAX_TITLE = 100;

/**
 * Текст inline-запроса → варианты события (несколько — при неоднозначной дате: каждый — отдельный результат).
 * Без даты, с датой в прошлом или непонятной — пусто: карточку без времени добавить некуда.
 * Только дата — событие на весь день; повторения не поддерживаются (карточка — одно событие).
 */
export function parseInlineQuery(query: string, nowUtc: number, tz: string, durationMin: number, locale: string): InlineEvent[] {
  const text = query.trim();
  if (!text) return [];
  const now = formatMoment(utcToLocal(nowUtc, tz));
  const spans = extractDateSpans(text, now, tz, "point");
  if (!spans.point) return [];
  const parsed = parseDateFragment({ text: spans.point, kind: "point", now, tz });
  if ("error" in parsed) return [];

  let duration = durationMin;
  let forceAllDay = false;
  if (spans.duration) {
    const d = parseDateFragment({ text: spans.duration, kind: "duration", now, tz });
    if ("duration" in d) {
      if (d.duration === "all_day") forceAllDay = true;
      else {
        const m = durationToMinutes(d.duration);
        if (m && m > 0 && m <= 24 * 60) duration = m;
      }
    }
  }
  const title = (cleanTitle(text, [spans.point, ...(spans.duration ? [spans.duration] : [])]) ?? t("defaultTitle", locale)).slice(0, MAX_TITLE);
  const base = { title, tz, locale };

  const toEvent = (v: ParseValue): InlineEvent | null => {
    if ("datetime" in v || "interval" in v) {
      const start = parseLocal("datetime" in v ? v.datetime : v.interval.start);
      const end = "interval" in v ? parseLocal(v.interval.end) : addMinutes(start, duration);
      if (forceAllDay) return { ...base, allDay: true, startDate: formatDate(start.day), endDate: formatDate(start.day) };
      return { ...base, allDay: false, start: localToUtc(start, tz), end: localToUtc(end, tz) };
    }
    if ("date" in v && typeof v.date === "string") return { ...base, allDay: true, startDate: v.date, endDate: v.date };
    if ("range" in v && !v.range.from.includes("T")) return { ...base, allDay: true, startDate: v.range.from, endDate: v.range.to };
    return null;
  };
  const values = "ambiguous" in parsed ? parsed.ambiguous : [parsed];
  return values.map(toEvent).filter((e): e is InlineEvent => e !== null);
}

// --- Отображение -------------------------------------------------------------

const EMOJI: [RegExp, string][] = [
  [/футбол|football|soccer/i, "⚽"],
  [/баскетбол|basketball/i, "🏀"],
  [/теннис|tennis/i, "🎾"],
  [/бассейн|плаван|swim/i, "🏊"],
  [/трениров|спорт|зал|gym|workout/i, "🏋️"],
  [/день рождени|(?<!\p{L})др(?!\p{L})|birthday/iu, "🎂"],
  [/кино|фильм|movie|cinema/i, "🎬"],
  [/театр|концерт|theatre|theater|concert/i, "🎭"],
  [/ужин|обед|завтрак|кафе|ресторан|dinner|lunch|breakfast|restaurant/i, "🍽"],
  [/врач|доктор|стоматолог|клиник|doctor|dentist/i, "🩺"],
  [/созвон|звонок|call|zoom/i, "📞"],
  [/самол[её]т|рейс|аэропорт|flight|airport/i, "✈️"],
];

/** Значок по названию: «Футбол» → ⚽; по умолчанию — 📅. */
export function titleEmoji(title: string): string {
  return EMOJI.find(([re]) => re.test(title))?.[1] ?? "📅";
}

/** Смещение пояса для момента: «UTC+3», «UTC-4:30», «UTC». */
export function utcOffsetLabel(utcMs: number, tz: string): string {
  const local = utcToLocal(utcMs, tz);
  const offset = Math.round((local.day * DAY_MS + local.minutes * 60_000 - utcMs) / 60_000);
  if (offset === 0) return "UTC";
  const sign = offset > 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
}

const dayOf = (date: string): Day => parseLocal(`${date}T00:00`).day;

/** Время события на карточке — абсолютное: сообщение живёт в чате, «завтра» через день станет неправдой. */
export function inlineWhen(e: InlineEvent, today: Day): string {
  if (e.allDay) {
    const from = dayOf(e.startDate!);
    const to = dayOf(e.endDate!);
    const range = from === to ? dateLabel(from, today, e.locale) : `${dateLabel(from, today, e.locale)} — ${dateLabel(to, today, e.locale)}`;
    return `${range}, ${t("allDayLower", e.locale)}`;
  }
  const s: Moment = utcToLocal(e.start!, e.tz);
  const en: Moment = utcToLocal(e.end!, e.tz);
  const span =
    s.day === en.day
      ? `${dateLabel(s.day, today, e.locale)}, ${hhmm(s.minutes)}–${hhmm(en.minutes)}`
      : `${dateLabel(s.day, today, e.locale)}, ${hhmm(s.minutes)} — ${dateLabel(en.day, today, e.locale)}, ${hhmm(en.minutes)}`;
  return `${span} (${utcOffsetLabel(e.start!, e.tz)})`;
}

/** Текст сообщения-карточки в чате (HTML); added — счётчик «Добавили себе: N». */
export function inlineCardText(e: InlineEvent, today: Day, added = 0): string {
  const lines = [`${titleEmoji(e.title)} <b>${escapeHtml(e.title)}</b>`, `🕒 ${inlineWhen(e, today)}`];
  if (e.location) lines.push(`📍 ${escapeHtml(e.location)}`);
  if (added > 0) lines.push("", t("inlineAdded", e.locale, { n: String(added) }));
  return lines.join("\n");
}

/** Заголовок результата в списке inline — для автора, сейчас: «⚽ Футбол — завтра, 19:00». */
export function inlineResultTitle(e: InlineEvent, nowUtc: number): string {
  const today = utcToLocal(nowUtc, e.tz).day;
  const day = e.allDay ? dayOf(e.startDate!) : utcToLocal(e.start!, e.tz).day;
  const rel = day === today ? t("inlineToday", e.locale) : day === today + 1 ? t("inlineTomorrow", e.locale) : dateLabel(day, today, e.locale);
  const time = e.allDay ? t("allDayLower", e.locale) : hhmm(utcToLocal(e.start!, e.tz).minutes);
  return `${titleEmoji(e.title)} ${e.title} — ${rel}, ${time}`;
}

// --- Ссылка-шаблон Google Calendar и .ics -------------------------------------------

const utcStamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
const compactDate = (date: string) => date.replaceAll("-", "");
/** Следующий день после YYYY-MM-DD — конец «весь день» в Google и iCalendar не включается. */
const nextDate = (date: string) => formatDate(dayOf(date) + 1).replaceAll("-", "");

/** Ссылка «добавить в Google Календарь» без OAuth: https://calendar.google.com/calendar/render?action=TEMPLATE&… */
export function googleTemplateUrl(base: string, e: InlineEvent): string {
  const dates = e.allDay ? `${compactDate(e.startDate!)}/${nextDate(e.endDate!)}` : `${utcStamp(e.start!)}/${utcStamp(e.end!)}`;
  const q = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates, ctz: e.tz });
  if (e.location) q.set("location", e.location);
  return `${base}?${q}`;
}

/** Экранирование TEXT по RFC 5545 (3.3.11). */
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Перенос строк длиннее 75 октетов (RFC 5545, 3.1) — не разрывая символы UTF-8. */
export function foldIcsLine(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // продолжение начинается с пробела
    if (size + n > limit) {
      out.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** Файл .ics с одним событием (METHOD:PUBLISH): Apple Календарь, Outlook, Google импортируют его без OAuth. */
export function buildIcs(e: InlineEvent, uid: string, nowUtc: number): string {
  const when = e.allDay
    ? [`DTSTART;VALUE=DATE:${compactDate(e.startDate!)}`, `DTEND;VALUE=DATE:${nextDate(e.endDate!)}`]
    : [`DTSTART:${utcStamp(e.start!)}`, `DTEND:${utcStamp(e.end!)}`];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//calendar-assist-bot//inline card//RU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(nowUtc)}`,
    ...when,
    `SUMMARY:${icsText(e.title)}`,
    ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

// --- Токены в Telegram ------------------------------------------------------

/** callback_data кнопки «Добавить себе» на inline-сообщении: «ia:<токен>». */
export const inlineCallbackData = (token: string) => `ia:${token}`;

export function parseInlineCallback(data: string | undefined): string | null {
  return /^ia:([0-9a-f]{20})$/.exec(data ?? "")?.[1] ?? null;
}

/** Deep link в личный чат с ботом: t.me/<бот>?start=add_<токен>. */
export const addStartLink = (botUsername: string, token: string) => `https://t.me/${botUsername}?start=add_${token}`;

/** `/start add_<токен>` в личном чате — продолжение нажатия «Добавить себе». */
export function parseAddStart(text: string | undefined): string | null {
  return /^\/start(?:@\w+)?\s+add_([0-9a-f]{20})$/.exec(text?.trim() ?? "")?.[1] ?? null;
}

/** Конец события (UTC) — от него считается срок хранения токена. */
export function inlineEventEnd(e: InlineEvent): number {
  return e.allDay ? (dayOf(e.endDate!) + 1) * DAY_MS : e.end!;
}
