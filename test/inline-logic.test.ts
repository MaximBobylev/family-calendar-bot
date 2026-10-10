import { describe, expect, it } from "vitest";
import {
  addStartLink,
  buildIcs,
  foldIcsLine,
  googleTemplateUrl,
  inlineCallbackData,
  inlineCardText,
  inlineResultTitle,
  parseAddStart,
  parseInlineCallback,
  parseInlineQuery,
  titleEmoji,
  utcOffsetLabel,
  type InlineEvent,
} from "../src/bot/inline/logic";
import { makeDay } from "../src/dates/calendar";

// Среда, как в приёмочных сценариях
const NOW = Date.parse("2026-10-07T07:00:00Z");
const MSK = "Europe/Moscow";
const TODAY = makeDay(2026, 10, 7);
const TEMPLATE = "https://calendar.google.com/calendar/render";
const TOKEN = "0123456789abcdef0123";

const football: InlineEvent = {
  title: "Футбол",
  allDay: false,
  start: Date.parse("2026-10-08T16:00:00Z"),
  end: Date.parse("2026-10-08T17:00:00Z"),
  tz: MSK,
  locale: "ru",
};

describe("parseInlineQuery", () => {
  it("дата и время из текста, название — остальное", () => {
    expect(parseInlineQuery("завтра 19:00 футбол", NOW, MSK, 60, "ru")).toEqual([football]);
    expect(parseInlineQuery("футбол завтра в 19", NOW, MSK, 60, "ru")).toEqual([football]);
  });

  it("длительность из текста и по умолчанию", () => {
    const [e] = parseInlineQuery("завтра в 19 футбол на 2 часа", NOW, MSK, 60, "ru");
    expect(e?.end).toBe(Date.parse("2026-10-08T18:00:00Z"));
    const [d] = parseInlineQuery("завтра в 19 кино", NOW, MSK, 90, "ru");
    expect(d?.end).toBe(Date.parse("2026-10-08T17:30:00Z"));
  });

  it("только дата — на весь день", () => {
    expect(parseInlineQuery("день рождения Маши 10 октября", NOW, MSK, 60, "ru")).toEqual([
      { title: "День рождения Маши", allDay: true, startDate: "2026-10-10", endDate: "2026-10-10", tz: MSK, locale: "ru" },
    ]);
  });

  it("без даты, пустой запрос, прошлое — нечего предложить", () => {
    expect(parseInlineQuery("футбол", NOW, MSK, 60, "ru")).toEqual([]);
    expect(parseInlineQuery("  ", NOW, MSK, 60, "ru")).toEqual([]);
    expect(parseInlineQuery("вчера в 19 футбол", NOW, MSK, 60, "ru")).toEqual([]);
  });

  it("без названия — название по умолчанию", () => {
    expect(parseInlineQuery("завтра в 19", NOW, MSK, 60, "ru")[0]?.title).toBe("Встреча");
  });
});

describe("карточка", () => {
  it("заголовок результата — относительно сейчас, текст карточки — абсолютный", () => {
    expect(inlineResultTitle(football, NOW)).toBe("⚽ Футбол — завтра, 19:00");
    const text = inlineCardText(football, TODAY);
    expect(text).toContain("⚽ <b>Футбол</b>");
    expect(text).toContain("чт, 8 октября, 19:00–20:00 (UTC+3)");
    expect(text).not.toContain("Добавили");
    expect(inlineCardText(football, TODAY, 3)).toContain("✅ Добавили себе: 3");
  });

  it("HTML в названии экранируется", () => {
    expect(inlineCardText({ ...football, title: "A<b>" }, TODAY)).toContain("A&lt;b&gt;");
  });

  it("значок по названию", () => {
    expect(titleEmoji("Футбол во дворе")).toBe("⚽");
    expect(titleEmoji("ДР бабушки")).toBe("🎂");
    expect(titleEmoji("Совещание")).toBe("📅");
  });

  it("смещение пояса", () => {
    expect(utcOffsetLabel(NOW, MSK)).toBe("UTC+3");
    expect(utcOffsetLabel(NOW, "UTC")).toBe("UTC");
    expect(utcOffsetLabel(NOW, "Asia/Kolkata")).toBe("UTC+5:30");
    expect(utcOffsetLabel(NOW, "America/New_York")).toBe("UTC-4");
  });
});

describe("ссылка-шаблон Google Calendar", () => {
  it("событие со временем — UTC", () => {
    const url = new URL(googleTemplateUrl(TEMPLATE, { ...football, location: "Стадион" }));
    expect(url.origin + url.pathname).toBe(TEMPLATE);
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Футбол");
    expect(url.searchParams.get("dates")).toBe("20261008T160000Z/20261008T170000Z");
    expect(url.searchParams.get("ctz")).toBe(MSK);
    expect(url.searchParams.get("location")).toBe("Стадион");
  });

  it("весь день — конец не включается", () => {
    const e: InlineEvent = { title: "Отпуск", allDay: true, startDate: "2026-10-30", endDate: "2026-11-01", tz: MSK, locale: "ru" };
    expect(new URL(googleTemplateUrl(TEMPLATE, e)).searchParams.get("dates")).toBe("20261030/20261102");
  });
});

describe(".ics", () => {
  it("VCALENDAR с одним событием, CRLF, экранирование", () => {
    const ics = buildIcs({ ...football, title: "Футбол; потом, пиво", location: "Парк" }, `${TOKEN}@bot`, NOW);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain(`UID:${TOKEN}@bot\r\n`);
    expect(ics).toContain("DTSTAMP:20261007T070000Z\r\n");
    expect(ics).toContain("DTSTART:20261008T160000Z\r\nDTEND:20261008T170000Z\r\n");
    expect(ics).toContain("SUMMARY:Футбол\\; потом\\, пиво\r\n");
    expect(ics).toContain("LOCATION:Парк\r\n");
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("весь день — VALUE=DATE", () => {
    const ics = buildIcs({ title: "ДР", allDay: true, startDate: "2026-10-10", endDate: "2026-10-10", tz: MSK, locale: "ru" }, "x@bot", NOW);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261010\r\nDTEND;VALUE=DATE:20261011\r\n");
  });

  it("длинные строки переносятся по 75 октетов, не разрывая символы", () => {
    const line = `SUMMARY:${"Ж".repeat(60)}`;
    const folded = foldIcsLine(line);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join("")).toBe(line);
  });
});

describe("токены в Telegram", () => {
  it("callback_data и deep link", () => {
    expect(parseInlineCallback(inlineCallbackData(TOKEN))).toBe(TOKEN);
    expect(parseInlineCallback("pa:abc:c0")).toBeNull();
    expect(inlineCallbackData(TOKEN).length).toBeLessThanOrEqual(64);
    expect(addStartLink("cab_test_bot", TOKEN)).toBe(`https://t.me/cab_test_bot?start=add_${TOKEN}`);
    expect(parseAddStart(`/start add_${TOKEN}`)).toBe(TOKEN);
    expect(parseAddStart("/start")).toBeNull();
    expect(parseAddStart("/start home_abc")).toBeNull();
  });
});
