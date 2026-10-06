// Ближайшее «ЧЧ:ММ» по местному времени — время отправки утреннего дайджеста (US-70).

import { describe, expect, it } from "vitest";
import { nextDailyAt, nextWeeklyAt, parseHhmm } from "../src/dates/daily";

const iso = (ms: number) => new Date(ms).toISOString();

describe("nextDailyAt", () => {
  it.each([
    // сейчас (UTC), пояс, время → ближайший момент
    ["2026-10-07T07:00:00Z", "Europe/Moscow", "08:00", "2026-10-08T05:00:00.000Z"],
    ["2026-10-07T04:59:00Z", "Europe/Moscow", "08:00", "2026-10-07T05:00:00.000Z"],
    ["2026-10-07T05:00:00Z", "Europe/Moscow", "08:00", "2026-10-08T05:00:00.000Z"],
    ["2026-10-07T20:30:00Z", "Asia/Tbilisi", "07:30", "2026-10-08T03:30:00.000Z"],
    // Переход на зимнее время в Берлине 25 октября 2026: 08:00 — уже UTC+1
    ["2026-10-24T07:00:00Z", "Europe/Berlin", "08:00", "2026-10-25T07:00:00.000Z"],
    ["2026-10-23T07:00:00Z", "Europe/Berlin", "08:00", "2026-10-24T06:00:00.000Z"],
  ])("%s %s %s → %s", (now, tz, hhmm, want) => expect(iso(nextDailyAt(Date.parse(now), tz, parseHhmm(hhmm)!))).toBe(want));
});

describe("parseHhmm", () => {
  it.each([
    ["8", 480],
    ["08:00", 480],
    ["7.45", 465],
    ["23:59", 1439],
    ["24:00", undefined],
    ["7:60", undefined],
    ["утром", undefined],
  ])("%s → %s", (s, m) => expect(parseHhmm(s)).toBe(m));
});

describe("nextWeeklyAt", () => {
  // ср 7 октября 2026; 0 — пн, 6 — вс (US-70, «Неделя»)
  it.each([
    ["2026-10-07T07:00:00Z", "Europe/Moscow", 6, "20:00", "2026-10-11T17:00:00.000Z"],
    ["2026-10-07T07:00:00Z", "Europe/Moscow", 0, "08:00", "2026-10-12T05:00:00.000Z"],
    // Ровно в момент отправки — следующая неделя
    ["2026-10-11T17:00:00Z", "Europe/Moscow", 6, "20:00", "2026-10-18T17:00:00.000Z"],
    ["2026-10-12T04:00:00Z", "Europe/Moscow", 0, "08:00", "2026-10-12T05:00:00.000Z"],
  ])("%s %s день %i %s → %s", (now, tz, wd, hhmm, want) => expect(iso(nextWeeklyAt(Date.parse(now), tz, wd, parseHhmm(hhmm)!))).toBe(want));
});
