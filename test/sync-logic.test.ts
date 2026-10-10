import { describe, expect, it } from "vitest";
import {
  deliveryPlan,
  diffEvent,
  inNotifyWindow,
  noticeText,
  quietUntil,
  reminderFireAt,
  reminderText,
  snapshotOf,
  summaryText,
  timeOf,
  type Notice,
  type SourceEvent,
} from "../src/sync/logic";

// Среда, как в приёмочных сценариях
const NOW = Date.parse("2026-10-07T07:00:00Z");
const TZ = "Europe/Moscow";

const ev = (over: Partial<SourceEvent> = {}): SourceEvent => ({
  id: "f1",
  summary: "Ужин у мамы",
  start: { dateTime: "2026-10-09T18:00:00+03:00" },
  end: { dateTime: "2026-10-09T20:00:00+03:00" },
  etag: '"1"',
  ...over,
});

describe("snapshotOf", () => {
  it("событие со временем, организатор не я, отказ", () => {
    const s = snapshotOf(
      ev({
        organizer: { self: false, displayName: "Школа №5" },
        attendees: [{ self: true, responseStatus: "declined" }],
        hangoutLink: "https://meet.google.com/x",
      }),
    );
    expect(s).toMatchObject({
      eventId: "f1",
      status: "confirmed",
      allDay: false,
      startMs: Date.parse("2026-10-09T15:00:00Z"),
      organizer: "Школа №5",
      declined: true,
      conferenceUrl: "https://meet.google.com/x",
    });
  });

  it("весь день — даты; скрытые типы — как удалённые", () => {
    expect(snapshotOf(ev({ start: { date: "2026-10-08" }, end: { date: "2026-10-09" } }))).toMatchObject({
      allDay: true,
      startDate: "2026-10-08",
      endDate: "2026-10-09",
    });
    expect(snapshotOf(ev({ eventType: "workingLocation" })).status).toBe("cancelled");
  });
});

describe("diffEvent", () => {
  const base = snapshotOf(ev());
  it("создание, перенос, отмена", () => {
    expect(diffEvent(null, base)).toBe("created");
    expect(diffEvent(base, snapshotOf(ev({ start: { dateTime: "2026-10-10T19:00:00+03:00" }, etag: '"2"' })))).toBe("moved");
    expect(diffEvent(base, null)).toBe("cancelled");
    expect(diffEvent(base, snapshotOf(ev({ status: "cancelled" })))).toBe("cancelled");
  });

  it("название, место, длительность — не сообщаем", () => {
    expect(diffEvent(base, snapshotOf(ev({ summary: "Ужин у бабушки", location: "Дом" })))).toBeNull();
    expect(diffEvent(base, snapshotOf(ev({ end: { dateTime: "2026-10-09T21:00:00+03:00" } })))).toBeNull();
    expect(diffEvent(null, null)).toBeNull();
  });
});

describe("окно, тихие часы, пачка", () => {
  it("только будущее в 30 днях; перенос из окна — сообщаем", () => {
    expect(inNotifyWindow([{ allDay: false, startMs: NOW + 3_600_000 }], NOW)).toBe(true);
    expect(inNotifyWindow([{ allDay: false, startMs: NOW - 3_600_000 }], NOW)).toBe(false);
    expect(inNotifyWindow([{ allDay: false, startMs: NOW + 40 * 86_400_000 }], NOW)).toBe(false);
    expect(
      inNotifyWindow(
        [
          { allDay: false, startMs: NOW + 40 * 86_400_000 },
          { allDay: false, startMs: NOW + 86_400_000 },
        ],
        NOW,
      ),
    ).toBe(true);
    // Весь день «сегодня»: начало (полночь UTC) уже прошло, но событие ещё идёт
    expect(inNotifyWindow([{ allDay: true, startMs: Date.parse("2026-10-07T00:00:00Z") }], NOW)).toBe(true);
  });

  it("тихие часы 23:00–08:00 по поясу получателя", () => {
    expect(quietUntil(NOW, TZ)).toBeNull();
    expect(quietUntil(Date.parse("2026-10-07T20:00:00Z"), TZ)).toBe(Date.parse("2026-10-08T05:00:00Z"));
    expect(quietUntil(Date.parse("2026-10-08T04:59:00Z"), TZ)).toBe(Date.parse("2026-10-08T05:00:00Z"));
    expect(quietUntil(Date.parse("2026-10-08T05:00:00Z"), TZ)).toBeNull();
  });

  it("сводка: больше трёх разом или вместе с недавними", () => {
    expect(deliveryPlan(1, 0)).toBe("single");
    expect(deliveryPlan(3, 0)).toBe("single");
    expect(deliveryPlan(4, 0)).toBe("summary");
    expect(deliveryPlan(2, 2)).toBe("summary");
    expect(deliveryPlan(1, 5)).toBe("single");
  });
});

describe("тексты", () => {
  const before = snapshotOf(ev());
  const after = snapshotOf(ev({ start: { dateTime: "2026-10-10T19:00:00+03:00" }, end: { dateTime: "2026-10-10T21:00:00+03:00" } }));
  const notice: Notice = { kind: "moved", title: "Ужин у мамы", time: timeOf(after), before: timeOf(before), author: "Максим", locale: "ru", tz: TZ };

  it("перенос с прежним временем и автором", () => {
    expect(noticeText(notice, NOW)).toBe("🔁 Перенесено: «Ужин у мамы» — сб, 10 октября, 19:00–21:00 (было пт, 9 октября, 18:00)\n👤 Максим");
  });

  it("в тот же день — «было» без даты; EN", () => {
    const sameDay = { ...notice, time: timeOf(snapshotOf(ev({ start: { dateTime: "2026-10-09T19:00:00+03:00" } }))), author: undefined } as Notice;
    expect(noticeText(sameDay, NOW)).toContain("(было 18:00)");
    expect(noticeText({ ...notice, locale: "en" }, NOW)).toContain("🔁 Moved: “Ужин у мамы”");
  });

  it("сводка", () => {
    const text = summaryText([notice, { ...notice, kind: "cancelled", author: undefined, before: undefined }], NOW);
    expect(text.split("\n")).toEqual([
      "📋 Изменения в календаре (2):",
      "• 🔁 Перенесено: «Ужин у мамы» — сб, 10 октября, 19:00–21:00 (было пт, 9 октября, 18:00) — Максим",
      "• ❌ Отменено: «Ужин у мамы» — сб, 10 октября, 19:00–21:00",
    ]);
  });

  it("напоминание: за N минут до начала, не для весь день/отклонённых/отменённых", () => {
    const s = snapshotOf(ev({ location: "Дом", hangoutLink: "https://meet.google.com/x" }));
    expect(reminderFireAt(s, 10)).toBe(Date.parse("2026-10-09T14:50:00Z"));
    expect(reminderFireAt(snapshotOf(ev({ start: { date: "2026-10-09" }, end: { date: "2026-10-10" } })), 10)).toBeNull();
    expect(reminderFireAt(snapshotOf(ev({ attendees: [{ self: true, responseStatus: "declined" }] })), 10)).toBeNull();
    expect(reminderFireAt(snapshotOf(ev({ status: "cancelled" })), 10)).toBeNull();
    expect(reminderText(s, 10, "ru", TZ, NOW)).toBe("⏰ Через 10 мин: <b>Ужин у мамы</b>\n🕒 пт, 9 октября, 18:00–20:00\n📍 Дом\n🔗 https://meet.google.com/x");
  });
});
