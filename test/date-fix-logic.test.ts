// Метрика date_fix (tech-debt #26): что считается правкой даты сразу после карточки и какой.

import { describe, expect, it } from "vitest";
import { checkDisagreed, classifyDateFix, DATE_FIX_WINDOW_MS, type DateFixWatch, optionWhen } from "../src/bot/date-fix-logic";

const t0 = 1_000_000_000;
const created: DateFixWatch = { stage: "created", eventId: "ev1", title: "Созвон", when: "100:900", source: "message", agreement: "agree", at: t0 };
const cancelled: DateFixWatch = { stage: "cancelled", title: "Созвон", when: "100:900", source: "message", agreement: "differ", at: t0 };
const pick = (index: number, n = 1, extra: { fromLlm?: true }[] = []) => ({
  k: "pick" as const,
  options: Array.from({ length: n }, (_, i) => extra[i] ?? {}),
  index,
  title: "Созвон",
  when: "100:960",
});

describe("classifyDateFix", () => {
  it("первый вариант или единственный — не правка", () => {
    expect(classifyDateFix(undefined, pick(0), t0)).toBeUndefined();
    expect(classifyDateFix(undefined, pick(0, 2), t0)).toBeUndefined();
  });

  it("не первый вариант: наш или из `start` от LLM", () => {
    expect(classifyDateFix(undefined, pick(1, 2), t0)).toBe("option_ours");
    expect(classifyDateFix(undefined, pick(1, 2, [{}, { fromLlm: true }]), t0)).toBe("option_llm");
  });

  it("варианты серии на 29–31 число — выбор правила, не даты", () => {
    const e = { ...pick(1, 2), options: [{ series: { rrule: "", text: "", next: [] } }, { series: { rrule: "", text: "", next: [] } }] };
    expect(classifyDateFix(undefined, e, t0)).toBeUndefined();
  });

  it("отменили карточку и в окне создали то же на другую дату — пересоздание", () => {
    expect(classifyDateFix(cancelled, pick(0), t0 + 60_000)).toBe("recreate");
    // название без учёта регистра и «ё»
    expect(classifyDateFix({ ...cancelled, title: "созвон " }, pick(0), t0)).toBe("recreate");
  });

  it("пересоздание: та же дата, другое название или вне окна — не правка", () => {
    expect(classifyDateFix(cancelled, { ...pick(0), when: "100:900" }, t0)).toBeUndefined();
    expect(classifyDateFix(cancelled, { ...pick(0), title: "Обед" }, t0)).toBeUndefined();
    expect(classifyDateFix(cancelled, pick(0), t0 + DATE_FIX_WINDOW_MS + 1)).toBeUndefined();
    // созданная (не отменённая) карточка + новое создание — просто два события
    expect(classifyDateFix(created, pick(0), t0)).toBeUndefined();
  });

  it("изменили время только что созданного события в окне — modify", () => {
    expect(classifyDateFix(created, { k: "modify", eventId: "ev1", timeChanged: true }, t0 + 60_000)).toBe("modify");
  });

  it("modify: другое событие, не время, вне окна, отменённая или уже учтённая карточка — не правка", () => {
    expect(classifyDateFix(created, { k: "modify", eventId: "ev2", timeChanged: true }, t0)).toBeUndefined();
    expect(classifyDateFix(created, { k: "modify", eventId: "ev1", timeChanged: false }, t0)).toBeUndefined();
    expect(classifyDateFix(created, { k: "modify", eventId: "ev1", timeChanged: true }, t0 + DATE_FIX_WINDOW_MS + 1)).toBeUndefined();
    expect(classifyDateFix(cancelled, { k: "modify", eventId: "ev1", timeChanged: true }, t0)).toBeUndefined();
    expect(classifyDateFix({ ...created, fixed: true }, { k: "modify", eventId: "ev1", timeChanged: true }, t0)).toBeUndefined();
    expect(classifyDateFix(undefined, { k: "modify", eventId: "ev1", timeChanged: true }, t0)).toBeUndefined();
  });
});

describe("helpers", () => {
  it("расхождение date_check — обе стороны дали разную дату", () => {
    expect(["differ", "llm_invented", "agree", "ours_only", "llm_only", "none", undefined].map((a) => checkDisagreed(a as never))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("ключ даты варианта: день + минуты или «весь день»", () => {
    expect(optionWhen({ startDay: 5, start: { day: 5, minutes: 600 }, allDay: false })).toBe("5:600");
    expect(optionWhen({ startDay: 5, allDay: true })).toBe("5:all");
  });
});
