// Обёртка «печатает…» на время обработки команды (US-10). Таймер — в typing.ts (чистый, с юнит-тестом).

import type { AppContext } from "./context";
import { keepTyping } from "./typing";

/** «печатает…» до ответа (US-10); в тестах не шлём — сценарии не проверяют служебные вызовы. */
export async function withTyping(ctx: AppContext, chatId: number, work: () => Promise<void>): Promise<void> {
  const stop = ctx.config.testMode ? () => undefined : keepTyping(() => ctx.telegram.sendChatAction(chatId));
  try {
    await work();
  } finally {
    stop();
  }
}
