// US-40 / US-41 / US-43: перенос и изменение события — сценарий (I/O).
// Поиск события → расчёт изменений (modify-logic.ts) → карточка «Было → Стало» (modify-view.ts) → подтверждение.
// Повторяющиеся — «только эту / все».

import { findCalendarByName } from "../calendar/match";
import { EventConflict, EventGone, type CalendarEvent, type CalendarInfo, type CalendarProvider, type EventReminders } from "../calendar/model";
import { addMinutes, minutesBetween, utcToLocal, type Moment } from "../dates/calendar";
import { attachMessage, createPendingAction, mergeDialogState, type PendingAction } from "../db/conversations";
import { recordFeature } from "../db/features";
import type { User } from "../db/users";
import { shiftAssignmentsForEvent } from "./assign/answers";
import type { AppContext } from "./context";
import { dateFixOnModified } from "./date-fix";
import { locateEvent } from "./find-event";
import { escapeHtml } from "./format";
import { attachUndoMessage, recordUndo, type UndoRecord } from "./undo";
import { t } from "./messages";
import { computeChange, DEFAULT_REMINDERS, type ModifyCardPayload, type ModifyRequest } from "./modify-logic";
import { modifiedDetails, modifyCard } from "./modify-view";

export const MODIFY_CARD = "modify";

const plus = addMinutes;
const diff = minutesBetween;

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

  // «Встреча будет в семейном календаре» — это перенос в другой календарь, а не место (R2)
  if (req.newLocation && (/календар|calendar/i.test(req.newLocation) || findCalendarByName(calendars, req.newLocation))) {
    await ctx.telegram.sendMessage(chatId, t("moveToCalendarUnsupported", locale));
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
    ...(e.description ? { oldDescription: e.description } : {}),
    oldReminders: e.reminders ?? DEFAULT_REMINDERS,
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
  const { text, buttons } = modifyCard(e, res.options, payload, req.scope, id, today, locale);
  const sent = await ctx.telegram.sendMessage(chatId, text, { inline_keyboard: buttons }, { html: true });
  await attachMessage(ctx.db, id, sent.message_id);
}

/** Подтверждение изменения. Карточка уже «забрана» атомарно. */
export async function confirmModify(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  action: PendingAction<ModifyCardPayload>,
  choice: string,
): Promise<boolean> {
  const p = action.payload;
  const locale = user.locale;
  const today = utcToLocal(ctx.clock.now(), user.home_tz).day;
  const edit = (text: string) =>
    action.messageId ? ctx.telegram.editMessageText(p.chatId, action.messageId, text, undefined, { html: true }) : Promise.resolve();

  if (choice === "x") {
    await edit(t("cancelled", locale));
    return false;
  }
  const wholeSeries = choice === "all";
  const o = p.options[wholeSeries ? 0 : Number(choice.slice(1))];
  if (!o) return false;

  // Что вернуть при отмене (US-61): только изменённые поля
  const beforeOf = (cur: { start?: Moment; end?: Moment; title: string; location?: string; description?: string; reminders?: EventReminders }) => ({
    ...(o.start ? { start: cur.start!, end: cur.end! } : {}),
    ...(o.title !== undefined ? { title: cur.title } : {}),
    ...(o.location !== undefined ? { location: cur.location ?? "" } : {}),
    ...(o.description !== undefined ? { description: cur.description ?? "" } : {}),
    ...(o.reminders !== undefined ? { reminders: cur.reminders ?? DEFAULT_REMINDERS } : {}),
  });
  let undoRecord: UndoRecord;
  try {
    if (wholeSeries && p.seriesId) {
      // Серия: тот же сдвиг и длительность применяются к мастер-событию (только в пределах дня)
      const masterRef = { ...p.ref, providerEventId: p.seriesId };
      const master = await provider.getEvent(masterRef, p.tz);
      // Время серии меняем только у событий со временем; детали (место, напоминания) — у любых
      if (!master || (o.start && master.allDay)) throw new EventGone("series not found");
      let patch = { tz: p.tz, ...o };
      if (o.start) {
        const length = diff(o.end!, o.start);
        const ms = plus(master.start!, diff(o.start, p.oldStart));
        patch = { ...patch, start: ms, end: plus(ms, length) };
      }
      const res = await provider.updateEvent(masterRef, patch, { notify: p.notify });
      undoRecord = {
        kind: "update",
        ref: masterRef,
        tz: p.tz,
        notify: p.notify,
        before: beforeOf(master),
        ...(res.etag ? { etag: res.etag } : {}),
      };
    } else {
      const res = await provider.updateEvent(p.ref, { tz: p.tz, ...o }, { notify: p.notify, ...(p.etag ? { etag: p.etag } : {}) });
      undoRecord = {
        kind: "update",
        ref: p.ref,
        tz: p.tz,
        notify: p.notify,
        before: beforeOf({
          start: p.oldStart,
          end: p.oldEnd,
          title: p.title,
          ...(p.oldLocation ? { location: p.oldLocation } : {}),
          ...(p.oldDescription ? { description: p.oldDescription } : {}),
          ...(p.oldReminders ? { reminders: p.oldReminders } : {}),
        }),
        ...(res.etag ? { etag: res.etag } : {}),
      };
    }
  } catch (e) {
    if (e instanceof EventConflict) {
      await edit(t("eventChangedMeanwhile", locale));
      return false;
    }
    if (e instanceof EventGone) {
      await edit(t("eventGone", locale));
      return false;
    }
    throw e;
  }

  // Поручения, связанные с событием, сдвигаются вместе с ним (US-91); серия целиком — пока нет (экземпляры)
  if (o.start && !wholeSeries) await shiftAssignmentsForEvent(ctx, p.ref, minutesBetween(o.start, p.oldStart) * 60_000, action.userId);
  const details = modifiedDetails(o, p, wholeSeries, today, locale);
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
  // «нет, в 16» сразу после создания — правка даты карточки (метрика date_fix, tech-debt #26)
  await dateFixOnModified(ctx, action, p.ref, !!o.start);
  await recordFeature(ctx.db, user.id, "modify", ctx.clock.now());
  return true;
}
