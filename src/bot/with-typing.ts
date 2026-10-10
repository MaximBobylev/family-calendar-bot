// В тестовом режиме «печатает…» не шлём: сценарии не проверяют служебные вызовы.

import type { AppContext } from "./context";
import { keepTyping } from "./typing";

export async function withTyping(ctx: AppContext, chatId: number, work: () => Promise<void>): Promise<void> {
  const stop = ctx.config.testMode ? () => undefined : keepTyping(() => ctx.telegram.sendChatAction(chatId));
  try {
    await work();
  } finally {
    stop();
  }
}
