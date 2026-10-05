// Поиск события по описанию для изменения и удаления (US-40, US-50): описание с падежами, день/время
// из фразы, «следующую», «её», «вторую» (US-60); несколько — кнопками, по названию не нашлось — события дня.

import { queryWords, titleScore } from "../calendar/match";
import type { CalendarEvent, CalendarProvider, EventRef } from "../calendar/model";
import { parseDateFragment, type ParseValue } from "../dates";
import { formatMoment, localToUtc, minutesBetween, parseLocal, utcToLocal, type Moment } from "../dates/calendar";
import type { ModifySpans } from "../dates/extract";
import { attachMessage, CONTEXT_TTL_MS, createPendingAction, getDialogState, type PendingAction } from "../db/conversations";
import type { User } from "../db/users";
import type { InlineKeyboardButton } from "../telegram/types";
import type { AppContext } from "./context";

const DAY_MS = 86_400_000;
import { eventLabel } from "./format";
import { callbackData } from "./keyboards";
import { t } from "./messages";

export const PICK_CARD = "pick";
const SEARCH_DAYS = 30;
const MAX_CANDIDATES = 5;
const diff = minutesBetween;

export type EventPurpose = "modify" | "delete";

export interface EventRequest {
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

interface PickCardPayload {
  chatId: number;
  refs: EventRef[];
  request: EventRequest;
  purpose: EventPurpose;
}

// --- Поиск события ----------------------------------------------------------

/**
 * Кандидаты. fuzzy=true — по названию ничего не совпало, но день указан: предлагаем все события дня
 * («Не нашёл „созвон“ — может, одна из этих?»), это закрывает и синонимы («созвон» ↔ «звонок»).
 */
async function findCandidates(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  conversationId: string,
  req: EventRequest,
): Promise<{ events: CalendarEvent[]; fuzzy: boolean; elsewhere?: boolean }> {
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

  const { events: inWindow } = await provider.listEvents(from, to, tz);
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
      // В этот день вообще пусто — поискать по названию в ближайшие дни («сегодняшнее рисование», а оно в понедельник)
      if (!fuzzy) {
        const ahead = (await provider.listEvents(localToUtc({ day: now.day, minutes: 0 }, tz), localToUtc({ day: now.day + SEARCH_DAYS, minutes: 0 }, tz), tz))
          .events;
        const scored = ahead.map((e) => ({ e, s: titleScore(req.query!, e.title) })).filter((x) => x.s > 0);
        const top = Math.max(0, ...scored.map((x) => x.s));
        const found = scored.filter((x) => x.s === top).map((x) => x.e);
        if (found.length) {
          const key = (e: CalendarEvent) => (e.start ? localToUtc(e.start, tz) : e.startDay * DAY_MS);
          return { events: found.sort((a, b) => key(a) - key(b)).slice(0, MAX_CANDIDATES), fuzzy: false, elsewhere: true };
        }
      }
    }
  }
  if (req.reference === "next" || (!req.spans.reference && !exact)) {
    // Без указания дня — ближайшие ещё не начавшиеся (US-21)
    events = events.filter((e) => (e.allDay ? e.startDay >= now.day : diff(e.start!, now) > 0));
  }
  // Событие на весь день — по полуночи UTC своего дня
  const sortKey = (e: CalendarEvent) => (e.start ? localToUtc(e.start, tz) : e.startDay * DAY_MS);
  events.sort((a, b) => sortKey(a) - sortKey(b));
  if (req.reference === "next") events = events.slice(0, 1);
  return { events, fuzzy };
}

export interface LocateArgs {
  user: User;
  chatId: number;
  conversationId: string;
  request: EventRequest;
  purpose: EventPurpose;
}

/** Ровно одно найденное событие — или null, если пользователю уже ответили (не найдено / выбор кнопками). */
export async function locateEvent(ctx: AppContext, provider: CalendarProvider, a: LocateArgs): Promise<CalendarEvent | null> {
  const { user, chatId } = a;
  const locale = user.locale;
  const today = utcToLocal(ctx.clock.now(), user.home_tz).day;
  const { events: candidates, fuzzy, elsewhere } = await findCandidates(ctx, provider, user, a.conversationId, a.request);

  if (candidates.length === 0) {
    await ctx.telegram.sendMessage(chatId, a.request.query ? t("eventNotFound", locale, { query: a.request.query }) : t("eventNotFoundGeneric", locale));
    return null;
  }
  // Найдено в другой день — только с подтверждением, даже если одно
  if (candidates.length === 1 && !fuzzy && !elsewhere) return candidates[0]!;
  if (candidates.length > MAX_CANDIDATES) {
    await ctx.telegram.sendMessage(chatId, t("tooManyCandidates", locale, { n: String(candidates.length) }));
    return null;
  }
  const id = await createPendingAction(ctx.db, {
    conversationId: a.conversationId,
    userId: user.id,
    kind: PICK_CARD,
    payload: { chatId, refs: candidates.map((c) => c.ref), request: a.request, purpose: a.purpose } satisfies PickCardPayload,
    now: ctx.clock.now(),
  });
  const buttons: InlineKeyboardButton[][] = [
    ...candidates.map((c, i) => [{ text: eventLabel(c, today, locale).slice(0, 60), callback_data: callbackData(id, `e${i}`) }]),
    [{ text: t("cancelButton", locale), callback_data: callbackData(id, "x") }],
  ];
  const header =
    elsewhere && a.request.query
      ? t("foundOtherDay", locale, { query: a.request.query })
      : fuzzy && a.request.query
        ? t("notFoundSuggest", locale, { query: a.request.query })
        : t("whichEvent", locale);
  const sent = await ctx.telegram.sendMessage(chatId, header, { inline_keyboard: buttons });
  await attachMessage(ctx.db, id, sent.message_id);
  return null;
}

/** Выбор события из нескольких кандидатов → выбранное событие и для чего оно. */
export async function confirmPick(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  action: PendingAction<PickCardPayload>,
  choice: string,
): Promise<{ event: CalendarEvent; request: EventRequest; purpose: EventPurpose; chatId: number } | null> {
  const { chatId, refs, request } = action.payload;
  const purpose = action.payload.purpose ?? "modify";
  const today = utcToLocal(ctx.clock.now(), user.home_tz).day;
  if (choice === "x") {
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("cancelled", user.locale));
    return null;
  }
  const ref = refs[Number(choice.slice(1))];
  const e = ref ? await provider.getEvent(ref, user.home_tz) : null;
  if (!e) {
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("eventGone", user.locale));
    return null;
  }
  if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, `${t("picked", user.locale)}: ${eventLabel(e, today, user.locale)}`);
  return { event: e, request, purpose, chatId };
}
