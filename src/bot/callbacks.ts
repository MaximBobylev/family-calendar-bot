// Нажатия кнопок: меню настроек (без карточки) и карточки pending_actions — атомарный захват (US-05),
// затем обработчик по kind. Карточки с действием в календаре — таблица CALENDAR_CARDS (шаг к tech-debt #15).

import type { CalendarProvider } from "../calendar/model";
import { claimPendingAction, ensureConversation, mergeDialogState, type PendingAction } from "../db/conversations";
import type { User } from "../db/users";
import type { TgCallbackQuery } from "../telegram/types";
import type { AppContext } from "./context";
import { CREATE_CARD, confirmCreate, type CreateCardPayload } from "./create-event";
import { DELETE_CARD, confirmDelete, proposeDelete } from "./delete-event";
import { runCommand } from "./dialog";
import { DISCONNECT_CARD, confirmDisconnect } from "./disconnect";
import { PICK_CARD, confirmPick } from "./find-event";
import { FORWARD_CARD, confirmForwarded, type ForwardCardPayload } from "./forwarded";
import { parseCallbackData } from "./keyboards";
import { t } from "./messages";
import { MODIFY_CARD, confirmModify, proposeChange } from "./modify-event";
import { handleSettingsCallback, parseSettingsCallback } from "./settings";
import { UNDO_CARD, performUndo } from "./undo";
import { withCalendar } from "./with-calendar";
import { withTyping } from "./with-typing";

/** Подтверждение карточки, которое действует в календаре (ошибки — через withCalendar). */
type CalendarCardHandler = (ctx: AppContext, provider: CalendarProvider, user: User, action: PendingAction, choice: string) => Promise<void>;

/** kind карточки → обработчик. Касты payload — до реестра с проверкой версии (tech-debt #15). */
const CALENDAR_CARDS = new Map<string, CalendarCardHandler>([
  [CREATE_CARD, (ctx, provider, user, action, choice) => confirmCreate(ctx, provider, user, action as PendingAction<CreateCardPayload>, choice)],
  [MODIFY_CARD, (ctx, provider, user, action, choice) => confirmModify(ctx, provider, user, action as Parameters<typeof confirmModify>[3], choice)],
  [UNDO_CARD, (ctx, provider, user, action) => performUndo(ctx, provider, user, action as Parameters<typeof performUndo>[3])],
  [DELETE_CARD, (ctx, provider, user, action, choice) => confirmDelete(ctx, provider, user, action as Parameters<typeof confirmDelete>[3], choice)],
  [
    PICK_CARD,
    async (ctx, provider, user, action, choice) => {
      const picked = await confirmPick(ctx, provider, user, action as Parameters<typeof confirmPick>[3], choice);
      if (picked?.purpose === "modify") await proposeChange(ctx, provider, user, picked.chatId, action.conversationId, picked.event, picked.request);
      if (picked?.purpose === "delete") await proposeDelete(ctx, provider, user, picked.chatId, action.conversationId, picked.event, picked.request);
    },
  ],
]);

/** Нажатие кнопки на карточке: атомарно «забираем» карточку — повторное нажатие ничего не делает (US-05). */
export async function handleCallback(ctx: AppContext, user: User, cq: TgCallbackQuery): Promise<void> {
  const settings = parseSettingsCallback(cq.data);
  if (settings && cq.message) {
    const chatId = cq.message.chat.id;
    const conversationId = await ensureConversation(ctx.db, chatId, "private");
    const toast = await handleSettingsCallback(ctx, user, chatId, cq.message.message_id, settings, conversationId);
    await ctx.telegram.answerCallbackQuery(cq.id, toast);
    return;
  }
  const parsed = parseCallbackData(cq.data);
  if (!parsed) {
    await ctx.telegram.answerCallbackQuery(cq.id);
    return;
  }
  const claim = await claimPendingAction(ctx.db, parsed.actionId, user.id, ctx.clock.now());
  if (!claim.ok) {
    const stale = claim.reason !== "done";
    await ctx.telegram.answerCallbackQuery(cq.id, t(stale ? "cardExpired" : "alreadyDone", user.locale));
    if (stale && cq.message) await ctx.telegram.editMessageText(cq.message.chat.id, cq.message.message_id, t("cardExpired", user.locale));
    return;
  }
  await ctx.telegram.answerCallbackQuery(cq.id);
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const action = claim.action;
  if (action.kind === FORWARD_CARD) {
    const text = await confirmForwarded(ctx, user, action as PendingAction<ForwardCardPayload>, parsed.choice);
    // Выполняем от имени нажавшего — как если бы он сам написал это (US-10)
    if (text) await withTyping(ctx, chatId, () => runCommand(ctx, user, chatId, action.conversationId, text));
    return;
  }
  if (action.kind === DISCONNECT_CARD) {
    try {
      await confirmDisconnect(ctx, user, cq.from.id, action as Parameters<typeof confirmDisconnect>[3], parsed.choice);
    } catch (e) {
      // Карточка уже «done» — не оставлять кнопки на несделанном; повторить можно новой командой
      console.error("disconnect failed", e instanceof Error ? e.message : e);
      if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("actionFailed", user.locale)).catch(() => undefined);
    }
    return;
  }
  const ok = await withCalendar(ctx, user, chatId, async (provider) => {
    await CALENDAR_CARDS.get(action.kind)?.(ctx, provider, user, action, parsed.choice);
  });
  // Карточка уже «done»: при сбое убираем кнопки, чтобы не было «Уже сделано» на несделанном (ревью 2026-10-05)
  if (!ok && action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("actionFailed", user.locale));
  // Действие по голосовому подтверждено — его повтор дальше не сигнал «не понял» (multimodal-voice, D)
  if (ok && parsed.choice !== "x") await mergeDialogState(ctx.db, action.conversationId, user.id, { lastVoice: undefined }, ctx.clock.now());
}
