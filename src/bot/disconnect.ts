// Отзыв доступа в Google не удался — данные всё равно удаляем и честно говорим, что доступ нужно убрать вручную.

import { googleCredentials, linkedElsewhere } from "../db/accounts";
import { attachMessage, createPendingAction, ensureConversation, type PendingAction } from "../db/conversations";
import { membersOf, membershipOf } from "../db/households";
import { deleteUserData, type User } from "../db/users";
import { dropOrphanSyncs, stopUserChannels } from "../sync/engine";
import { revokeStoredToken } from "../google/oauth";
import type { AppContext } from "./context";
import { releaseMemberAssignments } from "./assign/answers";
import { notifyOwner } from "./household/commands";
import { dissolveWithNotice } from "./household/menu";
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
  const membership = await membershipOf(ctx.db, user.id);
  const others = membership?.role === "owner" ? (await membersOf(ctx.db, membership.household.id)).filter((m) => m.userId !== user.id) : [];
  const dissolveNote =
    membership?.role === "owner"
      ? `\n\n${t("disconnectDissolves", user.locale, { name: membership.household.name, members: others.map((m) => m.displayName).join(", ") || "—" })}`
      : "";
  const sent = await ctx.telegram.sendMessage(chatId, `${t("disconnectConfirm", user.locale)}${dissolveNote}`, {
    inline_keyboard: [
      [
        { text: t("disconnectButton", user.locale), callback_data: callbackData(id, "ok") },
        { text: t("cancelButton", user.locale), callback_data: callbackData(id, "x") },
      ],
    ],
  });
  await attachMessage(ctx.db, id, sent.message_id);
}

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
  // Каналы push, открытые его токеном, может остановить только он — до отзыва токена (ADR-0005 §2)
  await stopUserChannels(ctx, user.id).catch((e) => console.warn("stop channels failed", e instanceof Error ? e.message : e));
  const creds = await googleCredentials(ctx.db, user.id);
  let result: MessageKey = "disconnectDoneNoAccount";
  if (creds) {
    if (await linkedElsewhere(ctx.db, creds.emailHash, user.id)) result = "disconnectRevokeShared";
    else result = (await revokeStoredToken(ctx.config, creds)) ? "disconnectDone" : "disconnectRevokeFailed";
  }
  // Решение владельца: общие календари дома шли через Google владельца — без него дом распускается
  const membership = await membershipOf(ctx.db, user.id);
  if (membership?.role === "owner") await dissolveWithNotice(ctx, membership.household, user.id, user.locale);
  else if (membership) {
    await releaseMemberAssignments(ctx, membership.household.id, user.id);
    await notifyOwner(ctx, membership.household, "homeMemberLeft", membership.displayName);
  }
  await deleteUserData(ctx.db, user.id, telegramId);
  await dropOrphanSyncs(ctx.db);
  await reply(result);
}
