import { describe, expect, it } from "vitest";
import { parseDateStructure, resolveRawStructure } from "../src/dates/structured";

// «Сейчас» — ср 7 октября 2026, 10:00 МСК (как в корпусе и приёмке).
const NOW = "2026-10-07T10:00";
const TZ = "Europe/Moscow";
const point = (raw: unknown, now = NOW) => resolveRawStructure(raw, "point", now, TZ);
const range = (raw: unknown, now = NOW) => resolveRawStructure(raw, "range", now, TZ);

describe("parseDateStructure — строгая проверка", () => {
  it("пустое, не объект, сломанная строка — нет структуры", () => {
    for (const raw of [undefined, null, {}, [], "", "{", 5, { alternatives: [] }]) expect(parseDateStructure(raw)).toBeUndefined();
  });
  it("строка JSON — разбирается (так отдают некоторые модели)", () =>
    expect(parseDateStructure('{"day":{"type":"relative_days","days":1}}')).toEqual({ day: { type: "relative_days", days: 1 } }));
  it("null в поле — как отсутствие поля", () =>
    expect(parseDateStructure({ day: { type: "relative_days", days: 1 }, time: null, by: null })).toEqual({ day: { type: "relative_days", days: 1 } }));
  it("любое неверное поле — структура отбрасывается целиком", () => {
    const bad = [
      { day: { type: "tomorrow" } },
      { day: { type: "weekday", weekday: "FRI" } },
      { day: { type: "weekday", weekday: "FR", which: "previous" } },
      { day: { type: "relative_days", days: "1" } },
      { day: { type: "date", day: 32 } },
      { day: { type: "date", day: 3, month: 13 } },
      { day: { type: "nth_weekday", n: 0, weekday: "MO" } },
      { day: { type: "nth_weekday", n: 6, weekday: "MO" } },
      { time: { hour: 15.5, minute: 0 } },
      { time: { minute: 30 } },
      { part_of_day: "noon" },
      { error: "maybe" },
      { timezone: "Mars/Olympus" },
      { offset_days: 3 },
      { day: { type: "last_day" }, offset_days: -1 },
      { day: { type: "date", day: 3, days: 2 } },
      { time: { hour: 9, minute: 0, timezone: "Europe/Kyiv" } },
      { day: { type: "relative_days", days: 1 }, confidence: 0.9 },
      { interval: { start: { hour: 10, minute: 0 } } },
      { by: "yes" },
      { day: { type: "relative_days", days: 1 }, alternatives: [{ day: { type: "relative_days", days: "2" } }] },
      { day: { type: "relative_days", days: 1 }, alternatives: Array.from({ length: 4 }, () => ({ day: { type: "relative_days", days: 2 } })) },
    ];
    for (const raw of bad) expect(parseDateStructure(raw), JSON.stringify(raw)).toBeUndefined();
  });
  it("незнакомое поле со значением null — не мешает", () =>
    expect(parseDateStructure({ day: { type: "relative_days", days: 0, weekday: null }, note: null })).toEqual({ day: { type: "relative_days", days: 0 } }));
});

describe("resolveDateStructure — те же правила, что у грамматики", () => {
  it("завтра в 15", () => expect(point({ day: { type: "relative_days", days: 1 }, time: { hour: 15, minute: 0 } })).toEqual({ datetime: "2026-10-08T15:00" }));
  it("правило часа: «в пятницу в 3» → 15:00", () =>
    expect(point({ day: { type: "weekday", weekday: "FR" }, time: { hour: 3, minute: 0 } })).toEqual({ datetime: "2026-10-09T15:00" }));
  it("«в следующую пятницу» — два варианта", () =>
    expect(point({ day: { type: "weekday", weekday: "FR", which: "next" } })).toEqual({ ambiguous: [{ date: "2026-10-09" }, { date: "2026-10-16" }] }));
  it("«через сутки» — момент +24 ч", () => expect(point({ in_minutes: 1440 })).toEqual({ datetime: "2026-10-08T10:00" }));
  it("пояс: «в 15:00 по Киеву» 3 ноября → 16:00 МСК", () =>
    expect(point({ day: { type: "date", day: 3, month: 11 }, time: { hour: 15, minute: 0 }, timezone: "Europe/Kyiv" })).toEqual({
      datetime: "2026-11-03T16:00",
    }));
  it("чтение: «до конца недели» → сегодня…воскресенье", () =>
    expect(range({ period: { type: "week", which: "this" } })).toEqual({ range: { from: "2026-10-07", to: "2026-10-11" } }));
  it("«к пятнице» → 09:00", () => expect(point({ day: { type: "weekday", weekday: "FR" }, by: true })).toEqual({ datetime: "2026-10-09T09:00" }));
});

describe("новые конструкции", () => {
  it("n-й день недели месяца: первый понедельник ноября в 10", () =>
    expect(point({ day: { type: "nth_weekday", n: 1, weekday: "MO", month: 11 }, time: { hour: 10, minute: 0 } })).toEqual({
      datetime: "2026-11-02T10:00",
    }));
  it("второй вторник ноября в 18:30", () =>
    expect(point({ day: { type: "nth_weekday", n: 2, weekday: "TU", month: 11 }, time: { hour: 18, minute: 30 } })).toEqual({
      datetime: "2026-11-10T18:30",
    }));
  it("последняя пятница этого месяца", () => expect(point({ day: { type: "nth_weekday", n: -1, weekday: "FR" } })).toEqual({ date: "2026-10-30" }));
  it("первый понедельник месяца, когда он уже прошёл, — следующий месяц", () =>
    expect(point({ day: { type: "nth_weekday", n: 1, weekday: "MO" } })).toEqual({ date: "2026-11-02" }));
  it("первый понедельник октября, когда он прошёл, — следующий год", () =>
    expect(point({ day: { type: "nth_weekday", n: 1, weekday: "MO", month: 10 } })).toEqual({ date: "2027-10-04" }));
  it("пятого понедельника нет — ближайший месяц, где он есть", () =>
    expect(point({ day: { type: "nth_weekday", n: 5, weekday: "MO" } })).toEqual({ date: "2026-11-30" }));
  it("последний день месяца и предпоследний (сдвиг -1)", () => {
    expect(point({ day: { type: "last_day" } })).toEqual({ date: "2026-10-31" });
    expect(point({ day: { type: "last_day", offset_days: -1 } })).toEqual({ date: "2026-10-30" });
    expect(point({ day: { type: "last_day", month: 2 } })).toEqual({ date: "2027-02-28" });
  });
  it("сдвиг от даты: за день до 15 ноября; через неделю после 3-го", () => {
    expect(point({ day: { type: "date", day: 15, month: 11, offset_days: -1 } })).toEqual({ date: "2026-11-14" });
    expect(point({ day: { type: "date", day: 3, offset_days: 7 }, time: { hour: 12, minute: 0 } })).toEqual({ datetime: "2026-11-10T12:00" });
  });
  it("сдвиг в прошлое — in_past", () => expect(point({ day: { type: "relative_days", days: 0, offset_days: -1 } })).toEqual({ error: "in_past" }));
  it("варианты: завтра или послезавтра в 15", () =>
    expect(
      point({
        day: { type: "relative_days", days: 1 },
        time: { hour: 15, minute: 0 },
        alternatives: [{ day: { type: "relative_days", days: 2 }, time: { hour: 15, minute: 0 } }],
      }),
    ).toEqual({ ambiguous: [{ datetime: "2026-10-08T15:00" }, { datetime: "2026-10-09T15:00" }] }));
  it("варианты без повторов; ошибочный вариант отбрасывается", () =>
    expect(point({ day: { type: "relative_days", days: 1 }, alternatives: [{ day: { type: "relative_days", days: 1 } }, { error: "unsupported" }] })).toEqual({
      date: "2026-10-08",
    }));
  it("unsupported → unparseable (бот переспрашивает)", () => expect(point({ error: "unsupported" })).toEqual({ error: "unparseable" }));
  it("empty и invalid_time — как у грамматики", () => {
    expect(point({ error: "empty" })).toEqual({ error: "empty" });
    expect(point({ time: { hour: 25, minute: 0 } })).toEqual({ error: "invalid_time" });
    expect(point({ time: { hour: 9, minute: 75 } })).toEqual({ error: "invalid_time" });
  });
});
