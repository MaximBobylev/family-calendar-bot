import { describe, expect, it } from "vitest";
import type { CalendarInfo } from "../src/calendar/model";
import { formatMoment, parseLocal } from "../src/dates/calendar";
import { type CreateOption, resolveCalendar, resolveDraft } from "../src/bot/create-logic";

// «Сейчас» — ср 7 октября 2026, 10:00 (как в приёмочных сценариях).
const now = parseLocal("2026-10-07T10:00");
const tz = "Europe/Moscow";
const cal = (id: string, title: string, extra: Partial<CalendarInfo> = {}): CalendarInfo => ({
  id,
  accountId: "a1",
  providerCalendarId: id,
  title,
  writable: true,
  isDefault: false,
  aliases: [],
  ...extra,
});
const main = cal("c1", "Работа", { isDefault: true });

const resolve = (draft: Parameters<typeof resolveDraft>[0], locale = "ru", duration = 60) => resolveDraft(draft, now, tz, main, locale, duration);
const options = (r: ReturnType<typeof resolveDraft>): CreateOption[] => {
  if (r.kind !== "options") throw new Error(`ожидались варианты, получено ${JSON.stringify(r)}`);
  return r.options;
};
const span = (o: CreateOption) => `${formatMoment(o.start!)} – ${formatMoment(o.end!)}`;

describe("resolveDraft", () => {
  it("без даты — спросить «когда?»", () => expect(resolve({ title: "Созвон" })).toEqual({ kind: "ask", question: "askWhen", keepStart: false }));

  it("дата и время — один вариант, длительность по умолчанию", () => {
    const [o, ...rest] = options(resolve({ startText: "завтра в 15", title: "Созвон" }));
    expect(rest).toEqual([]);
    expect(span(o!)).toBe("2026-10-08T15:00 – 2026-10-08T16:00");
    expect(o).toMatchObject({ calendarId: "c1", calendarTitle: "Работа", title: "Созвон", titleGiven: true, tz, allDay: false });
  });

  it("длительность из черновика и название по умолчанию на языке пользователя", () => {
    const [o] = options(resolve({ startText: "завтра в 15", durationText: "на полчаса" }, "en"));
    expect(span(o!)).toBe("2026-10-08T15:00 – 2026-10-08T15:30");
    expect(o).toMatchObject({ title: "Meeting", titleGiven: false });
  });

  it("только дата — спросить время, сохранив дату", () =>
    expect(resolve({ startText: "завтра" })).toEqual({ kind: "ask", question: "askTime", keepStart: true }));

  it("только дата и «весь день» — событие на весь день", () => {
    const [o] = options(resolve({ startText: "завтра", allDay: true }));
    expect(o).toMatchObject({ allDay: true, startDay: parseLocal("2026-10-08T00:00").day, endDay: parseLocal("2026-10-08T00:00").day });
    expect(o!.start).toBeUndefined();
  });

  it("прошедшее время — «уже прошло»", () => expect(resolve({ startText: "вчера в 15" })).toEqual({ kind: "ask", question: "inPast", keepStart: false }));

  it("длительность «на месяц» — не длительность встречи", () =>
    expect(resolve({ startText: "завтра в 15", durationText: "на месяц" })).toEqual({ kind: "reply", text: expect.stringContaining("Не понял длительность") }));

  it("место переносится в вариант", () => expect(options(resolve({ startText: "завтра в 15", location: "Кафе" }))[0]!.location).toBe("Кафе"));
});

describe("resolveDraft: серии (US-32)", () => {
  it("каждый понедельник в 10 — правило, три ближайшие даты, начало серии — первая дата", () => {
    const [o, ...rest] = options(resolve({ recurrenceText: "каждый понедельник в 10" }));
    expect(rest).toEqual([]);
    expect(o!.series!.rrule).toContain("FREQ=WEEKLY");
    expect(o!.series!.next).toHaveLength(3);
    expect(o!.startDay).toBe(o!.series!.next[0]);
    expect(span(o!)).toBe("2026-10-12T10:00 – 2026-10-12T11:00");
  });

  it("31-го числа — два варианта: пропускать короткие месяцы или последний день", () => {
    const [skip, last] = options(resolve({ recurrenceText: "каждое 31 число в 10" }));
    expect([skip!.series!.shortMonths, last!.series!.shortMonths]).toEqual(["skip", "last_day"]);
    expect(skip!.series!.next.map((d) => formatMoment({ day: d, minutes: 0 }).slice(0, 10))).toEqual(["2026-10-31", "2026-12-31", "2027-01-31"]);
    expect(last!.series!.next.map((d) => formatMoment({ day: d, minutes: 0 }).slice(0, 10))).toEqual(["2026-10-31", "2026-11-30", "2026-12-31"]);
  });

  it("правило без времени — спросить время", () =>
    expect(resolve({ recurrenceText: "каждый понедельник" })).toEqual({ kind: "ask", question: "askTime", keepStart: true }));

  it("непонятное правило — спросить «когда?»", () =>
    expect(resolve({ recurrenceText: "иногда" })).toEqual({ kind: "ask", question: "askWhen", keepStart: false }));
});

describe("resolveCalendar", () => {
  const ro = cal("c2", "Праздники", { writable: false });
  const family = cal("c3", "Семья", { aliases: ["общий"] });
  const all = [ro, main, family];

  it("без имени — календарь по умолчанию", () => expect(resolveCalendar(all, undefined)).toBe(main));
  it("по алиасу", () => expect(resolveCalendar(all, "общий")).toBe(family));
  it("только для чтения", () => expect(resolveCalendar(all, "Праздники")).toEqual({ error: "readOnly", name: "Праздники" }));
  it("не найден", () => expect(resolveCalendar(all, "Спорт")).toEqual({ error: "notFound", name: "Спорт" }));
  it("основной только для чтения — первый доступный для записи", () =>
    expect(resolveCalendar([cal("c4", "Чужой", { isDefault: true, writable: false }), family], undefined)).toBe(family));
  it("все только для чтения — записать некуда, а не «не найден» с пустым именем", () => {
    expect(resolveCalendar([ro], undefined)).toEqual({ error: "noWritable" });
    expect(resolveCalendar([ro], "Спорт")).toEqual({ error: "noWritable" });
    expect(resolveCalendar([ro], "Праздники")).toEqual({ error: "readOnly", name: "Праздники" });
  });
});
