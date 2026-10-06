import { describe, expect, it } from "vitest";
import { messages, t } from "../src/bot/messages";
import { accountMessages } from "../src/bot/messages/account";
import { commonMessages } from "../src/bot/messages/common";
import { createMessages } from "../src/bot/messages/create";
import { deleteMessages } from "../src/bot/messages/delete";
import { findMessages } from "../src/bot/messages/find";
import { ingestMessages } from "../src/bot/messages/ingest";
import { inputMessages } from "../src/bot/messages/input";
import { modifyMessages } from "../src/bot/messages/modify";
import { readMessages } from "../src/bot/messages/read";
import { settingsMessages } from "../src/bot/messages/settings";
import { undoMessages } from "../src/bot/messages/undo";

const parts = [
  accountMessages,
  commonMessages,
  createMessages,
  deleteMessages,
  findMessages,
  inputMessages,
  modifyMessages,
  readMessages,
  settingsMessages,
  undoMessages,
  ingestMessages,
];

describe("messages", () => {
  // Части словаря склеиваются spread'ом: повтор ключа молча затёр бы текст
  it("ключи в частях словаря не повторяются", () => {
    const keys = parts.flatMap((p) => Object.keys(p));
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    expect(Object.keys(messages)).toHaveLength(keys.length);
  });

  it("у каждого текста есть RU и EN", () => {
    for (const [k, v] of Object.entries(messages)) expect([k, v.ru.length > 0, v.en.length > 0]).toEqual([k, true, true]);
  });

  it("t: подстановка параметров и запасной русский", () => {
    expect(t("renamed", "en", { title: "X" })).toBe("Done, renamed to “X”.");
    expect(t("renamed", "de", { title: "X" })).toBe("Готово, назвал «X».");
    expect(t("renamed", "ru")).toBe("Готово, назвал «{title}».");
  });
});
