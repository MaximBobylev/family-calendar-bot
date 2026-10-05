import { describe, expect, it } from "vitest";
import { detailHints, isDetailChange } from "../src/nlu/detail-hints";

const popup = (...m: number[]) => ({ overrides: m.map((minutes) => ({ method: "popup", minutes })) });

describe("detailHints: напоминания (US-42)", () => {
  it.each([
    ["Поставь напоминания за час и за сутки до встречи в среду", popup(60, 1440), "встречи в среду"],
    ["Напомни за 15 минут до планёрки", popup(15), "планёрки"],
    ["Напомни за два дня до стоматолога", popup(2880), "стоматолога"],
    ["Поставь напоминание за полчаса до созвона с Петей", popup(30), "созвона с Петей"],
    ["Убери напоминания с обеда", { overrides: [] }, "с обеда"],
    ["Сделай обед без напоминаний", { overrides: [] }, "обед"],
  ] as const)("%s", (text, reminders, rest) => {
    const h = detailHints(text);
    expect(h.reminders).toEqual(reminders);
    expect(h.rest).toBe(rest);
  });

  it("на почту", () => {
    expect(detailHints("Напомни на почту за день до встречи с Петей")).toMatchObject({
      reminders: { overrides: [{ method: "email", minutes: 1440 }] },
      rest: "встречи с Петей",
    });
    expect(detailHints("На почту за день до встречи с Петей").reminders).toEqual({ overrides: [{ method: "email", minutes: 1440 }] });
  });

  it("лимиты Google: не раньше чем за 4 недели, не больше 5", () => {
    expect(detailHints("Напомни за 5 недель до отпуска").reminders).toEqual({ error: "tooFar" });
    expect(detailHints("Напомни за месяц до отпуска").reminders).toEqual({ error: "tooFar" });
    expect(detailHints("Напомни за 5 минут, за 10 минут, за 15 минут, за 30 минут, за час и за день до планёрки").reminders).toEqual({ error: "tooMany" });
    expect(detailHints("Напомни за 4 недели до отпуска").reminders).toEqual(popup(40320));
  });

  it("«напомни себе позвонить» — не напоминание события", () => {
    expect(detailHints("Напомни себе позвонить в банк послезавтра в 10 утра").reminders).toBeUndefined();
    expect(isDetailChange("Напомни купить молоко")).toBe(false);
  });
});

describe("detailHints: место и описание (US-41)", () => {
  it.each([
    ["Добавь место: кафе Пушкин", { location: "кафе Пушкин", rest: "" }],
    ["Поменяй место встречи с Машей на кафе Пушкин", { location: "кафе Пушкин", rest: "встречи с Машей" }],
    ["Добавь место кафе Пушкин", { location: "кафе Пушкин", rest: "" }],
    ["Убери место у планёрки", { location: "", rest: "у планёрки" }],
    ["Встреча в среду будет в офисе на Лесной", { locationGuess: "в офисе на Лесной", rest: "Встреча в среду" }],
    ["Добавь к встрече в 12 описание: взять документы", { description: { text: "взять документы", append: true }, rest: "к встрече в 12" }],
    ["Измени описание планёрки на обсудить релиз", { description: { text: "обсудить релиз", append: false }, rest: "планёрки" }],
    ["Удали описание у обеда", { description: { text: "", append: false }, rest: "у обеда" }],
  ] as const)("%s", (text, expected) => {
    expect(detailHints(text)).toEqual(expected);
  });

  it("«будет в 15» — время, не место", () => {
    expect(detailHints("Встреча будет в 15").locationGuess).toBeUndefined();
  });
  it("создание с описанием — не изменение", () => {
    expect(isDetailChange("Поставь встречу завтра в 10 с описанием: взять документы")).toBe(false);
  });
  it("без деталей rest — исходный текст", () => {
    expect(detailHints("Перенеси планёрку на 11")).toEqual({ rest: "Перенеси планёрку на 11" });
  });
});
