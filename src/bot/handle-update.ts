// Обработка одного апдейта. Пока — только доступ, регистрация и приветствие (US-01).

import { ensureTelegramUser } from "../db/users";
import type { TgUpdate } from "../telegram/types";
import type { AppContext } from "./context";
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

  if (message?.text?.trim() === "/start") {
    await ctx.telegram.sendMessage(message.chat.id, t("welcome", user.locale));
    return;
  }
  if (message) await ctx.telegram.sendMessage(message.chat.id, t("notImplemented", user.locale));
}
