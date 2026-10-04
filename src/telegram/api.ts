// Клиент Telegram Bot API. Базовый URL — из конфига (в тестах — фейк).

import type { ReplyMarkup } from "./types";

export class TelegramApi {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result as T;
  }

  sendMessage(chatId: number | string, text: string, replyMarkup?: ReplyMarkup, opts: { html?: boolean } = {}) {
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(opts.html ? { parse_mode: "HTML", link_preview_options: { is_disabled: true } } : {}),
    });
  }

  editMessageText(chatId: number | string, messageId: number | string, text: string, replyMarkup?: ReplyMarkup, opts: { html?: boolean } = {}) {
    return this.call<unknown>("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
      ...(opts.html ? { parse_mode: "HTML", link_preview_options: { is_disabled: true } } : {}),
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string) {
    return this.call<true>("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }
}
