// US-40 / US-41 / US-43: перенос и изменение события.
// Поиск события по описанию → расчёт изменений (детерминированно, по фрагментам из текста) →
// карточка «Было → Стало» → подтверждение. Повторяющиеся — «только эту / все».

import { EventConflict, EventGone, type CalendarEvent, type CalendarInfo, type CalendarProvider, type EventRef } from "../calendar/model";
import { parseDateFragment } from "../dates";
import { addMinutes, formatMoment, minutesBetween, parseLocal, utcToLocal, type Moment } from "../dates/calendar";
import { durationToMinutes } from "../dates/duration";
import { fragmentParts } from "../dates/point";
import { tokenize } from "../dates/tokenize";
import { attachMessage, createPendingAction, mergeDialogState, type PendingAction } from "../db/conversations";
import type { User } from "../db/users";
import type { InlineKeyboardButton } from "../telegram/types";
import type { AppContext } from "./context";
import { locateEvent, type EventRequest } from "./find-event";
import { escapeHtml, spanLabel } from "./format";
import { callbackData } from "./keyboards";
import { attachUndoMessage, recordUndo, type UndoRecord } from "./undo";
import { t } from "./messages";

export const MODIFY_CARD = "modify";
export type ModifyRequest = EventRequest;

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
  oldLocation?: string;
  oldStart: Moment;
  oldEnd: Moment;
  notify: boolean;
  options: Change[];
  /** Кнопки «только эту / все» вместо «подтвердить». */
  askScope: boolean;
}

const plus = addMinutes;
const diff = minutesBetween;

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
  const e = await locateEvent(ctx, provider, { ...a, purpose: "modify" });
  if (e) await proposeChange(ctx, provider, a.user, a.chatId, a.conversationId, e, a.request);
}

export async function proposeChange(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  chatId: number,
  conversationId: string,
  e: CalendarEvent,
  req: ModifyRequest,
): Promise<void> {
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
    chatId,
    tz,
    ref: e.ref,
    title: e.title,
    ...(e.location ? { oldLocation: e.location } : {}),
    oldStart: e.start ?? { day: e.startDay, minutes: 0 },
    oldEnd: e.end ?? { day: e.endDay, minutes: 0 },
    notify: e.hasOtherAttendees,
    options: res.options,
    askScope: askScope && sameDay,
    ...(e.seriesId ? { seriesId: e.seriesId } : {}),
    ...(e.etag ? { etag: e.etag } : {}),
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
    lines.push(
      `${t("was", locale)}: ${spanLabel(payload.oldStart, payload.oldEnd, today, locale)}`,
      `${t("now", locale)}: ${spanLabel(o.start, o.end!, today, locale)}`,
    );
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
      [
        { text: t("onlyThis", locale), callback_data: callbackData(id, "c0") },
        { text: t("wholeSeries", locale), callback_data: callbackData(id, "all") },
      ],
      [{ text: t("cancelButton", locale), callback_data: callbackData(id, "x") }],
    ];
  } else {
    buttons = [
      [
        { text: t("confirmButton", locale), callback_data: callbackData(id, req.scope === "all" ? "all" : "c0") },
        { text: t("cancelButton", locale), callback_data: callbackData(id, "x") },
      ],
    ];
  }
  const sent = await ctx.telegram.sendMessage(chatId, lines.join("\n"), { inline_keyboard: buttons }, { html: true });
  await attachMessage(ctx.db, id, sent.message_id);
}

/** Подтверждение изменения. Карточка уже «забрана» атомарно. */
export async function confirmModify(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  action: PendingAction<ModifyCardPayload>,
  choice: string,
): Promise<void> {
  const p = action.payload;
  const locale = user.locale;
  const today = utcToLocal(ctx.clock.now(), user.home_tz).day;
  const edit = (text: string) =>
    action.messageId ? ctx.telegram.editMessageText(p.chatId, action.messageId, text, undefined, { html: true }) : Promise.resolve();

  if (choice === "x") {
    await edit(t("cancelled", locale));
    return;
  }
  const wholeSeries = choice === "all";
  const o = p.options[wholeSeries ? 0 : Number(choice.slice(1))];
  if (!o) return;

  // Что вернуть при отмене (US-61): только изменённые поля
  const beforeOf = (cur: { start?: Moment; end?: Moment; title: string; location?: string }) => ({
    ...(o.start ? { start: cur.start!, end: cur.end! } : {}),
    ...(o.title !== undefined ? { title: cur.title } : {}),
    ...(o.location !== undefined ? { location: cur.location ?? "" } : {}),
  });
  let undoRecord: UndoRecord;
  try {
    if (wholeSeries && p.seriesId) {
      // Серия: тот же сдвиг и длительность применяются к мастер-событию (только в пределах дня)
      const masterRef = { ...p.ref, providerEventId: p.seriesId };
      const master = await provider.getEvent(masterRef, p.tz);
      if (!master || master.allDay) throw new EventGone("series not found");
      const delta = o.start ? diff(o.start, p.oldStart) : 0;
      const length = o.start ? diff(o.end!, o.start) : diff(master.end!, master.start!);
      const ms = plus(master.start!, delta);
      const res = await provider.updateEvent(masterRef, { tz: p.tz, ...o, start: ms, end: plus(ms, length) }, { notify: p.notify });
      undoRecord = {
        kind: "update",
        ref: masterRef,
        tz: p.tz,
        notify: p.notify,
        before: { start: master.start!, end: master.end!, ...beforeOf(master) },
        ...(res.etag ? { etag: res.etag } : {}),
      };
    } else {
      const res = await provider.updateEvent(p.ref, { tz: p.tz, ...o }, { notify: p.notify, ...(p.etag ? { etag: p.etag } : {}) });
      undoRecord = {
        kind: "update",
        ref: p.ref,
        tz: p.tz,
        notify: p.notify,
        before: beforeOf({ start: p.oldStart, end: p.oldEnd, title: p.title, ...(p.oldLocation ? { location: p.oldLocation } : {}) }),
        ...(res.etag ? { etag: res.etag } : {}),
      };
    }
  } catch (e) {
    if (e instanceof EventConflict) {
      await edit(t("eventChangedMeanwhile", locale));
      return;
    }
    if (e instanceof EventGone) {
      await edit(t("eventGone", locale));
      return;
    }
    throw e;
  }

  const details = [`<b>${escapeHtml(o.title ?? p.title)}</b>`];
  if (o.start) details.push(`🕒 ${spanLabel(o.start, o.end!, today, locale)}`);
  if (wholeSeries) details.push(t("wholeSeriesChanged", locale));
  const undo = await recordUndo(ctx, { conversationId: action.conversationId, user, chatId: p.chatId, record: undoRecord, summary: details.join("\n") });
  if (action.messageId) {
    await ctx.telegram.editMessageText(
      p.chatId,
      action.messageId,
      `${t("modified", locale)}\n\n${details.join("\n")}`,
      { inline_keyboard: [[undo.button]] },
      { html: true },
    );
    await attachUndoMessage(ctx.db, undo.undoId, Number(action.messageId));
  }
  await mergeDialogState(ctx.db, action.conversationId, user.id, { lastEvent: { ref: p.ref, at: ctx.clock.now() } }, ctx.clock.now());
}
