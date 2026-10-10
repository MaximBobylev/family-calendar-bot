// Фильтр до записи в D1 и очередь: посторонние не тратят квоты D1/Queues/AI.

import { isMemberByTelegramId } from "../db/households";
import type { TgMessage, TgUpdate } from "../telegram/types";
import type { AppContext } from "./context";
import { isAddressedToBot, parseHomeStart } from "./household/logic";
import { answerGuestPress, replyGuestStart } from "./inline/guest";
import { t } from "./messages";

export type Gate = "process" | "ignore" | "not_allowed";

// `/start home_<код>` пропускаем: код проверит обработчик, до проверки посторонний не регистрируется
export async function hasAccess(ctx: AppContext, telegramId: number, message?: TgMessage): Promise<boolean> {
  if (ctx.config.allowedTelegramIds.has(String(telegramId))) return true;
  if (message?.chat.type === "private" && parseHomeStart(message.text)) return true;
  return isMemberByTelegramId(ctx.db, telegramId);
}

export async function gateUpdate(ctx: AppContext, update: TgUpdate): Promise<Gate> {
  // Бота добавил в группу посторонний — молчим, без «нет доступа»
  if (update.my_chat_member) {
    const m = update.my_chat_member;
    if (m.from.is_bot || m.chat.type === "private" || m.chat.type === "channel") return "ignore";
    return (await hasAccess(ctx, m.from.id)) ? "process" : "ignore";
  }
  const message = update.message;
  const from = message?.from ?? update.callback_query?.from;
  if (!from || from.is_bot || (!message && !update.callback_query)) return "ignore";
  if (message?.chat.type === "channel") return "ignore";
  if (message && message.chat.type !== "private" && !isAddressedToBot(message, ctx.config.telegramBotUsername)) return "ignore";
  if (!(await hasAccess(ctx, from.id, message))) return "not_allowed";
  return "process";
}

export async function replyToOutsider(ctx: AppContext, update: TgUpdate, gate: Gate): Promise<void> {
  const message = update.message;
  if (!message) {
    // Посторонний может нажать «📅 Добавить себе» под inline-карточкой (US-95)
    if (update.callback_query && !(gate === "not_allowed" && (await answerGuestPress(ctx, update.callback_query)))) {
      await ctx.telegram.answerCallbackQuery(update.callback_query.id);
    }
    return;
  }
  const lang = message.from?.language_code ?? "ru";
  try {
    if (gate === "not_allowed" && (await replyGuestStart(ctx, message))) return;
    if (gate === "not_allowed") await ctx.telegram.sendMessage(message.chat.id, t("notAllowed", lang));
  } catch (e) {
    console.warn("outsider reply failed", e instanceof Error ? e.message : e);
  }
}
