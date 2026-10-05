// US-50: удаление события. Всегда подтверждение (US-05). Свою встречу удаляем (участники получат отмену),
// чужую — не удаляем, а отклоняем приглашение. Повторяющиеся — «только эту / всю серию».

import { EventConflict, EventGone, type CalendarEvent, type CalendarProvider, type EventRef } from "../calendar/model";
import { utcToLocal } from "../dates/calendar";
import { attachMessage, createPendingAction, getDialogState, mergeDialogState, type PendingAction } from "../db/conversations";
import type { User } from "../db/users";
import type { InlineKeyboardButton } from "../telegram/types";
import type { AppContext } from "./context";
import { locateEvent, type EventRequest } from "./find-event";
import { escapeHtml, whenOf } from "./format";
import { callbackData } from "./keyboards";
import { markNotUndoable } from "./undo";
import { t } from "./messages";

export const DELETE_CARD = "delete";

interface DeleteCardPayload {
  chatId: number;
  tz: string;
  ref: EventRef;
  seriesId?: string;
  etag?: string;
  title: string;
  when: string;
  notify: boolean;
  /** Не организатор — отклоняем приглашение, а не удаляем. */
  decline: boolean;
}

export interface DeleteArgs {
  user: User;
  chatId: number;
  conversationId: string;
  request: EventRequest;
}

export async function startDelete(ctx: AppContext, provider: CalendarProvider, a: DeleteArgs): Promise<void> {
  const e = await locateEvent(ctx, provider, { ...a, purpose: "delete" });
  if (e) await proposeDelete(ctx, provider, a.user, a.chatId, a.conversationId, e, a.request);
}

export async function proposeDelete(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  chatId: number,
  conversationId: string,
  e: CalendarEvent,
  req: EventRequest,
): Promise<void> {
  const locale = user.locale;
  const today = utcToLocal(ctx.clock.now(), user.home_tz).day;
  const cal = (await provider.calendars()).find((c) => c.id === e.ref.calendarId);
  if (!cal?.writable) {
    await ctx.telegram.sendMessage(chatId, t("calendarReadOnly", locale, { name: e.calendarTitle }));
    return;
  }

  const decline = !e.organizerIsSelf;
  const payload: DeleteCardPayload = {
    chatId,
    tz: user.home_tz,
    ref: e.ref,
    title: e.title,
    when: whenOf(e, today, locale),
    notify: !decline && e.hasOtherAttendees,
    decline,
    ...(e.seriesId ? { seriesId: e.seriesId } : {}),
    ...(e.etag ? { etag: e.etag } : {}),
  };
  const id = await createPendingAction(ctx.db, { conversationId, userId: user.id, kind: DELETE_CARD, payload, now: ctx.clock.now() });

  const lines = [t(decline ? "declineConfirm" : "deleteConfirm", locale), "", `<b>${escapeHtml(e.title)}</b>`, `🕒 ${payload.when}`];
  if (decline) lines.push("", t("declineExplain", locale));
  if (payload.notify) lines.push("", t("attendeesNotifiedCancel", locale));

  const cancel = { text: t("cancelButton", locale), callback_data: callbackData(id, "x") };
  let buttons: InlineKeyboardButton[][];
  if (decline) {
    buttons = [[{ text: t("declineButton", locale), callback_data: callbackData(id, "decline") }, cancel]];
  } else if (e.recurring && req.scope === undefined) {
    buttons = [
      [
        { text: t("onlyThis", locale), callback_data: callbackData(id, "this") },
        { text: t("wholeSeries", locale), callback_data: callbackData(id, "all") },
      ],
      [cancel],
    ];
  } else {
    buttons = [[{ text: t("deleteButton", locale), callback_data: callbackData(id, req.scope === "all" && e.seriesId ? "all" : "this") }, cancel]];
  }
  const sent = await ctx.telegram.sendMessage(chatId, lines.join("\n"), { inline_keyboard: buttons }, { html: true });
  await attachMessage(ctx.db, id, sent.message_id);
}

/** Подтверждение удаления / отклонения. Карточка уже «забрана» атомарно. */
export async function confirmDelete(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  action: PendingAction<DeleteCardPayload>,
  choice: string,
): Promise<void> {
  const p = action.payload;
  const locale = user.locale;
  const edit = (text: string) =>
    action.messageId ? ctx.telegram.editMessageText(p.chatId, action.messageId, text, undefined, { html: true }) : Promise.resolve();
  const details = `<b>${escapeHtml(p.title)}</b>\n🕒 ${p.when}`;

  if (choice === "x") {
    await edit(t("cancelled", locale));
    return;
  }
  try {
    if (choice === "decline") {
      await provider.declineEvent(p.ref, p.tz);
      await edit(`${t("declined", locale)}\n\n${details}`);
    } else {
      const whole = choice === "all" && p.seriesId;
      const ref = whole ? { ...p.ref, providerEventId: p.seriesId! } : p.ref;
      // etag — только для конкретного экземпляра; у серии он свой
      await provider.deleteEvent(ref, { notify: p.notify, ...(!whole && p.etag ? { etag: p.etag } : {}) });
      await edit(`${t(whole ? "deletedSeries" : "deleted", locale)}\n\n${details}`);
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
  // Удаление и отклонение не отменяются (US-61) — «отмени последнее» не должно откатить предыдущее действие
  await markNotUndoable(ctx, action.conversationId, user, choice === "decline" ? "decline" : "delete");
  // Удалённое событие больше не «её» для следующих команд (US-60)
  const state = await getDialogState(ctx.db, action.conversationId, user.id);
  if (state.lastEvent?.ref.providerEventId === p.ref.providerEventId) {
    await mergeDialogState(ctx.db, action.conversationId, user.id, { lastEvent: undefined }, ctx.clock.now());
  }
}
