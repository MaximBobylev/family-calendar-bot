import { describe, expect, it } from "vitest";
import { queryWords, titleScore, findCalendarByName } from "../src/calendar/match";

describe("titleScore", () => {
  it.each([
    ["встречу с Петей", "Созвон с Петей", 1],
    ["встречу с Петей", "Встреча с Петя", 1],
    ["планёрку", "Планёрка", 1],
    ["созвона по проекту", "Созвон по проекту Alpha", 1],
    ["стоматолога", "Стоматолог", 1],
    ["ужин у бабушки", "Ужин у бабушки", 1],
    ["встречу с Машей", "Встреча с Петей", 0],
    ["планёрку", "Ревью дизайна", 0],
    ["встречу", "Планёрка", 0],
  ] as const)("«%s» vs «%s»", (q, t, score) => {
    expect(titleScore(q, t)).toBe(score);
  });

  it("drops stop words", () => {
    expect(queryWords("мою встречу с Петей")).toEqual(["петей"]);
  });
});

describe("findCalendarByName", () => {
  const cals = [
    { title: "Иван", aliases: ["мой", "личный"] },
    { title: "Family Budget", aliases: ["семейный", "общий"] },
    { title: "Работа", aliases: [] },
  ];
  it.each([
    ["Иван", "Иван"],
    ["family budget", "Family Budget"],
    ["семейный", "Family Budget"],
    ["в семейном календаре", "Family Budget"],
    ["семейном", "Family Budget"],
    ["общий календарь", "Family Budget"],
    ["в рабочий", "Работа"],
    ["работе", "Работа"],
    ["личного", "Иван"],
    ["отпуск", undefined],
  ])("%s → %s", (name, title) => expect(findCalendarByName(cals, name)?.title).toBe(title));
});
