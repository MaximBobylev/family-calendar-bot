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
  /** Фото — размеры по возрастанию (US-66). */
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
  /** Файл: картинка без сжатия (US-66), приглашение .ics (US-67). */
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  caption?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type ReplyMarkup = { inline_keyboard: InlineKeyboardButton[][] } | { force_reply: true; input_field_placeholder?: string };
