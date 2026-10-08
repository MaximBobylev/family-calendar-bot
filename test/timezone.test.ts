// Разбор часового пояса из /settings → «Другой…».

import { describe, expect, it } from "vitest";
import { parseTimeZone } from "../src/dates/timezone";
import { namedZone } from "../src/dates/zone";

describe("parseTimeZone", () => {
  it.each([
    ["Europe/Berlin", "Europe/Berlin"],
    ["asia/tbilisi", "Asia/Tbilisi"],
    ["UTC+4", "Etc/GMT-4"],
    ["GMT-3", "Etc/GMT+3"],
    ["+3", "Etc/GMT-3"],
    ["UTC", "UTC"],
    ["utc+0", "UTC"],
    ["Тбилиси", "Asia/Tbilisi"],
    ["Mars/Olympus", undefined],
    ["UTC+15", undefined],
    ["что у меня завтра", undefined],
    ["", undefined],
  ])("%s → %s", (input, tz) => expect(parseTimeZone(input)).toBe(tz));
});

it("keeps three-part zones (canonical name)", () => expect(parseTimeZone("America/Argentina/Buenos_Aires")).toMatch(/Buenos_Aires$/));

describe("namedZone — пояс во фрагменте даты (tech-debt #26)", () => {
  it.each([
    ["в 15:00 по Киеву", { tz: "Europe/Kiev", ru: "по Киеву", en: "Kyiv time" }],
    ["в 15 по киевскому времени", { tz: "Europe/Kiev", ru: "по Киеву", en: "Kyiv time" }],
    ["в 15 по времени Минска", { tz: "Europe/Minsk", ru: "по Минску", en: "Minsk time" }],
    ["at 9am New York time", { tz: "America/New_York", ru: "по Нью-Йорку", en: "New York time" }],
    ["в 12 по UTC+4", { tz: "Etc/GMT-4", ru: "по UTC+4", en: "UTC+4" }],
    ["в 12 мск", { tz: "Europe/Moscow", ru: "по Москве", en: "Moscow time" }],
  ])("%s", (text, zone) => expect(namedZone(text)).toEqual(zone));

  it.each(["в 15 по местному времени", "в 15", "Nobu London в 20", "в 15 по Варне"])("%s — нет", (text) => expect(namedZone(text)).toBeUndefined());
});
