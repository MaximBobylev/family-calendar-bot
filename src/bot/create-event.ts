// US-30 / US-31: создание события. Карточка-подтверждение (осторожный режим), варианты кнопками для
// неоднозначных дат, вопрос «во сколько?», предупреждение о пересечениях, вопрос о названии.

import type { CalendarInfo, CalendarProvider, EventRef } from "../calendar/model";
import { formatMoment, localToUtc, parseLocal, parts, utcToLocal, type Day, type Moment } from "../dates/calendar";
import { parseDateFragment, type ParseValue } from "../dates";
import {
  attachMessage, cancelOpenCards, createPendingAction, setDialogState, type PendingAction,
} from "../db/conversations";
import type { User } from "../db/users";
import type { CreateEventIntent } from "../nlu/intents";
import type { InlineKeyboardButton } from "../telegram/types";
import type { AppContext } from "./context";
import { escapeHtml } from "./format-events";
import { callbackData } from "./keyboards";
import { t } from "./messages";

export const CREATE_CARD = "create";
export const TITLE_QUESTION = "title";
const DEFAULT_DURATION_MIN = 60;
const AWAIT_TTL_MS = 15 * 60 * 1000;

/** Черновик создания: то, что сказал пользователь (фрагменты), — до разрешения дат. */
export interface CreateDraft {
  startText?: string;
  title?: string;
  durationText?: string;
  allDay?: boolean;
  calendar?: string;
  location?: string;
}

/** Разрешённый вариант события — хранится в карточке. */
export interface CreateOption {
  calendarId: string;
  calendarTitle: string;
  title: string;
  titleGiven: boolean;
  tz: string;
  allDay: boolean;
  startDay: Day;
  endDay: Day;
  start?: Moment;
  end?: Moment;
  location?: string;
}

export interface CreateCardPayload {
  chatId: number;
  options: CreateOption[];
}

export interface TitleQuestionPayload {
  ref: EventRef;
}

export function draftFromIntent(i: CreateEventIntent): CreateDraft {
  return {
    startText: i.start,
    ...(i.title ? { title: i.title } : {}),
    ...(i.duration ? { durationText: i.duration } : {}),
    ...(i.allDay ? { allDay: true } : {}),
    ...(i.calendar ? { calendar: i.calendar } : {}),
    ...(i.location ? { location: i.location } : {}),
  };
}

// --- Формат ---------------------------------------------------------------

function dateLabel(day: Day, today: Day, locale: string): string {
  const { year, month, date } = parts(day);
  const withYear = year !== parts(today).year;
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "ru-RU", {
    weekday: "short", day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date)));
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function whenLabel(o: CreateOption, today: Day, locale: string): string {
  if (o.allDay) {
    const range = o.startDay === o.endDay ? dateLabel(o.startDay, today, locale) : `${dateLabel(o.startDay, today, locale)} — ${dateLabel(o.endDay, today, locale)}`;
    return `${range}, ${t("allDayLower", locale)}`;
  }
  const s = o.start!;
  const e = o.end!;
  if (s.day === e.day) return `${dateLabel(s.day, today, locale)}, ${hhmm(s.minutes)}–${hhmm(e.minutes)}`;
  return `${dateLabel(s.day, today, locale)}, ${hhmm(s.minutes)} — ${dateLabel(e.day, today, locale)}, ${hhmm(e.minutes)}`;
}

function cardBody(o: CreateOption, today: Day, locale: string, showCalendar: boolean): string {
  const lines = [`<b>${escapeHtml(o.title)}</b>`, `🕒 ${whenLabel(o, today, locale)}`];
  if (o.location) lines.push(`📍 ${escapeHtml(o.location)}`);
  if (showCalendar) lines.push(`🗓 ${escapeHtml(o.calendarTitle)}`);
  return lines.join("\n");
}

// --- Разрешение черновика --------------------------------------------------

function durationMinutes(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (m) return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  const d = /^P(\d+)D$/.exec(iso);
  return d ? Number(d[1]) * 1440 : DEFAULT_DURATION_MIN;
}

type Resolution =
  | { kind: "options"; options: CreateOption[] }
  | { kind: "ask"; question: "askWhen" | "askTime" | "inPast"; keepStart: boolean }
  | { kind: "reply"; text: string };

function resolveCalendar(calendars: CalendarInfo[], name: string | undefined): CalendarInfo | { error: "notFound" | "readOnly"; name: string } {
  if (name) {
    const cal = calendars.find((c) => c.title.toLowerCase() === name.trim().toLowerCase());
    if (!cal) return { error: "notFound", name };
    if (!cal.writable) return { error: "readOnly", name: cal.title };
    return cal;
  }
  return calendars.find((c) => c.isDefault && c.writable) ?? calendars.find((c) => c.writable) ?? { error: "notFound", name: "" };
}

function resolveDraft(draft: CreateDraft, now: Moment, tz: string, cal: CalendarInfo, locale: string): Resolution {
  if (!draft.startText) return { kind: "ask", question: "askWhen", keepStart: false };

  let duration = DEFAULT_DURATION_MIN;
  let allDay = draft.allDay ?? false;
  if (draft.durationText) {
    const d = parseDateFragment({ text: draft.durationText, kind: "duration", now: formatMoment(now), tz });
    if ("error" in d || !("duration" in d)) return { kind: "reply", text: t("durationUnparseable", locale) };
    if (d.duration === "all_day") allDay = true;
    else duration = durationMinutes(d.duration);
  }

  const base = {
    calendarId: cal.id,
    calendarTitle: cal.title,
    title: draft.title ?? t("defaultTitle", locale),
    titleGiven: !!draft.title,
    tz,
    ...(draft.location ? { location: draft.location } : {}),
  };

  const toOption = (v: ParseValue): CreateOption | "needTime" | null => {
    if ("datetime" in v) {
      const start = parseLocal(v.datetime);
      const end = { day: start.day, minutes: start.minutes + duration };
      const n = normalizeMoment(end);
      return { ...base, allDay: false, start, end: n, startDay: start.day, endDay: n.day };
    }
    if ("interval" in v) {
      const start = parseLocal(v.interval.start);
      const end = parseLocal(v.interval.end);
      return { ...base, allDay: false, start, end, startDay: start.day, endDay: end.day };
    }
    if ("date" in v) {
      if (typeof v.date !== "string" || !allDay) return "needTime";
      const day = parseLocal(`${v.date}T00:00`).day;
      return { ...base, allDay: true, startDay: day, endDay: day };
    }
    if ("range" in v && !v.range.from.includes("T")) {
      return { ...base, allDay: true, startDay: parseLocal(`${v.range.from}T00:00`).day, endDay: parseLocal(`${v.range.to}T00:00`).day };
    }
    return null;
  };

  const parsed = parseDateFragment({ text: draft.startText, kind: "point", now: formatMoment(now), tz });
  if ("error" in parsed) {
    if (parsed.error === "in_past") return { kind: "ask", question: "inPast", keepStart: false };
    return { kind: "ask", question: "askWhen", keepStart: false };
  }
  const values = "ambiguous" in parsed ? parsed.ambiguous : [parsed];
  const options = values.map(toOption);
  if (options.includes("needTime")) return { kind: "ask", question: "askTime", keepStart: true };
  const ok = options.filter((o): o is CreateOption => o !== null && o !== "needTime");
  if (ok.length === 0) return { kind: "ask", question: "askWhen", keepStart: false };
  return { kind: "options", options: ok };
}

function normalizeMoment(m: Moment): Moment {
  const extra = Math.floor(m.minutes / 1440);
  return { day: m.day + extra, minutes: m.minutes - extra * 1440 };
}

// --- Сценарий --------------------------------------------------------------

export interface CreateArgs {
  user: User;
  chatId: number;
  conversationId: string;
  draft: CreateDraft;
}

export async function startCreate(ctx: AppContext, provider: CalendarProvider, a: CreateArgs): Promise<void> {
  const { user, chatId } = a;
  const locale = user.locale;
  const tz = user.home_tz;
  const now = utcToLocal(ctx.clock.now(), tz);

  const calendars = await provider.calendars();
  const cal = resolveCalendar(calendars, a.draft.calendar);
  if ("error" in cal) {
    const text = cal.error === "readOnly"
      ? t("calendarReadOnly", locale, { name: cal.name })
      : t("calendarNotFound", locale, { name: cal.name, list: calendars.filter((c) => c.writable).map((c) => `«${c.title}»`).join(", ") });
    await ctx.telegram.sendMessage(chatId, text);
    return;
  }

  const res = resolveDraft(a.draft, now, tz, cal, locale);
  if (res.kind === "reply") {
    await ctx.telegram.sendMessage(chatId, res.text);
    return;
  }
  if (res.kind === "ask") {
    // Ответ пользователя дополнит этот же черновик (US-12)
    const draft = res.keepStart ? a.draft : { ...a.draft, startText: undefined };
    await setDialogState(ctx.db, a.conversationId, user.id, { awaiting: { kind: "create_time", draft, expiresAt: ctx.clock.now() + AWAIT_TTL_MS } }, ctx.clock.now());
    await ctx.telegram.sendMessage(chatId, t(res.question, locale));
    return;
  }

  const showCalendar = calendars.filter((c) => c.writable).length > 1;
  const actionId = await createPendingAction(ctx.db, {
    conversationId: a.conversationId, userId: user.id, kind: CREATE_CARD,
    payload: { chatId, options: res.options } satisfies CreateCardPayload, now: ctx.clock.now(),
  });

  let text: string;
  let buttons: InlineKeyboardButton[][];
  if (res.options.length === 1) {
    const o = res.options[0]!;
    text = `${t("createConfirm", locale)}\n\n${cardBody(o, now.day, locale, showCalendar)}`;
    const overlaps = await findOverlaps(provider, o, calendars);
    if (overlaps.length) text += `\n\n${t("overlap", locale, { list: overlaps.join(", ") })}`;
    buttons = [[{ text: t("createButton", locale), callback_data: callbackData(actionId, "c0") }, { text: t("cancelButton", locale), callback_data: callbackData(actionId, "x") }]];
  } else {
    // Неоднозначная дата: вместо «Создать» — кнопка на каждый вариант (US-30)
    const first = res.options[0]!;
    text = `${t("createChoose", locale)}\n\n<b>${escapeHtml(first.title)}</b>${showCalendar ? `\n🗓 ${escapeHtml(first.calendarTitle)}` : ""}`;
    buttons = [
      ...res.options.map((o, i) => [{ text: whenLabel(o, now.day, locale), callback_data: callbackData(actionId, `c${i}`) }]),
      [{ text: t("cancelButton", locale), callback_data: callbackData(actionId, "x") }],
    ];
  }
  const sent = await ctx.telegram.sendMessage(chatId, text, { inline_keyboard: buttons }, { html: true });
  await attachMessage(ctx.db, actionId, sent.message_id);
}

/** Пересечения с событиями в целевом календаре и календаре по умолчанию (US-30). */
async function findOverlaps(provider: CalendarProvider, o: CreateOption, calendars: CalendarInfo[]): Promise<string[]> {
  if (o.allDay) return [];
  const relevant = new Set([o.calendarId, calendars.find((c) => c.isDefault)?.id]);
  const events = await provider.listEvents(localToUtc(o.start!, o.tz), localToUtc(o.end!, o.tz), o.tz);
  return events
    .filter((e) => !e.allDay && !e.free && relevant.has(e.ref.calendarId))
    .map((e) => `${hhmm(e.start!.minutes)}–${hhmm(e.end!.minutes)} ${escapeHtml(e.title)}`);
}

/** Нажатие кнопки на карточке создания. Карточка уже «забрана» атомарно (claimPendingAction). */
export async function confirmCreate(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  action: PendingAction<CreateCardPayload>,
  choice: string,
): Promise<void> {
  const { chatId, options } = action.payload;
  const locale = user.locale;
  const today = utcToLocal(ctx.clock.now(), user.home_tz).day;

  if (choice === "x") {
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("cancelled", locale));
    return;
  }
  const o = options[Number(choice.slice(1))];
  if (!o) return;

  const created = await provider.createEvent({
    calendarId: o.calendarId, title: o.title, tz: o.tz, allDay: o.allDay, startDay: o.startDay, endDay: o.endDay,
    ...(o.start ? { start: o.start } : {}), ...(o.end ? { end: o.end } : {}), ...(o.location ? { location: o.location } : {}),
  });

  const calendarsCount = (await provider.calendars()).filter((c) => c.writable).length;
  const text = `${t("created", locale)}\n\n${cardBody(o, today, locale, calendarsCount > 1)}`;
  const markup = created.link ? { inline_keyboard: [[{ text: t("openInCalendar", locale), url: created.link }]] } : undefined;
  if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, text, markup, { html: true });

  // Название не задано — спросить; ответом считается только reply на этот вопрос (US-30)
  if (!o.titleGiven) {
    const qId = await createPendingAction(ctx.db, {
      conversationId: action.conversationId, userId: user.id, kind: TITLE_QUESTION,
      payload: { ref: created.ref } satisfies TitleQuestionPayload, now: ctx.clock.now(),
    });
    const q = await ctx.telegram.sendMessage(chatId, t("askTitle", locale), { force_reply: true });
    await attachMessage(ctx.db, qId, q.message_id);
  }
}

/** Новая команда аннулирует открытые карточки создания и вопрос о названии (US-05, US-30). */
export async function cancelOpenCreateCards(ctx: AppContext, conversationId: string, user: User): Promise<void> {
  const cancelled = await cancelOpenCards(ctx.db, conversationId, user.id, [CREATE_CARD, TITLE_QUESTION]);
  for (const c of cancelled) {
    if (c.kind !== CREATE_CARD || !c.messageId) continue;
    const { chatId } = c.payload as CreateCardPayload;
    await ctx.telegram.editMessageText(chatId, c.messageId, t("cancelled", user.locale));
  }
}
