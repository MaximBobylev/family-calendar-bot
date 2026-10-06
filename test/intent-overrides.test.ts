import { describe, expect, it } from "vitest";
import { effectiveIntent, lookupQuery } from "../src/nlu/intent-overrides";
import type { Intent } from "../src/nlu/intents";

const list: Intent = { name: "list_events", range: "" };
const unsupported: Intent = { name: "unsupported" };

describe("effectiveIntent: поиск события (US-21)", () => {
  it.each([
    ["Какая у меня следующая встреча?", list, { name: "find_event", next: true }],
    ["Что у меня дальше?", unsupported, { name: "find_event", next: true }],
    ["What's my next meeting?", list, { name: "find_event", next: true }],
    ["Когда встреча с Петей?", list, { name: "find_event" }],
    ["Когда у меня стоматолог?", unsupported, { name: "find_event" }],
  ] as const)("%s", (text, intent, expected) => {
    expect(effectiveIntent(text, intent)).toEqual(expected);
  });

  it("«следующая неделя» — список, не поиск", () => {
    expect(effectiveIntent("Что у меня на следующей неделе?", list)).toEqual(list);
  });
  it("«когда я свободен» — не поиск события", () => {
    expect(effectiveIntent("Когда я свободен?", unsupported)).toEqual(unsupported);
  });
  it("глаголы изменения важнее «следующей»", () => {
    expect(effectiveIntent("Сдвинь следующую встречу на час позже", list).name).toBe("modify_event");
  });
  it("ответ LLM find_event не трогаем", () => {
    expect(effectiveIntent("Когда стоматолог", { name: "find_event", event: "стоматолог" })).toEqual({ name: "find_event", event: "стоматолог" });
  });
});

describe("lookupQuery", () => {
  it.each([
    ["Когда встреча с Петей?", "встреча с Петей"],
    ["Когда у меня стоматолог?", "стоматолог"],
    ["Когда следующая планёрка?", "планёрка"],
    ["Какая у меня следующая встреча?", "встреча"],
    ["Что у меня дальше?", null],
  ] as const)("%s → %s", (text, expected) => {
    expect(lookupQuery(text)).toBe(expected);
  });
});

describe("effectiveIntent: «следующий X» без даты — поиск, а не создание (QA R1 NLU, класс I)", () => {
  const create = (start: string): Intent => ({ name: "create_event", start });
  it.each([
    ["Next call with Petya", create("Next call")],
    ["Следующий созвон с Петей", create("")],
  ] as const)("%s → find_event", (text, intent) => {
    expect(effectiveIntent(text, intent)).toEqual({ name: "find_event", next: true });
  });
  it.each([
    ["Следующий созвон с Петей в пятницу в 15", create("в пятницу в 15")],
    ["Поставь следующую встречу с Петей", create("")],
    ["Созвон с Петей на следующей неделе", create("на следующей неделе")],
  ] as const)("%s — создание", (text, intent) => {
    expect(effectiveIntent(text, intent)).toEqual(intent);
  });
});
