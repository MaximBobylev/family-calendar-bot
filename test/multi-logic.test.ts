import { describe, expect, it } from "vitest";
import type { CalendarEvent, CalendarInfo } from "../src/calendar/model";
import { formatMoment, parseLocal } from "../src/dates/calendar";
import type { CreateEventIntent } from "../src/nlu/intents";
import {
  alignCalls,
  type BuildInput,
  buildItems,
  daysToCheck,
  markExisting,
  type MultiCardPayload,
  type MultiItem,
  mainButton,
  ordinalLead,
  toCreate,
  toggle,
} from "../src/bot/multi-logic";
import { splitMessage } from "../src/bot/multi-split";
import { multiCardButtons } from "../src/bot/multi-view";

// Понедельник, как в сценариях US-62.
const NOW = "2026-10-12T10:00";
const tz = "Europe/Moscow";
const cal: CalendarInfo = { id: "c1", accountId: "a1", providerCalendarId: "c1", title: "Иван", writable: true, isDefault: true, aliases: [] };
const call = (start: string, title?: string, extra: Partial<CreateEventIntent> = {}): CreateEventIntent => ({
  name: "create_event",
  start,
  ...(title ? { title } : {}),
  ...extra,
});

function build(text: string, calls: CreateEventIntent[] = [], extra: Partial<BuildInput> = {}) {
  const pieces = splitMessage(text, NOW, tz);
  const res = buildItems({
    pieces,
    calls: alignCalls(pieces, calls),
    families: pieces.map(() => ({ remove: [] })),
    now: parseLocal(NOW),
    tz,
    locale: "ru",
    durationMin: 60,
    calendars: [cal],
    ...extra,
  });
  if ("calendarError" in res) throw new Error(JSON.stringify(res));
  return res.items.map((b) => b.item);
}
const when = (it: MultiItem) => (it.option?.start ? formatMoment(it.option.start) : it.option ? `day ${it.option.startDay}` : `ask ${it.ask?.question}`);

describe("alignCalls", () => {
  const pieces = splitMessage("Запиши в пятницу в 10 стоматолог, а в субботу в 12 футбол у Вани", NOW, tz);

  it("пара по названию и по куску даты, лишний вызов отброшен", () => {
    const calls = [call("в пятницу в 10", "Стоматолог"), call("в субботу в 12", "Футбол"), call("завтра", "Лишнее")];
    expect(alignCalls(pieces, calls).map((c) => c?.title)).toEqual(["Стоматолог", "Футбол"]);
  });

  it("потерянный вызов — у второго куска пары нет", () => {
    expect(alignCalls(pieces, [call("в пятницу в 10", "Стоматолог")]).map((c) => c?.title)).toEqual(["Стоматолог", undefined]);
  });

  it("вызов про второе дело не достаётся первому", () => {
    expect(alignCalls(pieces, [call("в субботу в 12", "Футбол у Вани")]).map((c) => c?.title)).toEqual([undefined, "Футбол у Вани"]);
  });

  it("перечисление своей пары не получает — название у источника", () => {
    const enumPieces = splitMessage("В пятницу и в субботу в 10 футбол", NOW, tz);
    expect(alignCalls(enumPieces, [call("в пятницу в 10", "Футбол")]).map((c) => c?.title)).toEqual([undefined, "Футбол"]);
  });
});

describe("buildItems", () => {
  it("общий день: время без дня у второго дела — день первого", () => {
    const items = build("В пятницу встреча с Петей в 10 и созвон с Машей в 15", [call("в пятницу в 10", "Встреча с Петей")]);
    expect(items.map(when)).toEqual(["2026-10-16T10:00", "2026-10-16T15:00"]);
    expect(items.map((i) => i.title)).toEqual(["Встреча с Петей", "Созвон с Машей"]);
  });

  it("день разговора (US-60) — только для первой строки", () => {
    const items = build("В 12 обед и в 15 созвон", [], { conversationDay: "2026-10-14" });
    expect(items.map(when)).toEqual(["2026-10-14T12:00", "2026-10-14T15:00"]);
  });

  it("после серии общего дня нет", () => {
    const items = build("Каждый понедельник в 10 планёрка и в 15 ретро");
    expect(items[0]!.option?.series?.rrule).toContain("FREQ=WEEKLY");
    expect(items[1]!.option?.start?.day).not.toBe(items[0]!.option?.startDay);
  });

  it("день рождения без времени — на весь день, ежегодный флаг; со временем — разовое", () => {
    const items = build("Не забудь, у Пети день рождения 12 ноября, а у Маши — 3 декабря");
    expect(items.map((i) => [i.title, i.option?.allDay, i.birthday])).toEqual([
      ["День рождения Пети", true, true],
      ["День рождения Маши", true, true],
    ]);
    const timed = build("День рождения Пети в субботу в 15 и в воскресенье в 12 обед у бабушки");
    expect(timed[0]!.birthday).toBeUndefined();
    expect(timed[0]!.option?.allDay).toBe(false);
  });

  it("дубль внутри сообщения — одна строка", () => {
    const items = build("В пятницу в 10 стоматолог и в пятницу в 10 стоматолог");
    expect(items).toHaveLength(1);
  });

  it("дело без даты и неоднозначное время — строка без готового события", () => {
    expect(build("Завтра в 9 планёрка и ещё созвон с Олегом").map(when)).toEqual(["2026-10-13T09:00", "ask askTime"]);
    expect(build("В 10 встреча с Петей и в пятницу созвон в 15").map(when)).toEqual(["ask pick", "2026-10-16T15:00"]);
  });

  it("вопрос после создания: у дела без даты — день предыдущего, черновик без второго мнения LLM", () => {
    const [, olegItem] = build("Завтра в 9 планёрка и ещё созвон с Олегом", [call("завтра в 9", "Планёрка")]);
    expect(olegItem!.ask).toMatchObject({ question: "askTime", draft: { startText: "13.10.2026", title: "Созвон с Олегом" } });
    expect(olegItem!.ask?.day).toBe(parseLocal("2026-10-13T00:00").day);
    const [pick] = build("В 10 встреча с Петей и в пятницу созвон в 15");
    expect(pick!.ask?.options?.map((o) => formatMoment(o.start!))).toEqual(["2026-10-12T22:00", "2026-10-13T10:00"]);
    const [dayOnly] = build("В пятницу встреча с Петей и в субботу в 12 футбол");
    expect(dayOnly!.ask).toMatchObject({ question: "askTime", draft: { startText: "В пятницу" } });
  });

  it("пересланное: прошедшие от даты сообщения даты — строка «прошло»", () => {
    const items = build("Вчера в 10 собрание и завтра в 12 концерт", [], { refNow: parseLocal("2026-10-05T10:00") });
    expect(items.map(when)).toEqual(["ask inPast", "ask inPast"]);
  });

  describe("общий календарь и ответственный на все строки", () => {
    const family: CalendarInfo = { ...cal, id: "c2", providerCalendarId: "c2", title: "Семья", isDefault: false };
    const calOf = (text: string, calls: CreateEventIntent[] = []) => build(text, calls, { calendars: [cal, family] }).map((i) => i.option?.calendarTitle);

    it("«всё в семейный» в конце — для всех строк; без «всё» внутри первого дела — только для него", () => {
      expect(calOf("В пятницу в 10 стоматолог и в субботу в 12 футбол, всё в семейный календарь")).toEqual(["Семья", "Семья"]);
      expect(calOf("В пятницу в 10 стоматолог, в семейный, и в субботу в 12 футбол")).toEqual(["Иван", "Иван"]);
      expect(calOf("В пятницу в 10 стоматолог, в кафе, и в субботу в 12 футбол, в семейный")).toEqual(["Семья", "Семья"]);
    });

    it("единственный календарь из ответа LLM — и для строки без пары", () => {
      expect(calOf("В пятницу в 10 стоматолог и в субботу в 12 футбол", [call("в пятницу в 10", "Стоматолог", { calendar: "Семья" })])).toEqual([
        "Семья",
        "Семья",
      ]);
    });

    it("«отводит Дима на оба» — ответственный у всех; без «на оба» — только у своего дела", () => {
      const text = "В четверг в 16 стоматолог и в субботу в 10 плавание, отводит Дима на оба";
      const pieces = splitMessage(text, NOW, tz);
      const families = pieces.map((p) =>
        p.text.includes("Дима") ? { family: { responsibleUserId: "u2", responsibleName: "Дима" }, remove: ["отводит Дима"] } : { remove: [] },
      );
      const res = buildItems({ pieces, calls: [], families, now: parseLocal(NOW), tz, locale: "ru", durationMin: 60, calendars: [cal] });
      if ("calendarError" in res) throw new Error();
      expect(res.items.map((b) => b.item.family?.responsibleName)).toEqual(["Дима", "Дима"]);
      const own = splitMessage("В четверг в 16 стоматолог, отводит Дима, и в субботу в 10 плавание", NOW, tz);
      const ownRes = buildItems({
        pieces: own,
        calls: [],
        families: own.map((p) =>
          p.text.includes("Дима") ? { family: { responsibleUserId: "u2", responsibleName: "Дима" }, remove: ["отводит Дима"] } : { remove: [] },
        ),
        now: parseLocal(NOW),
        tz,
        locale: "ru",
        durationMin: 60,
        calendars: [cal],
      });
      if ("calendarError" in ownRes) throw new Error();
      expect(ownRes.items.map((b) => b.item.family?.responsibleName)).toEqual(["Дима", undefined]);
    });
  });

  it("неизвестный календарь — ошибка всей карточки", () => {
    const pieces = splitMessage("В пятницу в 10 стоматолог и в субботу в 12 футбол", NOW, tz);
    const res = buildItems({
      pieces,
      calls: alignCalls(pieces, [call("в пятницу в 10", "Стоматолог", { calendar: "Работа" })]),
      families: pieces.map(() => ({ remove: [] })),
      now: parseLocal(NOW),
      tz,
      locale: "ru",
      durationMin: 60,
      calendars: [cal],
    });
    expect(res).toEqual({ calendarError: { error: "notFound", name: "Работа" } });
  });
});

describe("markExisting — ⚠️ похожее и ⏰ пересечения", () => {
  const ev = (title: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => {
    const s0 = parseLocal(start);
    const e0 = parseLocal(end);
    return {
      ref: { accountId: "a1", calendarId: "c1", providerEventId: title },
      calendarTitle: "Иван",
      title,
      allDay: false,
      startDay: s0.day,
      endDay: e0.day,
      start: s0,
      end: e0,
      free: false,
      organizerIsSelf: true,
      hasOtherAttendees: false,
      recurring: false,
      ...extra,
    };
  };
  const items = () => build("В среду в 17 хор, в четверг в 18 сольфеджио, в субботу в 11 концерт");

  it("похожее название в тот же день рядом по времени — выключено; дальше 3 часов или другой календарь — нет", () => {
    const marked = markExisting(items(), [ev("Хор", "2026-10-14T17:00", "2026-10-14T18:00"), ev("Концерт", "2026-10-17T19:00", "2026-10-17T21:00")], "c1");
    expect(marked.map((i) => [i.sel, i.dup?.title])).toEqual([
      ["off", "Хор"],
      ["on", undefined],
      ["on", undefined],
    ]);
    const other = markExisting(
      items(),
      [ev("Хор", "2026-10-14T17:00", "2026-10-14T18:00", { ref: { accountId: "a1", calendarId: "c2", providerEventId: "x" } })],
      "c1",
    );
    expect(other[0]!.dup).toBeUndefined();
  });

  it("пересечение — строка включена, событие названо", () => {
    const marked = markExisting(
      items(),
      [ev("Созвон", "2026-10-15T18:30", "2026-10-15T19:00"), ev("Свободно", "2026-10-15T18:00", "2026-10-15T19:00", { free: true })],
      "c1",
    );
    expect(marked[1]!.sel).toBe("on");
    expect(marked[1]!.overlap?.map((o) => o.title)).toEqual(["Созвон"]);
  });

  it("дни для запроса — только готовые строки без серий", () => {
    expect(daysToCheck(build("Каждый понедельник в 10 планёрка и в среду в 15 ретро")).length).toBe(1);
  });
});

const payload = (n: number, extra: Partial<MultiCardPayload> = {}): MultiCardPayload => {
  const items = build("В пятницу в 10 стоматолог, а в субботу в 12 футбол, в воскресенье в 11 бассейн").slice(0, n);
  return { chatId: 1, items, ...extra };
};

describe("переключатели и главная кнопка", () => {
  it("все отмечены — «Создать все», часть — «выбранные», ничего — 0", () => {
    const p = payload(3);
    expect(mainButton(p)).toEqual({ key: "multiCreateAll", n: 3 });
    const one = toggle(p, "t1")!;
    expect(one.items[1]!.sel).toBe("off");
    expect(mainButton(one)).toEqual({ key: "multiCreateSelected", n: 2 });
    const none = toggle(toggle(one, "t0")!, "t2")!;
    expect(mainButton(none)).toEqual({ key: "multiCreateSelected", n: 0 });
    expect(toCreate(none)).toEqual([]);
  });

  it("строку без готового события и созданную не переключить; «каждый год» — только при днях рождения", () => {
    const p = payload(2);
    expect(toggle(p, "t5")).toBeNull();
    expect(toggle(p, "y")).toBeNull();
    const created = { ...p, items: p.items.map((it, i) => (i === 0 ? { ...it, done: { failed: true as const } } : it)) };
    expect(toggle(created, "t0")).toBeNull();
    const bd = { ...p, items: p.items.map((it) => ({ ...it, birthday: true as const })), yearly: true };
    expect(toggle(bd, "y")?.yearly).toBe(false);
  });

  it("10 строк: callback_data ≤ 64 байт, payload ≤ 16 КБ", () => {
    const one = payload(1).items[0]!;
    const items = Array.from({ length: 10 }, (_, i) => ({ ...one, title: `Очень длинное название события номер ${i}` }));
    const p: MultiCardPayload = { chatId: 123456789, items, yearly: true, forwardedFrom: "Хор, 3 класс" };
    const data = multiCardButtons(p, "0123456789abcdef", "ru")
      .flat()
      .map((b) => b.callback_data!);
    expect(Math.max(...data.map((d) => new TextEncoder().encode(d).length))).toBeLessThanOrEqual(64);
    expect(new TextEncoder().encode(JSON.stringify(p)).length).toBeLessThan(16 * 1024);
  });
});

describe("ordinalLead", () => {
  it.each([
    ["второе — в 13", true],
    ["2-е на субботу", true],
    ["первое убери", true],
    ["а третье в общий", true],
    ["first one at 5", true],
    ["номер 2 в 16", true],
    ["вторник в 10 футбол", false],
    ["пятница футбол", false],
    ["четверг", false],
    ["2 ноября футбол", false],
    ["третьего ноября ДР у Пети", false],
    ["Поставь второе занятие на пятницу", false],
  ] as const)("%s → %s", (text, want) => {
    expect(ordinalLead(text)).toBe(want);
  });
});
