import { describe, expect, it } from "vitest";
import { fixTranscript, isEmptySpeech } from "../src/stt/whisper";

describe("isEmptySpeech", () => {
  it.each(["", "  ", "Продолжение следует...", "Субтитры сделал DimaTorzok", "Thank you.", "Спасибо за просмотр!", "..."])("«%s» — тишина", (t) => {
    expect(isEmptySpeech(t)).toBe(true);
  });
  it.each(["Что у меня завтра?", "Спасибо, поставь встречу на завтра", "Thank you, schedule a call tomorrow"])("«%s» — речь", (t) => {
    expect(isEmptySpeech(t)).toBe(false);
  });
});

describe("fixTranscript", () => {
  it.each([
    ["Рисование Аня от Мини", "Рисование Аня отмени"],
    ["Рисование Аня от Мени", "Рисование Аня отмени"],
    ["от мени созвон", "отмени созвон"],
    ["Отмени созвон", "Отмени созвон"],
    ["встреча от минимума", "встреча от минимума"],
  ])("%s → %s", (input, want) => expect(fixTranscript(input)).toBe(want));
});
