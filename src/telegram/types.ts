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
  title?: string;
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  from: TgUser;
  date: number;
  old_chat_member: { status: string };
  new_chat_member: { status: string };
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  reply_to_message?: { message_id: number; from?: TgUser };
  forward_origin?: unknown;
  // Размеры по возрастанию
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  caption?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  // Нажатие под inline-сообщением: message нет, чат неизвестен
  inline_message_id?: string;
  data?: string;
}

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
  my_chat_member?: TgChatMemberUpdated;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type ReplyMarkup = { inline_keyboard: InlineKeyboardButton[][] } | { force_reply: true; input_field_placeholder?: string };
