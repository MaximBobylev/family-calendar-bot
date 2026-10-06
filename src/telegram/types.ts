// Минимальные типы Telegram Bot API — только то, что используем.

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  /** from — чтобы в группе отличить ответ боту (US-94). */
  reply_to_message?: { message_id: number; from?: TgUser };
  forward_origin?: unknown;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  /** Нажатие под inline-сообщением (US-95): message нет, чат неизвестен. */
  inline_message_id?: string;
  data?: string;
}

/** Inline-запрос «@бот завтра 19:00 футбол» (US-95). */
export interface TgInlineQuery {
  id: string;
  from: TgUser;
  query: string;
  offset: string;
  chat_type?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  inline_query?: TgInlineQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type ReplyMarkup = { inline_keyboard: InlineKeyboardButton[][] } | { force_reply: true; input_field_placeholder?: string };
