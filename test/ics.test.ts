import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatMoment, parseLocal } from "../src/dates/calendar";
import { icsToItem } from "../src/ics/convert";
import { type IcsEvent, parseDuration, parseIcs, resolveTzid, unfold } from "../src/ics/parse";

const sample = (name: string) => readFileSync(join(import.meta.dirname, "../testdata/ics", name), "utf8");
const events = (name: string): IcsEvent[] => {
  const r = parseIcs(sample(name));
  if ("error" in r) throw new Error(`ожидались события, получено ${r.error}`);
  return r.events;
};
const tz = "Europe/Moscow";
const day = (d: string) => parseLocal(`${d}T00:00`).day;

describe("parseIcs", () => {
  it("UTC, экранирование, свёрнутая строка, VALARM не мешает", () => {
    const [e] = events("single-utc.ics");
    expect(e).toMatchObject({
      uid: "booking-123@clinic.example",
      summary: "Приём у стоматолога, д-р Иванова",
      location: "ул. Ленина 5, каб. 12",
      start: { kind: "utc", local: "2026-10-14T06:30" },
      end: { kind: "utc", local: "2026-10-14T07:15" },
    });
    expect(e!.description).toBe("Возьмите паспорт.\nПриходите за 10 минут. Подробнее: https://clinic.example/booking/123");
  });

  it("Windows-пояс, IANA-пояс, DURATION, RRULE; отменённое пропущено", () => {
    const list = events("multi-tzid.ics");
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ summary: "Планирование квартала", start: { kind: "zoned", tz: "Europe/Moscow", local: "2026-10-20T15:00" } });
    expect(list[0]!.location).toBe('Переговорная "Нева"');
    expect(list[1]).toMatchObject({ durationMin: 45, rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10", start: { kind: "zoned", tz: "Europe/Berlin" } });
  });

  it("события на весь день", () => {
    const [trip, bday] = events("all-day.ics");
    expect(trip!.start).toEqual({ kind: "date", date: "2026-11-02" });
    expect(trip!.end).toEqual({ kind: "date", date: "2026-11-09" });
    expect(bday!.rrule).toBe("RRULE:FREQ=YEARLY");
  });

  it("не календарь и календарь без годных событий — ошибки", () => {
    expect(parseIcs(sample("malformed.ics"))).toEqual({ error: "not_calendar" });
    expect(parseIcs(sample("no-events.ics"))).toEqual({ error: "no_events" });
    expect(parseIcs("")).toEqual({ error: "not_calendar" });
  });

  it("неизвестный TZID — плавающее время с пометкой", () => {
    const r = parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=Mars/Olympus:20261020T150000\nEND:VEVENT\nEND:VCALENDAR");
    expect(r).toEqual({ events: [{ start: { kind: "floating", local: "2026-10-20T15:00" }, unknownTz: "Mars/Olympus" }] });
  });

  it("помощники: unfold, DURATION, TZID", () => {
    expect(unfold("A:1\r\n 23\r\n\tB\nC:2")).toEqual(["A:123B", "C:2"]);
    expect(parseDuration("PT1H30M")).toBe(90);
    expect(parseDuration("P1D")).toBe(1440);
    expect(parseDuration("P1W")).toBe(10080);
    expect(parseDuration("-PT15M")).toBeUndefined();
    expect(parseDuration("P")).toBeUndefined();
    expect(resolveTzid("/mozilla.org/20050126_1/Europe/Moscow")).toBe("Europe/Moscow");
    expect(resolveTzid("Russian Standard Time")).toBe("Europe/Moscow");
    expect(resolveTzid("Nowhere")).toBeUndefined();
  });
});

describe("icsToItem", () => {
  it("UTC → пояс пользователя", () => {
    const it0 = icsToItem(events("single-utc.ics")[0]!, tz, 60);
    expect(formatMoment(it0.start!)).toBe("2026-10-14T09:30");
    expect(formatMoment(it0.end!)).toBe("2026-10-14T10:15");
    expect(it0.allDay).toBe(false);
  });

  it("Берлин 9:00 → Москва 10:00, конец по DURATION", () => {
    const it1 = icsToItem(events("multi-tzid.ics")[1]!, tz, 60);
    expect(formatMoment(it1.start!)).toBe("2026-10-19T10:00");
    expect(formatMoment(it1.end!)).toBe("2026-10-19T10:45");
    expect(it1.rrule).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10");
  });

  it("весь день: DTEND исключающая; без DTEND — один день", () => {
    const [trip, bday] = events("all-day.ics").map((e) => icsToItem(e, tz, 60));
    expect(trip).toMatchObject({ allDay: true, startDay: day("2026-11-02"), endDay: day("2026-11-08") });
    expect(bday).toMatchObject({ allDay: true, startDay: day("2026-11-15"), endDay: day("2026-11-15") });
  });

  it("без конца — длительность по умолчанию; плавающее время — в поясе пользователя", () => {
    const item = icsToItem({ start: { kind: "floating", local: "2026-10-20T15:00" } }, tz, 30);
    expect(formatMoment(item.start!)).toBe("2026-10-20T15:00");
    expect(formatMoment(item.end!)).toBe("2026-10-20T15:30");
  });
});
