import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { firstUrl, foreignDateSpans, guessPlace, heuristicTitle, sentences, sourceDescription } from "../src/bot/ingest-logic";
import { parseDateFragment } from "../src/dates";

// Среда, как в приёмочных сценариях
const now = "2026-10-07T10:00";
const tz = "Europe/Moscow";
const dates = (text: string) => foreignDateSpans(text, now, tz);

describe("foreignDateSpans", () => {
  it.each([
    ["Родительское собрание в четверг в 18:00, каб. 12", "в четверг в 18:00"],
    ["Вы записаны к стоматологу 14.10 в 9:30, ул. Ленина 5, каб. 12", "14.10 в 9:30"],
    ["Завтра в 7 у Маши родительское собрание, школа 41", "Завтра в 7"],
    ["Уважаемые родители! Собрание в пятницу.\nНачало в 18:30.", "в пятницу в 18:30"],
  ])("%s → %s", (text, point) => expect(dates(text).point).toBe(point));

  it("нет даты — пусто", () => expect(dates("Привет! Как дела? Давно не виделись").point).toBeUndefined());

  it("предложение с датой — для названия", () =>
    expect(dates("Уважаемые родители!\nРодительское собрание в четверг в 18:00").sentence).toBe("Родительское собрание в четверг в 18:00"));

  it("длинный текст режется на куски", () => expect(sentences(`${"слово ".repeat(100)}`).length).toBe(3));
});

interface ForeignDoc {
  defaults: { now: string; tz: string };
  cases: { text: string; point: string | null; start?: string | string[] }[];
}
const foreign = parseYaml(readFileSync(join(import.meta.dirname, "..", "testdata", "extract", "foreign.yaml"), "utf8")) as ForeignDoc;
const startOf = (point: string) => {
  const r = parseDateFragment({ text: point, kind: "point", now: foreign.defaults.now, tz: foreign.defaults.tz });
  const vs = "ambiguous" in r ? r.ambiguous : [r];
  const one = vs.map((v) => ("datetime" in v ? v.datetime : "date" in v ? (typeof v.date === "string" ? v.date : v.date.date) : JSON.stringify(v)));
  return one.length === 1 ? one[0] : one;
};

describe("foreignDateSpans: корпус", () => {
  it.each(foreign.cases.map((c) => [c.text.replace(/\n/g, " / "), c] as const))("%s", (_t, c) => {
    const d = foreignDateSpans(c.text, foreign.defaults.now, foreign.defaults.tz);
    expect(d.point ?? null).toBe(c.point);
    if (c.start) expect(startOf(d.point!)).toEqual(c.start);
  });
});

describe("guessPlace", () => {
  it.each([
    ["Родительское собрание в четверг в 18:00, каб. 12", "каб. 12"],
    ["Вы записаны к стоматологу 14.10 в 9:30, ул. Ленина 5, каб. 12", "ул. Ленина 5, каб. 12"],
    ["Завтра в 7 у Маши родительское собрание, школа 41", "школа 41"],
    ["Концерт 20 октября в 19:00\nАдрес: Невский пр., 32", "Невский пр., 32"],
    ["Созвон завтра в 15", undefined],
  ])("%s → %s", (text, place) => expect(guessPlace(text)).toBe(place));
});

describe("heuristicTitle", () => {
  const title = (text: string) => {
    const d = dates(text);
    return heuristicTitle(d.sentence, d.fragments, guessPlace(text));
  };
  it.each([
    ["Родительское собрание в четверг в 18:00, каб. 12", "Родительское собрание"],
    ["Вы записаны к стоматологу 14.10 в 9:30, ул. Ленина 5, каб. 12", "К стоматологу"],
    ["Напоминаем: завтра в 19:00 концерт хора", "Концерт хора"],
  ])("%s → %s", (text, want) => expect(title(text)).toBe(want));
});

describe("sourceDescription", () => {
  it("источник, цитата, ссылка за пределами цитаты", () => {
    const long = `${"а".repeat(310)} https://example.com/x.`;
    const d = sourceDescription("Из пересланного сообщения от Маши", long, (u) => `Ссылка: ${u}`);
    expect(d.split("\n")[0]).toBe("Из пересланного сообщения от Маши:");
    expect(d).toContain("…»");
    expect(d.split("\n")[2]).toBe("Ссылка: https://example.com/x");
  });
  it("ссылка", () => expect(firstUrl("Встреча https://meet.example/abc, приходите")).toBe("https://meet.example/abc"));
});
