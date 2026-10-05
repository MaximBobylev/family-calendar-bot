// Ранний фильтр апдейтов в webhook — до записи в D1 и очереди (ревью безопасности/надёжности 2026-10-05):
// посторонние и группы не тратят квоты D1/Queues/AI. Правило доступа — то же, что в US-01 / ADR-0001.

import type { TgUpdate } from "../telegram/types";
import type { AppContext } from "./context";
import { t } from "./messages";

export type Gate = "process" | "ignore" | "not_allowed" | "group";

export function gateUpdate(ctx: AppContext, update: TgUpdate): Gate {
  const message = update.message;
  const from = message?.from ?? update.callback_query?.from;
  if (!from || from.is_bot || (!message && !update.callback_query)) return "ignore";
  if (message && message.chat.type !== "private") return "group";
  if (!ctx.config.allowedTelegramIds.has(String(from.id))) return "not_allowed";
  return "process";
}

/** Вежливый ответ посторонним и в группах — без хранения апдейта. */
export async function replyToOutsider(ctx: AppContext, update: TgUpdate, gate: Gate): Promise<void> {
  const message = update.message;
  if (!message) {
    if (update.callback_query) await ctx.telegram.answerCallbackQuery(update.callback_query.id);
    return;
  }
  const lang = message.from?.language_code ?? "ru";
  try {
    if (gate === "group") await ctx.telegram.sendMessage(message.chat.id, t("privateOnly", lang));
    else if (gate === "not_allowed") await ctx.telegram.sendMessage(message.chat.id, t("notAllowed", lang));
  } catch (e) {
    console.warn("outsider reply failed", e instanceof Error ? e.message : e);
  }
}
