// US-61: отмена последнего действия — кнопка «↩ Отменить» под результатом и «отмени последнее».
// Каждое отменяемое действие записывает, как его откатить, в карточку UNDO (15 минут). Отменить можно только
// последнее действие. Если событие изменили после нас (etag), отмена отказывается — не затираем чужую правку.
// Не отменяются (US-61): удаление (новое событие было бы с другим id, участники получили бы приглашения заново)
// и отклонение приглашения.

import { EventConflict, EventGone, type CalendarProvider, type EventRef, type EventReminders } from "../calendar/model";
import type { Moment } from "../dates/calendar";
import {
  attachMessage,
  CONTEXT_TTL_MS,
  claimPendingAction,
  createPendingAction,
  getDialogState,
  mergeDialogState,
  type PendingAction,
} from "../db/conversations";
import { recordFeature } from "../db/features";
import type { User } from "../db/users";
import type { InlineKeyboardButton } from "../telegram/types";
import type { AppContext } from "./context";
import { dateFixOnUndoCreate } from "./date-fix";
import { callbackData } from "./keyboards";
import { t } from "./messages";

export const UNDO_CARD = "undo";

export type UndoRecord =
  | { kind: "create"; ref: EventRef; etag?: string }
  | {
      kind: "update";
      ref: EventRef;
      etag?: string;
      tz: string;
      notify: boolean;
      /** Что вернуть. location / description: "" — убрать. */
      before: { start?: Moment; end?: Moment; title?: string; location?: string; description?: string; reminders?: EventReminders };
    };

interface UndoPayload {
  chatId: number;
  record: UndoRecord;
  /** HTML-описание действия — для сообщения «↩ Отменено». */
  summary: string;
}

/** Запомнить отменяемое действие. Возвращает кнопку «↩ Отменить» для сообщения с результатом. */
export async function recordUndo(
  ctx: AppContext,
  a: { conversationId: string; user: User; chatId: number; record: UndoRecord; summary: string },
): Promise<{ undoId: string; button: InlineKeyboardButton }> {
  const now = ctx.clock.now();
  const undoId = await createPendingAction(ctx.db, {
    conversationId: a.conversationId,
    userId: a.user.id,
    kind: UNDO_CARD,
    payload: { chatId: a.chatId, record: a.record, summary: a.summary } satisfies UndoPayload,
    now,
    ttlMs: CONTEXT_TTL_MS,
  });
  await mergeDialogState(ctx.db, a.conversationId, a.user.id, { lastUndo: { actionId: undoId, at: now } }, now);
  return { undoId, button: { text: t("undoButton", a.user.locale), callback_data: callbackData(undoId, "u") } };
}

/** Привязать карточку отмены к сообщению с кнопкой — чтобы после отмены его отредактировать. */
export const attachUndoMessage = attachMessage;

/** Неотменяемое действие (удаление, отклонение): «отмени последнее» после него не должно откатывать предыдущее. */
export async function markNotUndoable(ctx: AppContext, conversationId: string, user: User, reason: "delete" | "decline"): Promise<void> {
  await mergeDialogState(ctx.db, conversationId, user.id, { lastUndo: { at: ctx.clock.now(), notUndoable: reason } }, ctx.clock.now());
}

/** Выполнить отмену по карточке (кнопка или команда). Карточка уже «забрана». */
export async function performUndo(ctx: AppContext, provider: CalendarProvider, user: User, action: PendingAction<UndoPayload>): Promise<boolean> {
  const { chatId, record, summary } = action.payload;
  const locale = user.locale;
  const reply = async (text: string) => {
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, text, undefined, { html: true });
    else await ctx.telegram.sendMessage(chatId, text, undefined, { html: true });
  };

  const state = await getDialogState(ctx.db, action.conversationId, user.id);
  if (state.lastUndo?.actionId !== action.id) {
    await ctx.telegram.sendMessage(chatId, t("undoOnlyLast", locale));
    return false;
  }

  try {
    if (record.kind === "create") {
      await provider.deleteEvent(record.ref, { notify: false, ...(record.etag ? { etag: record.etag } : {}) });
    } else {
      await provider.updateEvent(record.ref, { tz: record.tz, ...record.before }, { notify: record.notify, ...(record.etag ? { etag: record.etag } : {}) });
    }
  } catch (e) {
    if (e instanceof EventConflict) {
      await ctx.telegram.sendMessage(chatId, t("undoChangedAfter", locale));
      return false;
    }
    if (e instanceof EventGone) {
      await ctx.telegram.sendMessage(chatId, t("eventGone", locale));
      return false;
    }
    throw e;
  }
  await mergeDialogState(ctx.db, action.conversationId, user.id, { lastUndo: undefined, lastEvent: undefined }, ctx.clock.now());
  // Созданное откатили — пересоздание на другую дату будет правкой (метрика date_fix, tech-debt #26)
  if (record.kind === "create") await dateFixOnUndoCreate(ctx, action, record.ref);
  await reply(`${t("undone", locale)}\n\n${summary}`);
  await recordFeature(ctx.db, user.id, "undo", ctx.clock.now());
  return true;
}

/** «Отмени последнее» текстом. */
export async function undoLast(ctx: AppContext, provider: CalendarProvider, user: User, conversationId: string, chatId: number): Promise<void> {
  const locale = user.locale;
  const state = await getDialogState(ctx.db, conversationId, user.id);
  const last = state.lastUndo;
  if (!last || ctx.clock.now() - last.at > CONTEXT_TTL_MS) {
    await ctx.telegram.sendMessage(chatId, t("nothingToUndo", locale));
    return;
  }
  if (!last.actionId) {
    await ctx.telegram.sendMessage(chatId, t(last.notUndoable === "decline" ? "undoDeclineImpossible" : "undoDeleteImpossible", locale));
    return;
  }
  const claim = await claimPendingAction<UndoPayload>(ctx.db, last.actionId, user.id, ctx.clock.now());
  if (!claim.ok) {
    await ctx.telegram.sendMessage(chatId, t(claim.reason === "done" ? "alreadyUndone" : "nothingToUndo", locale));
    return;
  }
  await performUndo(ctx, provider, user, claim.action);
}
