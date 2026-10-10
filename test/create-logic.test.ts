import { describe, expect, it } from "vitest";
import type { CalendarInfo } from "../src/calendar/model";
import { formatMoment, parseLocal } from "../src/dates/calendar";
import { type CreateOption, llmDateCheck, pickStart, resolveCalendar, resolveDraft, startCheck, withConversationDay } from "../src/bot/create-logic";
import type { DateStructure } from "../src/dates/structured";

// Среда, как в приёмочных сценариях.
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

describe("сверка даты с LLM (ревью 2026-10-08, шаг 1)", () => {
  it.each([
    [
      "нет куска — start от LLM, как раньше",
      "Созвон через две недели во вторник в 9",
      undefined,
      "через две недели во вторник в 9",
      { startText: "через две недели во вторник в 9" },
    ],
    ["start — часть нашего куска — не второе мнение", "Созвон завтра в 15", "завтра в 15", "в 15", { startText: "завтра в 15" }],
    ["start со словами не из текста — выдумка, не берём", "Ужин в пятницу", "в пятницу", "в пятницу в 19:00", { startText: "в пятницу" }],
    [
      "start из текста и не часть куска — второе мнение",
      "Встреча 10.11, начало 15:00",
      "10.11",
      "10.11, начало 15:00",
      { startText: "10.11", altStartText: "10.11, начало 15:00" },
    ],
    ["нет ничего", "Созвон", undefined, undefined, {}],
  ])("%s", (_name, text, point, llm, want) => expect(pickStart(text, point, llm)).toEqual(want));

  it.each([
    ["Созвон", undefined, undefined, "none"],
    ["Созвон завтра в 15", "завтра в 15", undefined, "ours_only"],
    ["Созвон через две недели во вторник в 9", undefined, "во вторник в 9", "llm_only"],
    ["Созвон завтра в 15", "завтра в 15", "завтра в 15", "agree"],
    ["Ужин в пятницу", "в пятницу", "в пятницу в 19:00", "llm_invented"],
    ["Встреча 10.11, начало 15:00", "10.11", "10.11, начало 15:00", "differ"],
  ])("для лога: %s / %s / %s → %s", (text, point, llm, want) => expect(startCheck(text, point, llm).agreement).toBe(want));

  it("у нас только день, у LLM — момент: берём LLM", () => {
    const [o, ...rest] = options(resolve({ startText: "в пятницу", altStartText: "в пятницу в 19:00" }));
    expect(rest).toEqual([]);
    expect(span(o!)).toBe("2026-10-09T19:00 – 2026-10-09T20:00");
  });

  it("оба момента и разные — оба вариантами, наш первый", () =>
    expect(options(resolve({ startText: "завтра в 15", altStartText: "в пятницу в 15" })).map(span)).toEqual([
      "2026-10-08T15:00 – 2026-10-08T16:00",
      "2026-10-09T15:00 – 2026-10-09T16:00",
    ]));

  it("совпадают — один вариант", () => expect(options(resolve({ startText: "завтра в 15", altStartText: "8 октября в 15:00" })).length).toBe(1));

  it("start не разбирается — только наш", () => expect(options(resolve({ startText: "завтра в 15", altStartText: "по Киеву" })).length).toBe(1));

  it("у нас только день, start не помогает — спросить время", () =>
    expect(resolve({ startText: "в пятницу", altStartText: "по Киеву" })).toEqual({ kind: "ask", question: "askTime", keepStart: true }));
});

describe("структура даты `when` от LLM — второе мнение (ревью дат, шаги 4–5)", () => {
  const W = {
    tomorrow15: { day: { type: "relative_days", days: 1 }, time: { hour: 15, minute: 0 } },
    friday15: { day: { type: "weekday", weekday: "FR" }, time: { hour: 15, minute: 0 } },
    firstMonNov10: { day: { type: "nth_weekday", n: 1, weekday: "MO", month: 11 }, time: { hour: 10, minute: 0 } },
    firstMonNov: { day: { type: "nth_weekday", n: 1, weekday: "MO", month: 11 } },
    unsupported: { error: "unsupported" },
  } as const satisfies Record<string, DateStructure>;
  const check = (text: string, point: string | undefined, when: DateStructure | undefined, start?: string, llmFirst = false) =>
    llmDateCheck(text, point, { ...(start ? { start } : {}), ...(when ? { when } : {}) }, now, tz, llmFirst);

  it.each([
    ["нет структуры — как раньше, по start", "Созвон завтра в 15", "завтра в 15", undefined, "завтра в 15", "agree", "start"],
    ["нет ни структуры, ни start", "Созвон", undefined, undefined, undefined, "none", "none"],
    ["те же даты — agree", "Созвон завтра в 15", "завтра в 15", W.tomorrow15, "завтра в 15", "agree", "when"],
    ["разные даты — differ", "Созвон завтра в 15", "завтра в 15", W.friday15, undefined, "differ", "when"],
    ["своего куска нет — llm_only", "Созвон в первый понедельник ноября в 10", undefined, W.firstMonNov10, undefined, "llm_only", "when"],
    ["модель сама не разобрала — llm_unsure", "Созвон завтра в 15", "завтра в 15", W.unsupported, undefined, "llm_unsure", "when"],
    ["модель не разобрала и куска нет — none", "Созвон после отпуска", undefined, W.unsupported, "после отпуска", "none", "when"],
  ] as const)("%s", (_n, text, point, when, start, agreement, llm) => {
    const c = check(text, point, when, start);
    expect(c.agreement).toBe(agreement);
    expect(c.llm).toBe(llm);
  });

  it("структура важнее start: start с выдумкой не мешает", () =>
    expect(check("Созвон завтра в 15", "завтра в 15", W.friday15, "в пятницу в 19").pick).toEqual({ startText: "завтра в 15", altWhen: W.friday15 }));

  it("грамматика не уверена — дата из структуры", () => {
    const [o, ...rest] = options(resolve({ altWhen: W.firstMonNov10 }));
    expect(rest).toEqual([]);
    expect(span(o!)).toBe("2026-11-02T10:00 – 2026-11-02T11:00");
    expect(o!.fromLlm).toBe(true);
  });

  it("расходятся — оба вариантами, наш первый; пересланное — модель первой", () => {
    expect(options(resolve({ startText: "завтра в 15", altWhen: W.friday15 })).map((o) => [span(o), o.fromLlm ?? false])).toEqual([
      ["2026-10-08T15:00 – 2026-10-08T16:00", false],
      ["2026-10-09T15:00 – 2026-10-09T16:00", true],
    ]);
    expect(options(resolve({ startText: "завтра в 15", altWhen: W.friday15, llmFirst: true })).map(span)).toEqual([
      "2026-10-09T15:00 – 2026-10-09T16:00",
      "2026-10-08T15:00 – 2026-10-08T16:00",
    ]);
  });

  it("у нас только день, в структуре — момент: берём структуру", () =>
    expect(options(resolve({ startText: "в пятницу", altWhen: W.friday15 })).map(span)).toEqual(["2026-10-09T15:00 – 2026-10-09T16:00"]));

  it("только структура и в ней только день — спросить время, дату сохранить словами для ответа", () =>
    expect(resolve({ altWhen: W.firstMonNov })).toEqual({ kind: "ask", question: "askTime", keepStart: true, startText: "02.11.2026" }));

  it("пояс из структуры — пересчёт и подпись для карточки", () => {
    const [o] = options(resolve({ altWhen: { day: { type: "date", day: 3, month: 11 }, time: { hour: 15, minute: 0 }, timezone: "Europe/Kyiv" } }));
    expect(span(o!)).toBe("2026-11-03T16:00 – 2026-11-03T17:00");
    expect(o!.zone).toEqual({ tz: "Europe/Kyiv", ru: "по Киеву", en: "Kyiv time" });
  });
});

describe("время в другом поясе и метки вариантов (tech-debt #26)", () => {
  it("«по Киеву» — момент пересчитан, пояс сказанного — в варианте для карточки", () => {
    const [o] = options(resolve({ startText: "3 ноября в 15:00 по Киеву" }));
    expect(span(o!)).toBe("2026-11-03T16:00 – 2026-11-03T17:00");
    expect(o!.zone).toEqual({ tz: "Europe/Kiev", ru: "по Киеву", en: "Kyiv time" });
  });

  it("свой пояс или «по местному» — без пометки", () => {
    expect(options(resolve({ startText: "завтра в 15 по Москве" }))[0]!.zone).toBeUndefined();
    expect(options(resolve({ startText: "завтра в 15 по местному" }))[0]!.zone).toBeUndefined();
  });

  it("незнакомый пояс без даты — вопрос о времени по своему поясу", () =>
    expect(resolve({ unknownZone: "по Варне" })).toEqual({ kind: "ask", question: "askZoneTime", keepStart: false }));

  it("вариант из `start` от LLM помечен — его выбор считается правкой даты", () => {
    const [ours, llm] = options(resolve({ startText: "завтра в 15", altStartText: "в пятницу в 15" }));
    expect(ours!.fromLlm).toBeUndefined();
    expect(llm!.fromLlm).toBe(true);
  });
});

describe("начало серии при разных «сейчас» (корпус с разными «сейчас», tech-debt #26)", () => {
  const first = (text: string, at: string, zone = tz) => {
    const r = resolveDraft({ recurrenceText: text }, parseLocal(at), zone, main, "ru", 60);
    return r.kind === "options" ? formatMoment(r.options[0]!.start!) : r.kind === "reply" ? r.text : r.question;
  };
  it("в понедельник 07:00 «каждый понедельник в 10» — сегодня", () => expect(first("каждый понедельник в 10", "2026-10-12T07:00")).toBe("2026-10-12T10:00"));
  it("в вс 23:50 — завтрашний понедельник", () => expect(first("каждый понедельник в 10", "2026-10-18T23:50")).toBe("2026-10-19T10:00"));
  it("в пт 23:30 «каждую пятницу в 18» — следующая пятница", () => expect(first("каждую пятницу в 18", "2026-10-16T23:30")).toBe("2026-10-23T18:00"));
  it("31 декабря 18:00 «каждый день в 9» — 1 января", () => expect(first("каждый день в 9", "2026-12-31T18:00")).toBe("2027-01-01T09:00"));
  it("28 февраля 12:00 «каждый день в 8 до 1 марта» — одна дата, 1 марта", () =>
    expect(first("каждый день в 8 до 1 марта", "2027-02-28T12:00")).toBe("2027-03-01T08:00"));
  it("31 декабря 18:00 «по будням в 9 до конца года» — дат нет (до сегодня, 9:00 прошло)", () =>
    expect(first("по будням в 9 до конца года", "2026-12-31T18:00")).toContain("ни одной даты"));
  it("в день перехода времени (Берлин, 01:30) «каждое воскресенье в 10» — сегодня", () =>
    expect(first("каждое воскресенье в 10", "2026-10-25T01:30", "Europe/Berlin")).toBe("2026-10-25T10:00"));
});

describe("withConversationDay — день разговора (US-60)", () => {
  const today = parseLocal("2026-10-10T10:00").day;
  it.each([
    ["в 12:30", "12.10.2026 в 12:30"],
    ["на 12.30", "12.10.2026 на 12.30"],
    ["к 9", "12.10.2026 к 9"],
    ["в 3 часа дня", "12.10.2026 в 3 часа дня"],
  ])("%s → %s", (point, want) => expect(withConversationDay(point, "2026-10-12", today)).toBe(want));
  it.each(["завтра в 12:30", "в пятницу в 15", "14 октября в 10", "через 2 часа", "через час", "вечером"])(
    "день назван или нет времени — %s как сказано",
    (point) => expect(withConversationDay(point, "2026-10-12", today)).toBeUndefined(),
  );
  it("день разговора в прошлом — обычные правила", () => expect(withConversationDay("в 12:30", "2026-10-09", today)).toBeUndefined());
  it("без дня разговора", () => expect(withConversationDay("в 12:30", undefined, today)).toBeUndefined());
});
