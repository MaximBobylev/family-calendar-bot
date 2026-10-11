// Ключи в messages/*.ts не должны повторяться: spread ниже молча перезапишет одинаковый ключ.

import { accountMessages } from "./messages/account";
import { assignMessages } from "./messages/assign";
import { commonMessages } from "./messages/common";
import { createMessages } from "./messages/create";
import { deleteMessages } from "./messages/delete";
import { findMessages } from "./messages/find";
import { helpMessages } from "./messages/help";
import { householdMessages } from "./messages/household";
import { ingestMessages } from "./messages/ingest";
import { inlineMessages } from "./messages/inline";
import { inputMessages } from "./messages/input";
import { modifyMessages } from "./messages/modify";
import { multiMessages } from "./messages/multi";
import { notifyMessages } from "./messages/notify";
import { readMessages } from "./messages/read";
import { settingsMessages } from "./messages/settings";
import { timezoneMessages } from "./messages/timezone";
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
  ...timezoneMessages,
  ...inputMessages,
  ...householdMessages,
  ...ingestMessages,
  ...inlineMessages,
  ...notifyMessages,
  ...assignMessages,
  ...helpMessages,
  ...multiMessages,
};

export type MessageKey = keyof typeof messages;

export function t(key: MessageKey, locale: string, params: Record<string, string> = {}): string {
  return messages[key][locale === "en" ? "en" : "ru"].replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`);
}
