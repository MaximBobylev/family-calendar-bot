import { describe, expect, it } from "vitest";
import type { CalendarInfo } from "../src/calendar/model";
import { formatMoment, parseLocal } from "../src/dates/calendar";
import type { CreateEventIntent } from "../src/nlu/intents";
import {
  alignCalls,
  type BuildInput,
  buildItems,
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

  it("пересланное: прошедшие от даты сообщения даты — строка «прошло»", () => {
    const items = build("Вчера в 10 собрание и завтра в 12 концерт", [], { refNow: parseLocal("2026-10-05T10:00") });
    expect(items.map(when)).toEqual(["ask inPast", "ask inPast"]);
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
