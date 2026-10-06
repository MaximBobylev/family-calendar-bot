// Вход обработки одного апдейта: правки и чужие боты — мимо, группы и доступ (US-01), регистрация, /disconnect
// (US-03), без календаря — только «Подключить», дальше — сообщение (input/message.ts) или нажатие (callbacks.ts).

import { hasGoogleAccount } from "../db/accounts";
import { ensureTelegramUser, type User } from "../db/users";
import type { TgUpdate } from "../telegram/types";
import { handleCallback } from "./callbacks";
import type { AppContext } from "./context";
import { isDisconnectCommand, proposeDisconnect } from "./disconnect";
import { telegramName } from "./format";
import { handleCommand } from "./input/message";
import { connectKeyboard } from "./keyboards";
import { t } from "./messages";

export async function handleUpdate(ctx: AppContext, update: TgUpdate): Promise<void> {
  // Отредактированные сообщения игнорируем (US-10)
  if (update.edited_message) return;

  const message = update.message;
  const from = message?.from ?? update.callback_query?.from;
  if (!from || from.is_bot) return;
  const lang = from.language_code ?? "ru";

  if (message && message.chat.type !== "private") {
    await ctx.telegram.sendMessage(message.chat.id, t("privateOnly", lang));
    return;
  }

  // Доступ проверяется до любой обработки (US-01, ADR-0001)
  if (!ctx.config.allowedTelegramIds.has(String(from.id))) {
    if (message) await ctx.telegram.sendMessage(message.chat.id, t("notAllowed", lang));
    return;
  }

  const user: User = { ...(await ensureTelegramUser(ctx.db, from.id, ctx.clock.now())).user, tgName: telegramName(from) };
  if (update.callback_query) {
    await handleCallback(ctx, user, update.callback_query);
    return;
  }
  if (!message) return;
  const isStart = message.text?.trim() === "/start";

  // Удалить свои данные можно всегда, даже без подключённого календаря (US-03)
  if (isDisconnectCommand(message.text)) {
    await proposeDisconnect(ctx, user, message.chat.id);
    return;
  }

  // Без привязанного календаря интент не распознаём — только предлагаем подключить (US-01)
  if (!(await hasGoogleAccount(ctx.db, user.id))) {
    const text = isStart ? `${t("welcome", user.locale)}\n\n${t("connectPrompt", user.locale)}` : t("connectPrompt", user.locale);
    await ctx.telegram.sendMessage(message.chat.id, text, await connectKeyboard(ctx, user.id, user.locale, user.tgName));
    return;
  }

  if (isStart) {
    await ctx.telegram.sendMessage(message.chat.id, t("welcome", user.locale));
    return;
  }
  await handleCommand(ctx, user, message);
}
