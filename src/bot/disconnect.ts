// US-03: /disconnect — подтверждение карточкой, отзыв доступа в Google, удаление всех данных пользователя.
// После этого человек — как новый: /start предложит подключить календарь.
// Отзыв не удался — данные всё равно удаляем и честно говорим, что доступ нужно убрать вручную.

import { googleCredentials, linkedElsewhere } from "../db/accounts";
import { attachMessage, createPendingAction, ensureConversation, type PendingAction } from "../db/conversations";
import { deleteUserData, type User } from "../db/users";
import { revokeStoredToken } from "../google/oauth";
import type { AppContext } from "./context";
import { callbackData } from "./keyboards";
import { t, type MessageKey } from "./messages";

export const DISCONNECT_CARD = "disconnect";

interface DisconnectPayload {
  chatId: number;
}

export const isDisconnectCommand = (text: string | undefined) => /^\/(disconnect|forget)(@\w+)?$/i.test(text?.trim() ?? "");

export async function proposeDisconnect(ctx: AppContext, user: User, chatId: number): Promise<void> {
  const conversationId = await ensureConversation(ctx.db, chatId, "private");
  const id = await createPendingAction(ctx.db, {
    conversationId,
    userId: user.id,
    kind: DISCONNECT_CARD,
    payload: { chatId } satisfies DisconnectPayload,
    now: ctx.clock.now(),
  });
  const sent = await ctx.telegram.sendMessage(chatId, t("disconnectConfirm", user.locale), {
    inline_keyboard: [
      [
        { text: t("disconnectButton", user.locale), callback_data: callbackData(id, "ok") },
        { text: t("cancelButton", user.locale), callback_data: callbackData(id, "x") },
      ],
    ],
  });
  await attachMessage(ctx.db, id, sent.message_id);
}

/** Нажатие на карточке. Карточка уже «забрана» атомарно. */
export async function confirmDisconnect(
  ctx: AppContext,
  user: User,
  telegramId: number,
  action: PendingAction<DisconnectPayload>,
  choice: string,
): Promise<void> {
  const { chatId } = action.payload;
  const reply = (key: MessageKey) =>
    action.messageId ? ctx.telegram.editMessageText(chatId, action.messageId, t(key, user.locale)) : ctx.telegram.sendMessage(chatId, t(key, user.locale));
  if (choice !== "ok") {
    await reply("cancelled");
    return;
  }
  const creds = await googleCredentials(ctx.db, user.id);
  let result: MessageKey = "disconnectDoneNoAccount";
  if (creds) {
    if (await linkedElsewhere(ctx.db, creds.emailHash, user.id)) result = "disconnectRevokeShared";
    else result = (await revokeStoredToken(ctx.config, creds.credentialsEnc)) ? "disconnectDone" : "disconnectRevokeFailed";
  }
  await deleteUserData(ctx.db, user.id, telegramId);
  await reply(result);
}
