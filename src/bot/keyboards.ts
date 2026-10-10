// В callback_data — только id карточки и выбор: данные карточки живут в D1.

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

export const callbackData = (actionId: string, choice: string) => `pa:${actionId}:${choice}`;

export function parseCallbackData(data: string | undefined): { actionId: string; choice: string } | null {
  const m = /^pa:([0-9a-f]+):(\w+)$/.exec(data ?? "");
  return m ? { actionId: m[1]!, choice: m[2]! } : null;
}
