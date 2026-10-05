// US-40 / US-41 / US-43: перенос и изменение события.
// Поиск события по описанию → расчёт изменений (детерминированно, по фрагментам из текста) →
// карточка «Было → Стало» → подтверждение. Повторяющиеся — «только эту / все».

import { titleScore, queryWords } from "../calendar/match";
import type { CalendarEvent, CalendarInfo, CalendarProvider, EventRef } from "../calendar/model";
import { parseDateFragment, type ParseValue } from "../dates";
import { addMinutes, formatMoment, localToUtc, minutesBetween, parseLocal, utcToLocal, type Moment } from "../dates/calendar";
import { durationToMinutes } from "../dates/duration";
import type { ModifySpans } from "../dates/extract";
import { fragmentParts } from "../dates/point";
import { tokenize } from "../dates/tokenize";
import {
  attachMessage, CONTEXT_TTL_MS, createPendingAction, getDialogState, mergeDialogState, type PendingAction,
} from "../db/conversations";
import type { User } from "../db/users";
import { GoogleApiError } from "../google/calendar-api";
import type { InlineKeyboardButton } from "../telegram/types";
import type { AppContext } from "./context";
import { escapeHtml, eventLabel, spanLabel } from "./format";
import { callbackData } from "./keyboards";
import { t } from "./messages";

export const MODIFY_CARD = "modify";
export const PICK_CARD = "pick";
const SEARCH_DAYS = 30;
const MAX_CANDIDATES = 5;

export interface ModifyRequest {
  /** Описание события: «встречу с Петей», «планёрку». */
  query?: string;
  /** «следующую», «её/эту», «вторую» (из последнего списка). */
  reference?: "next" | "last" | "list";
  listIndex?: number;
  newTitle?: string;
  newLocation?: string;
  scope?: "this" | "all";
  spans: ModifySpans;
}

/** Вариант изменения — хранится в карточке. */
interface Change {
  start?: Moment;
  end?: Moment;
  title?: string;
  location?: string;
}

interface ModifyCardPayload {
  chatId: number;
  tz: string;
  ref: EventRef;
  seriesId?: string;
  etag?: string;
  title: string;
  oldStart: Moment;
  oldEnd: Moment;
  notify: boolean;
  options: Change[];
  /** Кнопки «только эту / все» вместо «подтвердить». */
  askScope: boolean;
}

interface PickCardPayload {
  chatId: number;
  refs: EventRef[];
  request: ModifyRequest;
}

const plus = addMinutes;
const diff = minutesBetween;

// --- Поиск события ----------------------------------------------------------

/**
 * Кандидаты. fuzzy=true — по названию ничего не совпало, но день указан: предлагаем все события дня
 * («Не нашёл „созвон“ — может, одна из этих?»), это закрывает и синонимы («созвон» ↔ «звонок»).
 */
async function findCandidates(ctx: AppContext, provider: CalendarProvider, user: User, conversationId: string, req: ModifyRequest): Promise<{ events: CalendarEvent[]; fuzzy: boolean }> {
  const tz = user.home_tz;
  const nowUtc = ctx.clock.now();
  const now = utcToLocal(nowUtc, tz);

  if (req.reference === "last" || req.reference === "list") {
    const state = await getDialogState(ctx.db, conversationId, user.id);
    const fresh = (at: number) => nowUtc - at < CONTEXT_TTL_MS;
    let ref = req.reference === "last" && state.lastEvent && fresh(state.lastEvent.at) ? state.lastEvent.ref : undefined;
    if (req.reference === "list" && state.lastList && fresh(state.lastList.at) && req.listIndex) ref = state.lastList.refs[req.listIndex - 1];
    if (ref) {
      const e = await provider.getEvent(ref, tz);
      return { events: e ? [e] : [], fuzzy: false };
    }
    if (!req.query && !req.spans.reference) return { events: [], fuzzy: false };
  }

  // Окно поиска: день/время из фразы или ближайшие 30 дней
  let from = localToUtc({ day: now.day, minutes: 0 }, tz);
  let to = localToUtc({ day: now.day + SEARCH_DAYS, minutes: 0 }, tz);
  let exact: Moment | undefined;
  if (req.spans.reference) {
    const parsed = parseDateFragment({ text: req.spans.reference, kind: "point", now: formatMoment(now), tz });
    const value: ParseValue | undefined = "ambiguous" in parsed ? parsed.ambiguous[0] : "error" in parsed ? undefined : parsed;
    if (value && "datetime" in value) {
      exact = parseLocal(value.datetime);
      from = localToUtc({ day: exact.day, minutes: 0 }, tz);
      to = localToUtc({ day: exact.day + 1, minutes: 0 }, tz);
    } else if (value && "date" in value) {
      const d = parseLocal(`${typeof value.date === "string" ? value.date : value.date.date}T00:00`).day;
      from = localToUtc({ day: d, minutes: 0 }, tz);
      to = localToUtc({ day: d + 1, minutes: 0 }, tz);
    }
  }

  const inWindow = await provider.listEvents(from, to, tz);
  let events = exact ? inWindow.filter((e) => !e.allDay && e.start!.day === exact!.day && e.start!.minutes === exact!.minutes) : inWindow;
  let fuzzy = false;
  if (req.query && queryWords(req.query).length) {
    const scored = events.map((e) => ({ e, s: titleScore(req.query!, e.title) })).filter((x) => x.s > 0);
    const best = Math.max(0, ...scored.map((x) => x.s));
    events = scored.filter((x) => x.s === best).map((x) => x.e);
    // Название не совпало, но день назван — предложить события этого дня
    if (events.length === 0 && req.spans.reference) {
      events = inWindow.filter((e) => !e.allDay);
      fuzzy = events.length > 0;
    }
  }
  if (req.reference === "next" || (!req.spans.reference && !exact)) {
    // Без указания дня — ближайшие ещё не начавшиеся (US-21)
    events = events.filter((e) => e.allDay ? e.startDay >= now.day : diff(e.start!, now) > 0);
  }
  events.sort((a, b) => (a.start ? localToUtc(a.start, tz) : a.startDay * 86_400_000) - (b.start ? localToUtc(b.start, tz) : b.startDay * 86_400_000));
  if (req.reference === "next") events = events.slice(0, 1);
  return { events, fuzzy };
}

// --- Расчёт изменений ---------------------------------------------------------

type ChangeResult = { options: Change[] } | { error: "nothingToChange" | "notUnderstood" | "inPast" | "allDayTime" };

function computeChange(e: CalendarEvent, req: ModifyRequest, nowLocal: Moment, tz: string): ChangeResult {
  const s = req.spans;
  const base: Change = {
    ...(req.newTitle ? { title: req.newTitle } : {}),
    ...(req.newLocation ? { location: req.newLocation } : {}),
  };
  const wantsTime = !!(s.shift || s.target || s.duration);
  if (!wantsTime) return Object.keys(base).length ? { options: [base] } : { error: "nothingToChange" };
  if (e.allDay) return { error: "allDayTime" };

  const start = e.start!;
  const end = e.end!;
  const length = diff(end, start);
  const options: Change[] = [];

  if (s.shift) {
    const parsed = parseDateFragment({ text: s.shift, kind: "shift", now: formatMoment(nowLocal), tz });
    const minutes = "shift" in parsed ? durationToMinutes(parsed.shift) : null;
    if (minutes === null) return { error: "notUnderstood" };
    options.push({ ...base, start: plus(start, minutes), end: plus(end, minutes) });
  } else if (s.target) {
    const parts = fragmentParts(tokenize(s.target));
    if (!parts) return { error: "notUnderstood" };
    // Только время («на 11») — тот же день события; только дата («на пятницу») — то же время
    const now = parts.hasDate ? formatMoment(nowLocal) : formatMoment({ day: start.day, minutes: 0 });
    const parsed = parseDateFragment({ text: s.target, kind: "point", now, tz });
    if ("error" in parsed) return { error: parsed.error === "in_past" ? "inPast" : "notUnderstood" };
    for (const v of "ambiguous" in parsed ? parsed.ambiguous : [parsed]) {
      if ("datetime" in v) {
        const ns = parseLocal(v.datetime);
        options.push({ ...base, start: ns, end: plus(ns, length) });
      } else if ("interval" in v) {
        options.push({ ...base, start: parseLocal(v.interval.start), end: parseLocal(v.interval.end) });
      } else if ("date" in v) {
        const day = parseLocal(`${typeof v.date === "string" ? v.date : v.date.date}T00:00`).day;
        const ns = { day, minutes: start.minutes };
        options.push({ ...base, start: ns, end: plus(ns, length) });
      }
    }
    if (!options.length) return { error: "notUnderstood" };
  } else {
    options.push({ ...base, start, end });
  }

  if (s.duration) {
    const parsed = parseDateFragment({ text: s.duration, kind: "duration", now: formatMoment(nowLocal), tz });
    const minutes = "duration" in parsed && parsed.duration !== "all_day" ? durationToMinutes(parsed.duration) : null;
    if (!minutes) return { error: "notUnderstood" };
    for (const o of options) o.end = plus(o.start!, minutes);
  }
  if (options.every((o) => o.start && diff(o.start, nowLocal) <= 0)) return { error: "inPast" };
  return { options: options.filter((o) => !o.start || diff(o.start, nowLocal) > 0) };
}

// --- Сценарий ---------------------------------------------------------------

export interface ModifyArgs {
  user: User;
  chatId: number;
  conversationId: string;
  request: ModifyRequest;
}

export async function startModify(ctx: AppContext, provider: CalendarProvider, a: ModifyArgs): Promise<void> {
  const { user, chatId } = a;
  const locale = user.locale;
  const today = utcToLocal(ctx.clock.now(), user.home_tz).day;
  const { events: candidates, fuzzy } = await findCandidates(ctx, provider, user, a.conversationId, a.request);

  if (candidates.length === 0) {
    await ctx.telegram.sendMessage(chatId, a.request.query ? t("eventNotFound", locale, { query: a.request.query }) : t("eventNotFoundGeneric", locale));
    return;
  }
  if (candidates.length > 1 || fuzzy) {
    if (candidates.length > MAX_CANDIDATES) {
      await ctx.telegram.sendMessage(chatId, t("tooManyCandidates", locale, { n: String(candidates.length) }));
      return;
    }
    const id = await createPendingAction(ctx.db, {
      conversationId: a.conversationId, userId: user.id, kind: PICK_CARD,
      payload: { chatId, refs: candidates.map((c) => c.ref), request: a.request } satisfies PickCardPayload, now: ctx.clock.now(),
    });
    const buttons: InlineKeyboardButton[][] = [
      ...candidates.map((c, i) => [{ text: eventLabel(c, today, locale).slice(0, 60), callback_data: callbackData(id, `e${i}`) }]),
      [{ text: t("cancelButton", locale), callback_data: callbackData(id, "x") }],
    ];
    const header = fuzzy && a.request.query ? t("notFoundSuggest", locale, { query: a.request.query }) : t("whichEvent", locale);
    const sent = await ctx.telegram.sendMessage(chatId, header, { inline_keyboard: buttons });
    await attachMessage(ctx.db, id, sent.message_id);
    return;
  }
  await proposeChange(ctx, provider, a.user, a.chatId, a.conversationId, candidates[0]!, a.request);
}

async function proposeChange(ctx: AppContext, provider: CalendarProvider, user: User, chatId: number, conversationId: string, e: CalendarEvent, req: ModifyRequest): Promise<void> {
  const locale = user.locale;
  const tz = user.home_tz;
  const calendars: CalendarInfo[] = await provider.calendars();
  const cal = calendars.find((c) => c.id === e.ref.calendarId);
  if (!cal?.writable) {
    await ctx.telegram.sendMessage(chatId, t("calendarReadOnly", locale, { name: e.calendarTitle }));
    return;
  }
  // Не организатор: изменение увидит только он сам — запрещаем (US-40)
  if (!e.organizerIsSelf) {
    await ctx.telegram.sendMessage(chatId, t("notOrganizer", locale, { title: escapeHtml(e.title) }), undefined, { html: true });
    return;
  }

  const now = utcToLocal(ctx.clock.now(), tz);
  const today = now.day;
  const res = computeChange(e, req, now, tz);
  if ("error" in res) {
    await ctx.telegram.sendMessage(chatId, t(`modify_${res.error}`, locale));
    return;
  }

  const askScope = e.recurring && req.scope === undefined && res.options.length === 1;
  const sameDay = res.options.every((o) => !o.start || o.start.day === e.start?.day);
  const payload: ModifyCardPayload = {
    chatId, tz, ref: e.ref, title: e.title, oldStart: e.start ?? { day: e.startDay, minutes: 0 }, oldEnd: e.end ?? { day: e.endDay, minutes: 0 },
    notify: e.hasOtherAttendees, options: res.options, askScope: askScope && sameDay,
    ...(e.seriesId ? { seriesId: e.seriesId } : {}), ...(e.etag ? { etag: e.etag } : {}),
  };
  // «Все» — только изменения в пределах дня; перенос серии на другой день — R2
  if (req.scope === "all" && !sameDay) {
    await ctx.telegram.sendMessage(chatId, t("seriesMoveUnsupported", locale));
    return;
  }

  const id = await createPendingAction(ctx.db, { conversationId, userId: user.id, kind: MODIFY_CARD, payload, now: ctx.clock.now() });
  const o = res.options[0]!;
  const lines = [`${t(o.start ? "modifyMoveConfirm" : "modifyConfirm", locale)}`, "", `<b>${escapeHtml(e.title)}</b>`];
  if (res.options.length === 1 && o.start) {
    lines.push(`${t("was", locale)}: ${spanLabel(payload.oldStart, payload.oldEnd, today, locale)}`, `${t("now", locale)}: ${spanLabel(o.start, o.end!, today, locale)}`);
  }
  if (o.title) lines.push(`${t("newTitle", locale)}: <b>${escapeHtml(o.title)}</b>`);
  if (o.location) lines.push(`📍 ${escapeHtml(o.location)}`);
  if (e.recurring && !payload.askScope && req.scope !== "all") lines.push(t("onlyThisOccurrence", locale));
  if (payload.notify) lines.push("", t("attendeesNotified", locale));

  let buttons: InlineKeyboardButton[][];
  if (res.options.length > 1) {
    buttons = [
      ...res.options.map((x, i) => [{ text: spanLabel(x.start!, x.end!, today, locale), callback_data: callbackData(id, `c${i}`) }]),
      [{ text: t("cancelButton", locale), callback_data: callbackData(id, "x") }],
    ];
  } else if (payload.askScope) {
    buttons = [
      [{ text: t("onlyThis", locale), callback_data: callbackData(id, "c0") }, { text: t("wholeSeries", locale), callback_data: callbackData(id, "all") }],
      [{ text: t("cancelButton", locale), callback_data: callbackData(id, "x") }],
    ];
  } else {
    buttons = [[
      { text: t("confirmButton", locale), callback_data: callbackData(id, req.scope === "all" ? "all" : "c0") },
      { text: t("cancelButton", locale), callback_data: callbackData(id, "x") },
    ]];
  }
  const sent = await ctx.telegram.sendMessage(chatId, lines.join("\n"), { inline_keyboard: buttons }, { html: true });
  await attachMessage(ctx.db, id, sent.message_id);
}

/** Выбор события из нескольких кандидатов. */
export async function confirmPick(ctx: AppContext, provider: CalendarProvider, user: User, action: PendingAction<PickCardPayload>, choice: string): Promise<void> {
  const { chatId, refs, request } = action.payload;
  const today = utcToLocal(ctx.clock.now(), user.home_tz).day;
  if (choice === "x") {
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("cancelled", user.locale));
    return;
  }
  const ref = refs[Number(choice.slice(1))];
  const e = ref ? await provider.getEvent(ref, user.home_tz) : null;
  if (!e) {
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("eventGone", user.locale));
    return;
  }
  if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, `${t("picked", user.locale)}: ${eventLabel(e, today, user.locale)}`);
  await proposeChange(ctx, provider, user, chatId, action.conversationId, e, request);
}

/** Подтверждение изменения. Карточка уже «забрана» атомарно. */
export async function confirmModify(ctx: AppContext, provider: CalendarProvider, user: User, action: PendingAction<ModifyCardPayload>, choice: string): Promise<void> {
  const p = action.payload;
  const locale = user.locale;
  const today = utcToLocal(ctx.clock.now(), user.home_tz).day;
  const edit = (text: string) => (action.messageId ? ctx.telegram.editMessageText(p.chatId, action.messageId, text, undefined, { html: true }) : Promise.resolve());

  if (choice === "x") {
    await edit(t("cancelled", locale));
    return;
  }
  const wholeSeries = choice === "all";
  const o = p.options[wholeSeries ? 0 : Number(choice.slice(1))];
  if (!o) return;

  try {
    if (wholeSeries && p.seriesId) {
      // Серия: тот же сдвиг и длительность применяются к мастер-событию (только в пределах дня)
      const masterRef = { ...p.ref, providerEventId: p.seriesId };
      const master = await provider.getEvent(masterRef, p.tz);
      if (!master || master.allDay) throw new GoogleApiError("series not found", 404);
      const delta = o.start ? diff(o.start, p.oldStart) : 0;
      const length = o.start ? diff(o.end!, o.start) : diff(master.end!, master.start!);
      const ms = plus(master.start!, delta);
      await provider.updateEvent(masterRef, { tz: p.tz, ...o, start: ms, end: plus(ms, length) }, { notify: p.notify });
    } else {
      await provider.updateEvent(p.ref, { tz: p.tz, ...o }, { notify: p.notify, ...(p.etag ? { etag: p.etag } : {}) });
    }
  } catch (e) {
    if (e instanceof GoogleApiError && e.status === 412) {
      await edit(t("eventChangedMeanwhile", locale));
      return;
    }
    if (e instanceof GoogleApiError && (e.status === 404 || e.status === 410)) {
      await edit(t("eventGone", locale));
      return;
    }
    throw e;
  }

  const lines = [t("modified", locale), "", `<b>${escapeHtml(o.title ?? p.title)}</b>`];
  if (o.start) lines.push(`🕒 ${spanLabel(o.start, o.end!, today, locale)}`);
  if (wholeSeries) lines.push(t("wholeSeriesChanged", locale));
  await edit(lines.join("\n"));
  await mergeDialogState(ctx.db, action.conversationId, user.id, { lastEvent: { ref: p.ref, at: ctx.clock.now() } }, ctx.clock.now());
}
