import { describe, expect, it } from "vitest";
import type { CalendarInfo } from "../src/calendar/model";
import { parseLocal } from "../src/dates/calendar";
import { alignCalls, buildItems, type MultiCardPayload, type MultiItem, notDoneOf, toggle } from "../src/bot/multi-logic";
import { splitMessage } from "../src/bot/multi-split";
import { eventsCount, multiCardButtons, multiCardText, multiSummaryText, multiUndoText, notDoneLines } from "../src/bot/multi-view";

const NOW = parseLocal("2026-10-12T10:00");
const tz = "Europe/Moscow";
const cal = (id: string, title: string, isDefault = false): CalendarInfo => ({
  id,
  accountId: "a1",
  providerCalendarId: id,
  title,
  writable: true,
  isDefault,
  aliases: [],
});

function card(text: string, locale = "ru", extra: Partial<MultiCardPayload> = {}, calendars = [cal("c1", "Иван", true)]): MultiCardPayload {
  const pieces = splitMessage(text, "2026-10-12T10:00", tz);
  const res = buildItems({
    pieces,
    calls: alignCalls(pieces, []),
    families: pieces.map(() => ({ remove: [] })),
    now: NOW,
    tz,
    locale,
    durationMin: 60,
    calendars,
  });
  if ("calendarError" in res) throw new Error("calendar");
  const items = res.items.map((b) => b.item);
  return { chatId: 1, items, ...(items.some((i) => i.birthday) ? { yearly: true } : {}), ...extra };
}
const ref = (id: string) => ({ ref: { accountId: "a1", calendarId: "c1", providerEventId: id }, link: `https://cal/${id}` });
const buttons = (p: MultiCardPayload, locale = "ru") =>
  multiCardButtons(p, "abc", locale)
    .flat()
    .map((b) => b.text);

describe("карточка-список", () => {
  it("М1: строки в порядке сказанного, день полностью, кнопка на событие", () => {
    const p = card("Запиши в пятницу в 10 стоматолог, а в субботу в 12 футбол у Вани");
    expect(multiCardText(p, NOW.day, "ru")).toBe(
      "Создать эти события?\n\n✅ 1. <b>Стоматолог</b>\nпт, 16 октября, 10:00–11:00\n\n✅ 2. <b>Футбол у Вани</b>\nсб, 17 октября, 12:00–13:00",
    );
    expect(buttons(p)).toEqual(["✅ 1 · Стоматолог", "✅ 2 · Футбол у Вани", "Создать все (2)", "Отмена"]);
  });

  it("М3: снятая строка — ⬜ и «не создаю», главная кнопка — «выбранные»", () => {
    const p = toggle(card("Запиши в пятницу в 10 стоматолог, а в субботу в 12 футбол у Вани"), "t1")!;
    expect(multiCardText(p, NOW.day, "ru")).toContain("⬜ 2. <b>Футбол у Вани</b>\nсб, 17 октября, 12:00–13:00 — не создаю");
    expect(buttons(p)).toEqual(["✅ 1 · Стоматолог", "⬜ 2 · Футбол у Вани", "Создать выбранные (1)", "Отмена"]);
  });

  it("М7: пересланное, дни рождения, одна кнопка «каждый год»", () => {
    const p = card("Не забудь, у Пети день рождения 12 ноября, а у Маши — 3 декабря", "ru", { forwardedFrom: "Аня" });
    const text = multiCardText(p, NOW.day, "ru");
    expect(text).toContain("Создать эти события?\n📝 Из пересланного сообщения от Аня\n\n");
    expect(text).toContain("✅ 1. <b>День рождения Пети</b>\nчт, 12 ноября, весь день, 🔁 каждый год");
    expect(buttons(p)).toEqual(["✅ 1 · День рождения Пети", "✅ 2 · День рождения Маши", "🔁 Каждый год: да", "Создать все (2)", "Отмена"]);
    const off = toggle(p, "y")!;
    expect(multiCardText(off, NOW.day, "ru")).not.toContain("каждый год");
    expect(buttons(off)).toContain("🔁 Каждый год: нет");
  });

  it("один календарь из нескольких — строкой под заголовком; строка без события — ❓ без кнопки", () => {
    const p = card("Завтра в 9 планёрка и ещё созвон с Олегом", "ru", { showCalendar: true }, [cal("c1", "Иван", true), cal("c2", "Семья")]);
    expect(multiCardText(p, NOW.day, "ru")).toBe(
      "Создать эти события?\n🗓 Иван\n\n✅ 1. <b>Планёрка</b>\nвт, 13 октября, 09:00–10:00\n\n❓ 2. <b>Созвон с Олегом</b>\nне понял день или время — скажите его отдельным сообщением",
    );
    expect(buttons(p)).toEqual(["✅ 1 · Планёрка", "Создать все (1)", "Отмена"]);
  });

  it("М11: английский", () => {
    const p = card("Dentist on Friday at 10 and football on Saturday at noon", "en");
    expect(multiCardText(p, NOW.day, "en")).toContain("Create these events?\n\n✅ 1. <b>Dentist</b>\nFri 16 October, 10:00–11:00");
    expect(buttons(p, "en")).toEqual(["✅ 1 · Dentist", "✅ 2 · Football", "Create all (2)", "Cancel"]);
  });

  it("длинное название на кнопке обрезается", () => {
    const p = card("Во вторник в 19 родительское собрание, в среду в 8 анализы");
    expect(buttons(p)[0]).toBe("✅ 1 · Родительское собран…");
  });
});

describe("не сделано (⏭)", () => {
  it("куски-не-создания своего сообщения — абзацем внизу карточки и итога", () => {
    const pieces = splitMessage("Запиши в пятницу в 10 стоматолог, в субботу в 12 футбол и удали планёрку в четверг", "2026-10-12T10:00", tz);
    const p = { ...card("Запиши в пятницу в 10 стоматолог, в субботу в 12 футбол"), notDone: notDoneOf(pieces) };
    expect(multiCardText(p, NOW.day, "ru")).toMatch(/12:00–13:00\n\n⏭ Не сделал: «удали планёрку в четверг» — пришлите это отдельным сообщением\.$/);
    expect(notDoneLines(undefined, "ru")).toBe("");
  });
});

describe("итог", () => {
  const base = card("Во вторник в 19 родительское собрание, в среду в 8 анализы, в четверг в 20 кино");
  const withDone = (done: (MultiItem["done"] | undefined)[]): MultiCardPayload => ({
    ...base,
    items: base.items.map((it, i) => (done[i] ? { ...it, done: done[i] } : it)),
  });

  it("М4: всё создано — ссылки-названия, номера по созданным, пропущенные строкой", () => {
    const p = withDone([ref("e1"), undefined, ref("e3")]);
    p.items[1] = { ...p.items[1]!, sel: "off" };
    expect(multiSummaryText(p, NOW.day, "ru")).toBe(
      '✅ Создано\n\n1. <a href="https://cal/e1">Родительское собрание</a> — вт, 13 октября, 19:00–20:00\n' +
        '2. <a href="https://cal/e3">Кино</a> — чт, 15 октября, 20:00–21:00\n\nНе создавал: Анализы',
    );
  });

  it("М5: частичный сбой — ✅ / ❌ по строкам", () => {
    const text = multiSummaryText(withDone([ref("e1"), { failed: true }, ref("e3")]), NOW.day, "ru");
    expect(text).toContain("Создано 2 из 3\n\n1. ✅ <a href=");
    expect(text).toContain("2. ❌ Анализы — ср, 14 октября, 08:00–09:00 — Google не ответил");
  });

  it("ничего не создано — «Google не отвечает»", () => {
    expect(multiSummaryText(withDone([{ failed: true }, { failed: true }, { failed: true }]), NOW.day, "ru")).toMatch(
      /^Google не отвечает — ничего не создал\n\n1\. ❌/,
    );
  });
});

describe("отмена пачки", () => {
  it("число склоняется, изменённые названы", () => {
    expect(multiUndoText(2, ["Родительское собрание"], "ru")).toBe("↩ Отменил: удалил 2 события.\nНе удалил «Родительское собрание» — его уже изменили.");
    expect(multiUndoText(5, [], "ru")).toBe("↩ Отменил: удалил 5 событий.");
    expect(multiUndoText(1, [], "en")).toBe("↩ Undone: deleted 1 event.");
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => eventsCount(n, "ru"))).toEqual([
      "1 событие",
      "2 события",
      "5 событий",
      "11 событий",
      "21 событие",
      "22 события",
      "25 событий",
    ]);
  });
});
