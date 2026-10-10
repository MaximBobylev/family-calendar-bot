// Логика синка, уведомлений и напоминаний без D1 и сети — покрыта юнит-тестами test/sync-logic.test.ts.

import { makeDay, utcToLocal, type Day } from "../dates/calendar";
import { nextDailyAt } from "../dates/daily";
import { dateLabel, escapeHtml, hhmm, whenOf } from "../bot/format";
import { t, type MessageKey } from "../bot/messages";

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
export const NOTIFY_WINDOW_MS = 30 * DAY_MS;
export const BATCH_LIMIT = 3;
export const BATCH_WINDOW_MS = 2 * MINUTE_MS;
export const QUIET_FROM_MIN = 23 * 60;
export const QUIET_TO_MIN = 8 * 60;
const SUMMARY_LINES = 15;

// Должно оставаться структурно совместимым с GoogleEvent.
export interface SourceEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  hangoutLink?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  organizer?: { self?: boolean; email?: string; displayName?: string };
  recurringEventId?: string;
  eventType?: string;
  etag?: string;
}

// У событий на весь день endDate — исключающая (как в Google).
export interface Snapshot {
  eventId: string;
  seriesId?: string;
  status: string;
  title: string;
  location?: string;
  conferenceUrl?: string;
  htmlLink?: string;
  organizer?: string;
  allDay: boolean;
  startMs: number | null;
  endMs: number | null;
  startDate?: string;
  endDate?: string;
  declined: boolean;
  etag?: string;
}

const dateMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

const HIDDEN_TYPES = new Set(["workingLocation", "focusTime", "outOfOffice"]);

export function snapshotOf(e: SourceEvent): Snapshot {
  const allDay = !!e.start?.date && !e.start?.dateTime;
  const startMs = e.start?.dateTime ? Date.parse(e.start.dateTime) : e.start?.date ? dateMs(e.start.date) : null;
  const endMs = e.end?.dateTime ? Date.parse(e.end.dateTime) : e.end?.date ? dateMs(e.end.date) : null;
  const org = e.organizer && !e.organizer.self ? (e.organizer.displayName ?? e.organizer.email) : undefined;
  return {
    eventId: e.id,
    ...(e.recurringEventId ? { seriesId: e.recurringEventId } : {}),
    // Скрытые типы — как удалённые: о них не сообщаем и не напоминаем
    status: HIDDEN_TYPES.has(e.eventType ?? "") ? "cancelled" : (e.status ?? "confirmed"),
    title: e.summary?.trim() || "—",
    ...(e.location ? { location: e.location } : {}),
    ...(e.hangoutLink ? { conferenceUrl: e.hangoutLink } : {}),
    ...(e.htmlLink ? { htmlLink: e.htmlLink } : {}),
    ...(org ? { organizer: org } : {}),
    allDay,
    startMs: Number.isNaN(startMs) ? null : startMs,
    endMs: Number.isNaN(endMs) ? null : endMs,
    ...(allDay && e.start?.date ? { startDate: e.start.date } : {}),
    ...(allDay && e.end?.date ? { endDate: e.end.date } : {}),
    declined: !!e.attendees?.some((a) => a.self && a.responseStatus === "declined"),
    ...(e.etag ? { etag: e.etag } : {}),
  };
}

export const isActive = (s: Snapshot | null | undefined): s is Snapshot => !!s && s.status !== "cancelled" && s.startMs !== null;

export type ChangeKind = "created" | "moved" | "cancelled";

// О смене только названия/описания/места и только конца (длительности) не сообщаем — решение владельца 2026-10-06.
export function diffEvent(before: Snapshot | null, after: Snapshot | null): ChangeKind | null {
  const was = isActive(before);
  const is = isActive(after);
  if (!was && is) return "created";
  if (was && !is) return "cancelled";
  if (was && is && (before.allDay !== after.allDay || before.startMs !== after.startMs || before.startDate !== after.startDate)) return "moved";
  return null;
}

// times — новое и прежнее время: перенос «из окна» тоже сообщаем. Событие на весь день «сегодня» (начало — полночь
// UTC, уже в прошлом) — ещё будущее.
export function inNotifyWindow(times: { allDay: boolean; startMs: number | null }[], now: number): boolean {
  return times.some((s) => s.startMs !== null && s.startMs >= now - (s.allDay ? DAY_MS : 0) && s.startMs <= now + NOTIFY_WINDOW_MS);
}

// null — можно слать сейчас.
export function quietUntil(now: number, tz: string): number | null {
  const m = utcToLocal(now, tz).minutes;
  if (m < QUIET_FROM_MIN && m >= QUIET_TO_MIN) return null;
  return nextDailyAt(now, tz, QUIET_TO_MIN);
}

// Сводкой — и когда новых немного, но вместе с только что отправленными больше BATCH_LIMIT (решение владельца 2026-10-06).
export function deliveryPlan(due: number, sentRecently: number): "single" | "summary" {
  if (due > BATCH_LIMIT) return "summary";
  return due >= 2 && due + sentRecently > BATCH_LIMIT ? "summary" : "single";
}

export function reminderFireAt(s: Snapshot | null, minutes: number): number | null {
  if (!isActive(s) || s.allDay || s.declined) return null;
  return s.startMs! - minutes * MINUTE_MS;
}

export interface NoticeTime {
  allDay: boolean;
  startMs: number | null;
  endMs: number | null;
  startDate?: string;
  endDate?: string;
}

// Хранится в change_notices.notice_json: уже записанные строки должны читаться после правки типа.
export interface Notice {
  kind: ChangeKind;
  title: string;
  // Для отмены — каким время было.
  time: NoticeTime;
  before?: NoticeTime;
  link?: string;
  author?: string;
  organizer?: string;
  locale: string;
  tz: string;
}

export const timeOf = (s: Snapshot): NoticeTime => ({
  allDay: s.allDay,
  startMs: s.startMs,
  endMs: s.endMs,
  ...(s.startDate ? { startDate: s.startDate } : {}),
  ...(s.endDate ? { endDate: s.endDate } : {}),
});

function dayOfDate(date: string): Day {
  const [y, m, d] = date.split("-").map(Number);
  return makeDay(y!, m!, d!);
}

export function whenLabel(time: NoticeTime, tz: string, today: Day, locale: string): string {
  if (time.allDay && time.startDate) {
    const startDay = dayOfDate(time.startDate);
    const endDay = time.endDate ? dayOfDate(time.endDate) - 1 : startDay;
    return whenOf({ allDay: true, startDay, endDay: Math.max(startDay, endDay) }, today, locale);
  }
  const start = utcToLocal(time.startMs ?? 0, tz);
  const end = utcToLocal(time.endMs ?? time.startMs ?? 0, tz);
  return whenOf({ allDay: false, startDay: start.day, endDay: end.day, start, end }, today, locale);
}

function wasLabel(before: NoticeTime, after: NoticeTime, tz: string, today: Day, locale: string): string {
  if (before.allDay && before.startDate) return `${dateLabel(dayOfDate(before.startDate), today, locale)}, ${t("allDayLower", locale)}`;
  const b = utcToLocal(before.startMs ?? 0, tz);
  const sameDay = !after.allDay && after.startMs !== null && utcToLocal(after.startMs, tz).day === b.day;
  return sameDay ? hhmm(b.minutes) : `${dateLabel(b.day, today, locale)}, ${hhmm(b.minutes)}`;
}

export function noticeLine(n: Notice, now: number): string {
  const today = utcToLocal(now, n.tz).day;
  const title = escapeHtml(n.title);
  const when = whenLabel(n.time, n.tz, today, n.locale);
  if (n.kind === "moved") {
    return n.before
      ? t("noticeMoved", n.locale, { title, when, was: wasLabel(n.before, n.time, n.tz, today, n.locale) })
      : t("noticeMovedNoWas", n.locale, { title, when });
  }
  const key: MessageKey = n.kind === "created" ? "noticeCreated" : "noticeCancelled";
  return t(key, n.locale, { title, when });
}

export function noticeText(n: Notice, now: number): string {
  const lines = [noticeLine(n, now)];
  if (n.author) lines.push(t("noticeAuthor", n.locale, { name: escapeHtml(n.author) }));
  else if (n.organizer) lines.push(t("noticeOrganizer", n.locale, { name: escapeHtml(n.organizer) }));
  return lines.join("\n");
}

export function summaryText(list: Notice[], now: number): string {
  const locale = list[0]?.locale ?? "ru";
  const shown = list.slice(0, SUMMARY_LINES).map((n) => `• ${noticeLine(n, now)}${n.author ? ` — ${escapeHtml(n.author)}` : ""}`);
  const more = list.length > SUMMARY_LINES ? [t("noticeSummaryMore", locale, { count: String(list.length - SUMMARY_LINES) })] : [];
  return [t("noticeSummary", locale, { count: String(list.length) }), ...shown, ...more].join("\n");
}

export function reminderText(s: Snapshot, minutes: number, locale: string, tz: string, now: number): string {
  const today = utcToLocal(now, tz).day;
  const start = utcToLocal(s.startMs!, tz);
  const when = s.endMs ? whenLabel(timeOf(s), tz, today, locale) : `${dateLabel(start.day, today, locale)}, ${hhmm(start.minutes)}`;
  const lines = [t("tgReminder", locale, { minutes: String(minutes), title: escapeHtml(s.title), when })];
  if (s.location) lines.push(t("tgReminderPlace", locale, { place: escapeHtml(s.location) }));
  if (s.conferenceUrl) lines.push(t("tgReminderLink", locale, { url: escapeHtml(s.conferenceUrl) }));
  return lines.join("\n");
}
