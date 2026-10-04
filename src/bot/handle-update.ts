// Обработка одного апдейта: доступ, регистрация, привязка календаря (US-01, US-02).

import { hasGoogleAccount } from "../db/accounts";
import { ensureTelegramUser } from "../db/users";
import type { TgUpdate } from "../telegram/types";
import type { AppContext } from "./context";
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

  const { user } = await ensureTelegramUser(ctx.db, from.id, from.language_code, ctx.clock.now());
  if (!message) return;
  const isStart = message.text?.trim() === "/start";

  // Без привязанного календаря интент не распознаём — только предлагаем подключить (US-01)
  if (!(await hasGoogleAccount(ctx.db, user.id))) {
    const text = isStart ? `${t("welcome", user.locale)}\n\n${t("connectPrompt", user.locale)}` : t("connectPrompt", user.locale);
    await ctx.telegram.sendMessage(message.chat.id, text, await connectKeyboard(ctx, user.id, user.locale));
    return;
  }

  if (isStart) {
    await ctx.telegram.sendMessage(message.chat.id, t("welcome", user.locale));
    return;
  }
  await ctx.telegram.sendMessage(message.chat.id, t("notImplemented", user.locale));
}
