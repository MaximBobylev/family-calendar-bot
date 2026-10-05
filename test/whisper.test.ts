import { describe, expect, it } from "vitest";
import { isEmptySpeech } from "../src/stt/whisper";

describe("isEmptySpeech", () => {
  it.each(["", "  ", "Продолжение следует...", "Субтитры сделал DimaTorzok", "Thank you.", "Спасибо за просмотр!", "..."])("«%s» — тишина", (t) => {
    expect(isEmptySpeech(t)).toBe(true);
  });
  it.each(["Что у меня завтра?", "Спасибо, поставь встречу на завтра", "Thank you, schedule a call tomorrow"])("«%s» — речь", (t) => {
    expect(isEmptySpeech(t)).toBe(false);
  });
});
