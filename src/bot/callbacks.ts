// Карточка сначала атомарно захватывается (повторное нажатие ничего не делает), потом — обработчик по kind.
// Статусы карточки: open → executing → done | failed (src/db/card-status.ts).

import type { CalendarProvider } from "../calendar/model";
import { claimCard, ensureConversation, finishCard, mergeDialogState, type PendingAction } from "../db/conversations";
import type { User } from "../db/users";
import type { TgCallbackQuery } from "../telegram/types";
import { ASSIGN_CARD, ASSIGN_WHO_CARD, type AssignCardPayload, type AssignWhoPayload, confirmAssign, confirmWho } from "./assign/start";
import type { AppContext } from "./context";
import { CREATE_CARD, confirmCreate, type CreateCardPayload } from "./create-event";
import { DELETE_CARD, confirmDelete, proposeDelete } from "./delete-event";
import { runCommand } from "./dialog";
import { confirmTimezone, TZ_CARDS } from "./timezone";
import { DISCONNECT_CARD, confirmDisconnect } from "./disconnect";
import { PICK_CARD, confirmPick } from "./find-event";
import { FORWARD_CARD, confirmForwarded, type ForwardCardPayload } from "./forwarded";
import { ICS_CARD, confirmIcs, type IcsCardPayload } from "./ingest";
import { parseCallbackData } from "./keyboards";
import { t } from "./messages";
import { MODIFY_CARD, confirmModify, proposeChange } from "./modify-event";
import { handleSettingsCallback, parseSettingsCallback } from "./settings/callbacks";
import { UNDO_CARD, performUndo } from "./undo";
import { withCalendar } from "./with-calendar";
import { withTyping } from "./with-typing";

// true — действие выполнено; false — отмена кнопкой, «уже удалено» или карточка лишь открыла следующую (выбор события).
type CalendarCardHandler = (ctx: AppContext, provider: CalendarProvider, user: User, action: PendingAction, choice: string) => Promise<boolean>;

const CALENDAR_CARDS = new Map<string, CalendarCardHandler>([
  [CREATE_CARD, (ctx, provider, user, action, choice) => confirmCreate(ctx, provider, user, action as PendingAction<CreateCardPayload>, choice)],
  [MODIFY_CARD, (ctx, provider, user, action, choice) => confirmModify(ctx, provider, user, action as Parameters<typeof confirmModify>[3], choice)],
  [UNDO_CARD, (ctx, provider, user, action) => performUndo(ctx, provider, user, action as Parameters<typeof performUndo>[3])],
  [DELETE_CARD, (ctx, provider, user, action, choice) => confirmDelete(ctx, provider, user, action as Parameters<typeof confirmDelete>[3], choice)],
  [ICS_CARD, (ctx, provider, user, action, choice) => confirmIcs(ctx, provider, user, action as PendingAction<IcsCardPayload>, choice)],
  [
    PICK_CARD,
    async (ctx, provider, user, action, choice) => {
      const picked = await confirmPick(ctx, provider, user, action as Parameters<typeof confirmPick>[3], choice);
      if (picked?.purpose === "modify") await proposeChange(ctx, provider, user, picked.chatId, action.conversationId, picked.event, picked.request);
      if (picked?.purpose === "delete") await proposeDelete(ctx, provider, user, picked.chatId, action.conversationId, picked.event, picked.request);
      return false;
    },
  ],
]);

/**
 * Повтор после умершего обработчика безопасен: create — свой id события (повтор → 409 → успех), modify/delete/undo —
 * etag (уже применённое — «изменили»/«уже удалена», без второго действия), pick — лишь снова показывает карточку.
 * forward и disconnect не повторяем: честное «не завершилось, повторите команду».
 */
const RETRYABLE = new Set([CREATE_CARD, MODIFY_CARD, DELETE_CARD, UNDO_CARD, PICK_CARD, ICS_CARD]);

const BUSY_ANSWER = {
  inProgress: "cardInProgress",
  notCompleted: "actionNotCompleted",
  abandoned: "actionNotCompleted",
  done: "alreadyDone",
  stale: "cardExpired",
} as const;

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
  const claim = await claimCard(ctx.db, parsed.actionId, user.id, ctx.clock.now(), (kind) => RETRYABLE.has(kind));
  if (!claim.ok) {
    const key = BUSY_ANSWER[claim.verdict];
    await ctx.telegram.answerCallbackQuery(cq.id, t(key, user.locale));
    // failed уже показывает «Не получилось», а «выполняю» и «уже сделано» — только всплывающим ответом
    if ((claim.verdict === "stale" || claim.verdict === "abandoned") && cq.message) {
      await ctx.telegram.editMessageText(cq.message.chat.id, cq.message.message_id, t(key, user.locale)).catch(() => undefined);
    }
    return;
  }
  if (claim.retry) console.warn("card retry after abandoned execution", claim.action.kind, claim.action.id);
  await ctx.telegram.answerCallbackQuery(cq.id);
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const action = claim.action;
  if (action.kind === FORWARD_CARD) {
    const text = await confirmForwarded(ctx, user, action as PendingAction<ForwardCardPayload>, parsed.choice);
    // done до команды: у неё свои карточки и свой исход
    await finishCard(ctx.db, action.id, "done");
    if (text) await withTyping(ctx, chatId, () => runCommand(ctx, user, chatId, action.conversationId, text));
    return;
  }
  if (action.kind === ASSIGN_WHO_CARD) {
    await finishCard(ctx.db, action.id, "done");
    await confirmWho(ctx, user, action as PendingAction<AssignWhoPayload>, parsed.choice);
    return;
  }
  if (action.kind === ASSIGN_CARD) {
    // Не через withCalendar: календарь нужен только для «+ в календарь», его ошибки обработаны внутри
    try {
      await confirmAssign(ctx, user, action as PendingAction<AssignCardPayload>, parsed.choice);
      await finishCard(ctx.db, action.id, "done");
    } catch (e) {
      console.error("assign failed", e instanceof Error ? e.message : e);
      await finishCard(ctx.db, action.id, "failed");
      if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("actionFailed", user.locale)).catch(() => undefined);
    }
    return;
  }
  if (TZ_CARDS.has(action.kind)) {
    await finishCard(ctx.db, action.id, "done");
    await confirmTimezone(ctx, user, action, parsed.choice);
    return;
  }
  if (action.kind === DISCONNECT_CARD) {
    try {
      await confirmDisconnect(ctx, user, cq.from.id, action as Parameters<typeof confirmDisconnect>[3], parsed.choice);
      await finishCard(ctx.db, action.id, "done");
    } catch (e) {
      console.error("disconnect failed", e instanceof Error ? e.message : e);
      await finishCard(ctx.db, action.id, "failed");
      if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("actionFailed", user.locale)).catch(() => undefined);
    }
    return;
  }
  // Общие календари дома убрали, пока карточка была открыта (QA-12)
  if (ctx.calendarScope && ctx.calendarScope.calendarIds.length === 0) {
    await finishCard(ctx.db, action.id, "failed");
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("homeNoSharedCalendars", user.locale));
    return;
  }
  let completed = false;
  const ok = await withCalendar(ctx, user, chatId, async (provider) => {
    completed = (await CALENDAR_CARDS.get(action.kind)?.(ctx, provider, user, action, parsed.choice)) ?? false;
  });
  // failed, а не done: повторное нажатие должно получить «не выполнено», а не «Уже сделано»
  await finishCard(ctx.db, action.id, ok ? "done" : "failed");
  if (!ok && action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("actionFailed", user.locale));
  // Повтор выполненного голосового — уже не сигнал «не понял»; выбор события (completed = false) ещё может быть ошибкой
  if (ok && completed) await mergeDialogState(ctx.db, action.conversationId, user.id, { lastVoice: undefined }, ctx.clock.now());
}
