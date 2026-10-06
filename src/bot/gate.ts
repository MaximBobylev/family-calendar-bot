// Ранний фильтр апдейтов в webhook — до записи в D1 и очереди (ревью безопасности/надёжности 2026-10-05):
// посторонние не тратят квоты D1/Queues/AI. Доступ — allowlist (US-01 / ADR-0001) или членство в доме по приглашению
// (US-90, ADR-0001 дополнение 2026-10-06). В группах — только обращённое к боту (privacy mode, US-94).

import { isMemberByTelegramId } from "../db/households";
import type { TgMessage, TgUpdate } from "../telegram/types";
import type { AppContext } from "./context";
import { isAddressedToBot, parseHomeStart } from "./household/logic";
import { t } from "./messages";

export type Gate = "process" | "ignore" | "not_allowed";

/**
 * Доступ к боту: allowlist; участник дома (приглашённый — без allowlist); `/start home_<код>` в личном чате — код
 * проверит обработчик, до проверки посторонний не регистрируется. Посторонние в allowlist — только чтение D1.
 */
export async function hasAccess(ctx: AppContext, telegramId: number, message?: TgMessage): Promise<boolean> {
  if (ctx.config.allowedTelegramIds.has(String(telegramId))) return true;
  if (message?.chat.type === "private" && parseHomeStart(message.text)) return true;
  return isMemberByTelegramId(ctx.db, telegramId);
}

export async function gateUpdate(ctx: AppContext, update: TgUpdate): Promise<Gate> {
  const message = update.message;
  const from = message?.from ?? update.callback_query?.from;
  if (!from || from.is_bot || (!message && !update.callback_query)) return "ignore";
  if (message?.chat.type === "channel") return "ignore";
  // Группа: только команды, упоминание @бота и ответы боту — остальную переписку не читаем (US-94)
  if (message && message.chat.type !== "private" && !isAddressedToBot(message, ctx.config.telegramBotUsername)) return "ignore";
  if (!(await hasAccess(ctx, from.id, message))) return "not_allowed";
  return "process";
}

/** Вежливый ответ посторонним — без хранения апдейта. */
export async function replyToOutsider(ctx: AppContext, update: TgUpdate, gate: Gate): Promise<void> {
  const message = update.message;
  if (!message) {
    if (update.callback_query) await ctx.telegram.answerCallbackQuery(update.callback_query.id);
    return;
  }
  const lang = message.from?.language_code ?? "ru";
  try {
    if (gate === "not_allowed") await ctx.telegram.sendMessage(message.chat.id, t("notAllowed", lang));
  } catch (e) {
    console.warn("outsider reply failed", e instanceof Error ? e.message : e);
  }
}
