// Сигналы для повторного мультимодального разбора голосового (multimodal-voice, вариант D).

import { describe, expect, it } from "vitest";
import { isNotRight, similarTranscripts } from "../src/voice/signals";

describe("isNotRight", () => {
  it.each([
    ["Неправильно", true],
    ["нет, не так", true],
    ["Не то", true],
    ["Ты не понял", true],
    ["Нет, я сказала отмени рисование", true],
    ["That's wrong", true],
    ["не так!", true],
    ["Не торопись", false],
    ["Перенеси не то, а другое совещание завтра на 11 и ещё кое-что", false],
    ["Что у меня завтра?", false],
    ["тоже", false],
  ])("%s → %s", (text, want) => expect(isNotRight(text)).toBe(want));
});

describe("similarTranscripts", () => {
  it.each([
    ["Рисование Аня от Мини", "Рисование Аня от Мени", true],
    // Искажённое против правильного — по словам почти ничего общего; реальный повтор искажён похоже (строка выше)
    ["Рисование Ани от Миней.", "Рисование Аня отмени", false],
    // Переговорил ту же команду — это повтор
    ["Созван с пятизавтра в 15.30", "Созвон с Петей завтра в 15:30", true],
    ["Что у меня завтра?", "Отмени созвон с Тимуром в среду", false],
    ["Ок", "Ок", false],
  ])("%s ~ %s → %s", (a, b, want) => expect(similarTranscripts(a, b)).toBe(want));
});
