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
