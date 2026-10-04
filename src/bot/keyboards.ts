// Клавиатуры бота.

import { randomToken } from "../crypto";
import { createOAuthState } from "../db/accounts";
import type { ReplyMarkup } from "../telegram/types";
import type { AppContext } from "./context";
import { t } from "./messages";

/** Кнопка «Подключить Google Календарь» с новой одноразовой ссылкой (US-02). */
export async function connectKeyboard(ctx: AppContext, userId: string, locale: string): Promise<ReplyMarkup> {
  const state = randomToken();
  await createOAuthState(ctx.db, state, userId, ctx.clock.now());
  return {
    inline_keyboard: [[{ text: t("connectButton", locale), url: `${ctx.config.publicBaseUrl}/oauth/google/start?state=${state}` }]],
  };
}

/** callback_data: «pa:<id карточки>:<выбор>» — в Telegram уходит только id, данные — в D1 (US-05). */
export const callbackData = (actionId: string, choice: string) => `pa:${actionId}:${choice}`;

export function parseCallbackData(data: string | undefined): { actionId: string; choice: string } | null {
  const m = /^pa:([0-9a-f]+):(\w+)$/.exec(data ?? "");
  return m ? { actionId: m[1]!, choice: m[2]! } : null;
}
