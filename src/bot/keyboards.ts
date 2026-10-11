// Клавиатура «Подключить» и формат callback_data (callback-data.ts — чистый, его импортируют и юнит-тесты).

import { randomToken } from "../crypto";
import { createOAuthState } from "../db/accounts";
import type { ReplyMarkup } from "../telegram/types";
import type { AppContext } from "./context";
import { t } from "./messages";

// Каждый вызов создаёт новую одноразовую ссылку (oauth_states)
export async function connectKeyboard(ctx: AppContext, userId: string, locale: string, tgName: string | undefined): Promise<ReplyMarkup> {
  const state = randomToken();
  await createOAuthState(ctx.db, state, userId, ctx.clock.now(), tgName);
  return {
    inline_keyboard: [[{ text: t("connectButton", locale), url: `${ctx.config.publicBaseUrl}/oauth/google/start?state=${state}` }]],
  };
}

export { callbackData, parseCallbackData } from "./callback-data";
