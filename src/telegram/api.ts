// Клиент Telegram Bot API. Базовый URL — из конфига (в тестах — фейк).

import { fetchWithTimeout, TIMEOUTS } from "../net/fetch";
import type { ReplyMarkup } from "./types";

export class TelegramError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Некритичные вызовы (ответ на нажатие, «печатает…», правка карточки): ошибка не должна рвать сценарий. */
async function bestEffort<T>(p: Promise<T>, what: string): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    console.warn(`telegram ${what} failed (ignored):`, e instanceof Error ? e.message : e);
    return undefined;
  }
}

export class TelegramApi {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>, attempt = 0): Promise<T> {
    const res = await fetchWithTimeout(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, TIMEOUTS.telegram);
    // Тело может быть не JSON (502 от прокси) — не падаем на разборе
    const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as {
      ok: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    // 429: один повтор, если ждать недолго; иначе — ошибка (обработку подхватит очередь)
    const retryAfter = json.parameters?.retry_after;
    if (res.status === 429 && attempt === 0 && retryAfter !== undefined && retryAfter <= 3) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.call<T>(method, body, 1);
    }
    if (!json.ok) throw new TelegramError(`telegram ${method}: ${json.description ?? res.status}`, res.status);
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

  /** Правка карточки — best-effort: «message is not modified» / «not found» — штатные ситуации. */
  editMessageText(chatId: number | string, messageId: number | string, text: string, replyMarkup?: ReplyMarkup, opts: { html?: boolean } = {}) {
    return bestEffort(this.call<unknown>("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
      ...(opts.html ? { parse_mode: "HTML", link_preview_options: { is_disabled: true } } : {}),
    }), "editMessageText");
  }

  /** Скачать файл (голосовое) по file_id: getFile → /file/bot<token>/<path>. */
  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("telegram getFile: no file_path");
    const res = await fetchWithTimeout(`${this.base}/file/bot${this.token}/${file.file_path}`, {}, TIMEOUTS.telegram);
    if (!res.ok) throw new Error(`telegram file download: ${res.status}`);
    return res.arrayBuffer();
  }

  sendChatAction(chatId: number | string, action: "typing" = "typing") {
    return bestEffort(this.call<true>("sendChatAction", { chat_id: chatId, action }), "sendChatAction");
  }

  /** На повторе из очереди query уже «too old» — это не ошибка сценария. */
  answerCallbackQuery(callbackQueryId: string, text?: string) {
    return bestEffort(this.call<true>("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }), "answerCallbackQuery");
  }
}
