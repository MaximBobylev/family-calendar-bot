import { describe, expect, it } from "vitest";
import { modifyHints } from "../src/nlu/modify-hints";

describe("modifyHints", () => {
  it.each([
    ["Перенеси следующую встречу на пятницу", { reference: "next" }],
    ["Сдвинь её на час позже", { reference: "last" }],
    ["Перенеси эту встречу на 11", { reference: "last" }],
    ["Перенеси вторую на час позже", { reference: "list", listIndex: 2 }],
    ["Переименуй завтрашнюю встречу в Ревью дизайна", { newTitle: "Ревью дизайна" }],
    ["Назови её «Стендап»", { reference: "last", newTitle: "Стендап" }],
    ["Перенеси все планёрки на 11", { scope: "all" }],
    ["Перенеси планёрку в этот понедельник на 11", { scope: "this" }],
    ["Перенеси встречу во вторник на среду", {}],
    ["Перенеси встречу в эту среду на 15", { scope: "this" }],
  ] as const)("%s", (text, expected) => {
    expect(modifyHints(text)).toEqual(expected);
  });
});

describe("modifyHints scope", () => {
  it("«все стендапы» — вся серия", () => expect(modifyHints("Перенеси все стендапы на среду").scope).toBe("all"));
  it("«всё равно» — не серия", () => expect(modifyHints("Всё равно перенеси планёрку").scope).toBeUndefined());
});

import { MODIFY_VERBS, modifyQuery } from "../src/nlu/modify-hints";

describe("modifyQuery", () => {
  it.each([
    ["Перенеси созвон с Петей на 16", ["на 16"], undefined, "созвон с Петей"],
    ["Перенеси обед на завтра", ["на завтра"], undefined, "обед"],
    ["Сдвинь планёрку на час позже", ["на час позже"], undefined, "планёрку"],
    ["Переименуй планёрку в Стендап команды", [], "Стендап команды", "планёрку"],
    ["Перенеси её на час позже", ["на час позже"], undefined, null],
    ["Перенеси третью на час позже", ["на час позже"], undefined, null],
    ["Сдвинь завтрашнюю встречу в 15 на полчаса позже", ["завтра в 15", "на полчаса позже"], undefined, "встречу"],
    ["Перенеси все стендапы на среду", ["на среду"], undefined, "стендапы"],
  ] as const)("%s", (text, fragments, title, expected) => {
    expect(modifyQuery(text, [...fragments], title)).toBe(expected);
  });

  it("strong verbs", () => {
    expect(MODIFY_VERBS.test("Перенеси обед на завтра")).toBe(true);
    expect(MODIFY_VERBS.test("Поставь встречу на завтра")).toBe(false);
  });
});

import { DELETE_VERBS, MASS_DELETE, UNDO_PHRASE } from "../src/nlu/modify-hints";

describe("delete hints", () => {
  it("mass delete", () => {
    expect(MASS_DELETE.test("Удали все встречи на завтра")).toBe(true);
    expect(MASS_DELETE.test("Удали стендап")).toBe(false);
  });
  it("delete verbs", () => {
    expect(DELETE_VERBS.test("Убери планёрку")).toBe(true);
    expect(DELETE_VERBS.test("Перенеси планёрку")).toBe(false);
  });
  it("undo phrase", () => {
    expect(UNDO_PHRASE.test("Отмени последнее")).toBe(true);
    expect(UNDO_PHRASE.test("Отмена")).toBe(true);
    expect(UNDO_PHRASE.test("Отмени встречу с Петей")).toBe(false);
  });
});
