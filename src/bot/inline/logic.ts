// Чистый модуль; даты — детерминированным парсером из текста, без LLM (ADR-0005 п.3).

import { addMinutes, formatDate, formatMoment, localToUtc, parseLocal, utcToLocal, type Day, type Moment } from "../../dates/calendar";
import { durationToMinutes } from "../../dates/duration";
import { cleanTitle, extractDateSpans } from "../../dates/extract";
import { parseDateFragment, type ParseValue } from "../../dates";
import { dateLabel, escapeHtml, hhmm } from "../format";
import { t } from "../messages";

// Хранится по токену в inline_events.payload_json.
export interface InlineEvent {
  title: string;
  allDay: boolean;
  // UTC, мс.
  start?: number;
  end?: number;
  // Даты включительно, YYYY-MM-DD.
  startDate?: string;
  endDate?: string;
  tz: string;
  location?: string;
  locale: string;
}

const DAY_MS = 86_400_000;
// Длиннее — не название, а текст; сам запрос Telegram ограничивает 256 символами.
const MAX_TITLE = 100;

// Несколько вариантов — при неоднозначной дате. Без даты или в прошлом — пусто: карточку без времени добавить некуда.
// Повторения не поддерживаются: карточка — одно событие.
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

export function titleEmoji(title: string): string {
  return EMOJI.find(([re]) => re.test(title))?.[1] ?? "📅";
}

export function utcOffsetLabel(utcMs: number, tz: string): string {
  const local = utcToLocal(utcMs, tz);
  const offset = Math.round((local.day * DAY_MS + local.minutes * 60_000 - utcMs) / 60_000);
  if (offset === 0) return "UTC";
  const sign = offset > 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
}

const dayOf = (date: string): Day => parseLocal(`${date}T00:00`).day;

// Абсолютное время: сообщение живёт в чате, «завтра» через день станет неправдой.
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

export function inlineCardText(e: InlineEvent, today: Day, added = 0): string {
  const lines = [`${titleEmoji(e.title)} <b>${escapeHtml(e.title)}</b>`, `🕒 ${inlineWhen(e, today)}`];
  if (e.location) lines.push(`📍 ${escapeHtml(e.location)}`);
  if (added > 0) lines.push("", t("inlineAdded", e.locale, { n: String(added) }));
  return lines.join("\n");
}

// Для автора и сейчас — поэтому относительное («завтра»).
export function inlineResultTitle(e: InlineEvent, nowUtc: number): string {
  const today = utcToLocal(nowUtc, e.tz).day;
  const day = e.allDay ? dayOf(e.startDate!) : utcToLocal(e.start!, e.tz).day;
  const rel = day === today ? t("inlineToday", e.locale) : day === today + 1 ? t("inlineTomorrow", e.locale) : dateLabel(day, today, e.locale);
  const time = e.allDay ? t("allDayLower", e.locale) : hhmm(utcToLocal(e.start!, e.tz).minutes);
  return `${titleEmoji(e.title)} ${e.title} — ${rel}, ${time}`;
}

const utcStamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
const compactDate = (date: string) => date.replaceAll("-", "");
// Конец «весь день» в Google и iCalendar не включается.
const nextDate = (date: string) => formatDate(dayOf(date) + 1).replaceAll("-", "");

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

export const inlineCallbackData = (token: string) => `ia:${token}`;

export function parseInlineCallback(data: string | undefined): string | null {
  return /^ia:([0-9a-f]{20})$/.exec(data ?? "")?.[1] ?? null;
}

export const addStartLink = (botUsername: string, token: string) => `https://t.me/${botUsername}?start=add_${token}`;

export function parseAddStart(text: string | undefined): string | null {
  return /^\/start(?:@\w+)?\s+add_([0-9a-f]{20})$/.exec(text?.trim() ?? "")?.[1] ?? null;
}

export function inlineEventEnd(e: InlineEvent): number {
  return e.allDay ? (dayOf(e.endDate!) + 1) * DAY_MS : e.end!;
}
