// US-30 / US-31: создание события. Карточка-подтверждение (осторожный режим), варианты кнопками для
// неоднозначных дат, вопрос «во сколько?», предупреждение о пересечениях, вопрос о названии.
// US-32: повторяющиеся — правило словами и три ближайшие даты в карточке; серия начинается с первой даты.

import { findCalendarByName } from "../calendar/match";
import type { CalendarInfo, CalendarProvider, EventRef } from "../calendar/model";
import { addMinutes, formatMoment, localToUtc, parseLocal, parts, utcToLocal, type Day, type Moment } from "../dates/calendar";
import { durationToMinutes } from "../dates/duration";
import { parseDateFragment, type ParseValue, type Recurrence } from "../dates";
import { describeRecurrence, occurrences, toRRule } from "../dates/rrule";
import {
  attachMessage, createPendingAction, mergeDialogState, type PendingAction,
} from "../db/conversations";
import { DEFAULT_DURATION_MIN } from "../db/settings";
import type { User } from "../db/users";
import type { CreateEventIntent } from "../nlu/intents";
import type { InlineKeyboardButton } from "../telegram/types";
import type { AppContext } from "./context";
import { dateLabel, escapeHtml, hhmm, whenOf } from "./format";
import { callbackData } from "./keyboards";
import { attachUndoMessage, recordUndo } from "./undo";
import { t } from "./messages";

export const CREATE_CARD = "create";
export const TITLE_QUESTION = "title";
const AWAIT_TTL_MS = 15 * 60 * 1000;

/** Черновик создания: то, что сказал пользователь (фрагменты), — до разрешения дат. */
export interface CreateDraft {
  startText?: string;
  /** Правило повторения как сказано: «каждый понедельник в 10» (US-32). */
  recurrenceText?: string;
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
  series?: SeriesInfo;
}

/** Повторение: готовый RRULE и то, что показываем в карточке. */
export interface SeriesInfo {
  rrule: string;
  /** «Каждый понедельник». */
  text: string;
  /** Ближайшие даты, начиная с первой (она же начало серии). */
  next: Day[];
  /** Вариант для 29–31 числа (выбирается кнопкой): пропускать короткие месяцы или ставить на последний день. */
  shortMonths?: "skip" | "last_day";
}

export interface CreateCardPayload {
  chatId: number;
  options: CreateOption[];
}

export interface TitleQuestionPayload {
  ref: EventRef;
  /** Текущее название — чтобы переименование можно было отменить (US-61). */
  title: string;
}

export function draftFromIntent(i: CreateEventIntent): CreateDraft {
  return {
    ...(i.start ? { startText: i.start } : {}),
    ...(i.title ? { title: i.title } : {}),
    ...(i.duration ? { durationText: i.duration } : {}),
    ...(i.allDay ? { allDay: true } : {}),
    ...(i.calendar ? { calendar: i.calendar } : {}),
    ...(i.location ? { location: i.location } : {}),
  };
}

// --- Формат ---------------------------------------------------------------

export const whenLabel = (o: CreateOption, today: Day, locale: string) => whenOf(o, today, locale);

function cardBody(o: CreateOption, today: Day, locale: string, showCalendar: boolean): string {
  const lines = [`<b>${escapeHtml(o.title)}</b>`];
  if (o.series) {
    const time = o.allDay ? t("allDayLower", locale) : `${hhmm(o.start!.minutes)}–${hhmm(o.end!.minutes)}`;
    lines.push(`🔁 ${escapeHtml(o.series.text)}, ${time}`);
    lines.push(`📅 ${t("seriesNext", locale, { list: o.series.next.map((d) => dateLabel(d, today, locale)).join(" · ") })}`);
  } else {
    lines.push(`🕒 ${whenLabel(o, today, locale)}`);
  }
  if (o.location) lines.push(`📍 ${escapeHtml(o.location)}`);
  if (showCalendar) lines.push(`🗓 ${escapeHtml(o.calendarTitle)}`);
  return lines.join("\n");
}

// --- Разрешение черновика --------------------------------------------------

type Resolution =
  | { kind: "options"; options: CreateOption[] }
  | { kind: "ask"; question: "askWhen" | "askTime" | "inPast"; keepStart: boolean }
  | { kind: "reply"; text: string };

function resolveCalendar(calendars: CalendarInfo[], name: string | undefined): CalendarInfo | { error: "notFound" | "readOnly"; name: string } {
  if (name) {
    const cal = findCalendarByName(calendars, name);
    if (!cal) return { error: "notFound", name };
    if (!cal.writable) return { error: "readOnly", name: cal.title };
    return cal;
  }
  return calendars.find((c) => c.isDefault && c.writable) ?? calendars.find((c) => c.writable) ?? { error: "notFound", name: "" };
}

function resolveDraft(draft: CreateDraft, now: Moment, tz: string, cal: CalendarInfo, locale: string, defaultDuration: number): Resolution {
  if (draft.recurrenceText) return resolveSeries(draft, draft.recurrenceText, now, tz, cal, locale, defaultDuration);
  if (!draft.startText) return { kind: "ask", question: "askWhen", keepStart: false };

  const length = resolveLength(draft, now, tz, locale, defaultDuration);
  if ("kind" in length) return length;
  const { duration, allDay } = length;
  const base = optionBase(draft, cal, tz, locale);

  const toOption = (v: ParseValue): CreateOption | "needTime" | null => {
    if ("datetime" in v) {
      const start = parseLocal(v.datetime);
      const end = addMinutes(start, duration);
      return { ...base, allDay: false, start, end, startDay: start.day, endDay: end.day };
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

/** Длительность и «весь день» из черновика. */
function resolveLength(draft: CreateDraft, now: Moment, tz: string, locale: string, defaultDuration: number): { duration: number; allDay: boolean } | Resolution {
  let duration = defaultDuration;
  let allDay = draft.allDay ?? false;
  if (draft.durationText) {
    const d = parseDateFragment({ text: draft.durationText, kind: "duration", now: formatMoment(now), tz });
    if ("error" in d || !("duration" in d)) return { kind: "reply", text: t("durationUnparseable", locale) };
    if (d.duration === "all_day") allDay = true;
    else {
      const minutes = durationToMinutes(d.duration);
      // «на месяц» и т.п. — не длительность встречи
      if (!minutes || minutes <= 0) return { kind: "reply", text: t("durationUnparseable", locale) };
      duration = minutes;
    }
  }
  return { duration, allDay };
}

function optionBase(draft: CreateDraft, cal: CalendarInfo, tz: string, locale: string) {
  return {
    calendarId: cal.id,
    calendarTitle: cal.title,
    title: draft.title ?? t("defaultTitle", locale),
    titleGiven: !!draft.title,
    tz,
    ...(draft.location ? { location: draft.location } : {}),
  };
}

const SERIES_PREVIEW = 3;

/** Серия (US-32): первая дата правила не раньше «сейчас» — начало серии; время — из правила. */
function resolveSeries(draft: CreateDraft, text: string, now: Moment, tz: string, cal: CalendarInfo, locale: string, defaultDuration: number): Resolution {
  const parsed = parseDateFragment({ text, kind: "recurrence", now: formatMoment(now), tz });
  if (!("recurrence" in parsed)) return { kind: "ask", question: "askWhen", keepStart: false };
  const r: Recurrence = parsed.recurrence;
  const length = resolveLength(draft, now, tz, locale, defaultDuration);
  if ("kind" in length) return length;
  const { duration, allDay } = length;
  if (!r.time && !allDay) return { kind: "ask", question: "askTime", keepStart: true };

  const minutes = r.time ? Number(r.time.slice(0, 2)) * 60 + Number(r.time.slice(3)) : 0;
  // Сегодняшнее вхождение — только если его время ещё не прошло
  const from = allDay || minutes > now.minutes ? now.day : now.day + 1;
  const next = occurrences(r, from, SERIES_PREVIEW);
  if (next.length === 0) return { kind: "reply", text: t("seriesNoDates", locale) };

  const base = optionBase(draft, cal, tz, locale);
  const option = (rule: Recurrence, dates: Day[]): CreateOption => {
    const first = dates[0]!;
    const start: Moment = { day: first, minutes };
    const end = addMinutes(start, duration);
    const series: SeriesInfo = {
      rrule: toRRule(rule, start, tz, allDay),
      text: describeRecurrence(rule, first, locale),
      next: dates,
      ...(rule.short_months ? { shortMonths: rule.short_months } : {}),
    };
    return allDay
      ? { ...base, allDay: true, startDay: first, endDay: first, series }
      : { ...base, allDay: false, start, end, startDay: start.day, endDay: end.day, series };
  };
  // 29–31 число: в коротких месяцах такого дня нет — спрашиваем, пропускать или ставить на последний день
  if (r.warning === "skips_short_months" && !r.count && !r.until) {
    const variants = (["skip", "last_day"] as const).map((short_months) => ({ ...r, short_months }));
    return { kind: "options", options: variants.map((v) => option(v, occurrences(v, from, SERIES_PREVIEW))) };
  }
  return { kind: "options", options: [option(r, next)] };
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

  const res = resolveDraft(a.draft, now, tz, cal, locale, user.settings.durationMin ?? DEFAULT_DURATION_MIN);
  if (res.kind === "reply") {
    await ctx.telegram.sendMessage(chatId, res.text);
    return;
  }
  if (res.kind === "ask") {
    // Ответ пользователя дополнит этот же черновик (US-12)
    const draft = res.keepStart ? a.draft : { ...a.draft, startText: undefined };
    await mergeDialogState(ctx.db, a.conversationId, user.id, { awaiting: { kind: "create_time", draft, expiresAt: ctx.clock.now() + AWAIT_TTL_MS } }, ctx.clock.now());
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
    text = `${t(o.series ? "createSeriesConfirm" : "createConfirm", locale)}\n\n${cardBody(o, now.day, locale, showCalendar)}`;
    const overlaps = await findOverlaps(provider, o, calendars);
    if (overlaps.length) text += `\n\n${t("overlap", locale, { list: overlaps.join(", ") })}`;
    buttons = [[{ text: t("createButton", locale), callback_data: callbackData(actionId, "c0") }, { text: t("cancelButton", locale), callback_data: callbackData(actionId, "x") }]];
  } else if (res.options[0]!.series?.shortMonths) {
    // Серия на 29–31 число: как быть с короткими месяцами (US-32)
    const [skip, last] = res.options as [CreateOption, CreateOption];
    const time = skip.allDay ? t("allDayLower", locale) : `${hhmm(skip.start!.minutes)}–${hhmm(skip.end!.minutes)}`;
    const dates = (o: CreateOption) => o.series!.next.map((d) => dateLabel(d, now.day, locale)).join(" · ");
    const day = String(parts(skip.series!.next[0]!).date);
    text = [
      t("createSeriesConfirm", locale), "",
      `<b>${escapeHtml(skip.title)}</b>`,
      `🔁 ${t("seriesMonthly", locale, { day })}, ${time}`,
      ...(showCalendar ? [`🗓 ${escapeHtml(skip.calendarTitle)}`] : []), "",
      t("seriesShortMonthsQuestion", locale, { day }),
      `• ${t("seriesSkipOption", locale)}: ${dates(skip)}`,
      `• ${t("seriesLastDayOption", locale)}: ${dates(last)}`,
    ].join("\n");
    buttons = [
      [{ text: t("seriesSkipButton", locale), callback_data: callbackData(actionId, "c0") }, { text: t("seriesLastDayButton", locale), callback_data: callbackData(actionId, "c1") }],
      [{ text: t("cancelButton", locale), callback_data: callbackData(actionId, "x") }],
    ];
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
    .map((e) => `${hhmm(e.start!.minutes)}–${hhmm(e.end!.minutes)}${e.start!.day !== o.start!.day ? ` (${dateLabel(e.start!.day, o.start!.day, "ru")})` : ""} ${escapeHtml(e.title)}`);
}

/** Напоминания по умолчанию из настроек бота (US-04): нет — как в Google; для «весь день» — без напоминаний. */
function remindersFor(user: User, allDay: boolean): { reminders?: number[] } {
  const r = allDay ? user.settings.allDayReminders ?? [] : user.settings.reminders;
  return r ? { reminders: r } : {};
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
    idempotencyKey: `${action.id}${choice.slice(1)}`,
    calendarId: o.calendarId, title: o.title, tz: o.tz, allDay: o.allDay, startDay: o.startDay, endDay: o.endDay,
    ...(o.start ? { start: o.start } : {}), ...(o.end ? { end: o.end } : {}), ...(o.location ? { location: o.location } : {}),
    ...(o.series ? { recurrence: [o.series.rrule] } : {}),
    ...remindersFor(user, o.allDay),
  });

  const calendarsCount = (await provider.calendars()).filter((c) => c.writable).length;
  const body = cardBody(o, today, locale, calendarsCount > 1);
  const undo = await recordUndo(ctx, {
    conversationId: action.conversationId, user, chatId,
    record: { kind: "create", ref: created.ref, ...(created.etag ? { etag: created.etag } : {}) }, summary: body,
  });
  const row = [...(created.link ? [{ text: t("openInCalendar", locale), url: created.link }] : []), undo.button];
  if (action.messageId) {
    await ctx.telegram.editMessageText(chatId, action.messageId, `${t("created", locale)}\n\n${body}`, { inline_keyboard: [row] }, { html: true });
    await attachUndoMessage(ctx.db, undo.undoId, Number(action.messageId));
  }
  await mergeDialogState(ctx.db, action.conversationId, user.id, { lastEvent: { ref: created.ref, at: ctx.clock.now() } }, ctx.clock.now());

  // Название не задано — спросить; ответом считается только reply на этот вопрос (US-30)
  if (!o.titleGiven) {
    const qId = await createPendingAction(ctx.db, {
      conversationId: action.conversationId, userId: user.id, kind: TITLE_QUESTION,
      payload: { ref: created.ref, title: o.title } satisfies TitleQuestionPayload, now: ctx.clock.now(),
    });
    const q = await ctx.telegram.sendMessage(chatId, t("askTitle", locale), { force_reply: true });
    await attachMessage(ctx.db, qId, q.message_id);
  }
}
