// Разбор часового пояса из /settings → «Другой…».

import { describe, expect, it } from "vitest";
import { parseTimeZone } from "../src/dates/timezone";

describe("parseTimeZone", () => {
  it.each([
    ["Europe/Berlin", "Europe/Berlin"], ["asia/tbilisi", "Asia/Tbilisi"],
    ["UTC+4", "Etc/GMT-4"], ["GMT-3", "Etc/GMT+3"], ["+3", "Etc/GMT-3"], ["UTC", "UTC"], ["utc+0", "UTC"], ["Тбилиси", "Asia/Tbilisi"],
    ["Mars/Olympus", undefined], ["UTC+15", undefined], ["что у меня завтра", undefined], ["", undefined],
  ])("%s → %s", (input, tz) => expect(parseTimeZone(input)).toBe(tz));
});

it("keeps three-part zones (canonical name)", () => expect(parseTimeZone("America/Argentina/Buenos_Aires")).toMatch(/Buenos_Aires$/));
