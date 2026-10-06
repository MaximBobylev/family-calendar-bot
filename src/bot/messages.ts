// Тексты бота. Пока простой словарь RU/EN; позже — каталог i18n с ICU plural (ADR-0003).
// Словарь разбит по областям в messages/*.ts (меньше конфликтов при параллельных правках); ключи не должны повторяться.

import { accountMessages } from "./messages/account";
import { commonMessages } from "./messages/common";
import { createMessages } from "./messages/create";
import { deleteMessages } from "./messages/delete";
import { findMessages } from "./messages/find";
import { householdMessages } from "./messages/household";
import { ingestMessages } from "./messages/ingest";
import { inlineMessages } from "./messages/inline";
import { inputMessages } from "./messages/input";
import { modifyMessages } from "./messages/modify";
import { notifyMessages } from "./messages/notify";
import { readMessages } from "./messages/read";
import { settingsMessages } from "./messages/settings";
import { undoMessages } from "./messages/undo";

export const messages = {
  ...commonMessages,
  ...accountMessages,
  ...readMessages,
  ...createMessages,
  ...findMessages,
  ...modifyMessages,
  ...deleteMessages,
  ...undoMessages,
  ...settingsMessages,
  ...inputMessages,
  ...householdMessages,
  ...ingestMessages,
  ...inlineMessages,
  ...notifyMessages,
};

export type MessageKey = keyof typeof messages;

export function t(key: MessageKey, locale: string, params: Record<string, string> = {}): string {
  return messages[key][locale === "en" ? "en" : "ru"].replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`);
}
