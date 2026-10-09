import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseTimezoneCommand, tripUntil } from "../src/nlu/timezone-command";

const set = parseYaml(readFileSync(join(import.meta.dirname, "..", "testdata", "nlu", "timezone.yaml"), "utf8")) as {
  cases: { text: string; kind: string | null; tz?: string; until?: string }[];
};

describe("parseTimezoneCommand (US-07)", () => {
  it.each(set.cases.map((c) => [c.text, c] as const))("%s", (_t, c) => {
    const got = parseTimezoneCommand(c.text);
    if (c.kind === null) return expect(got).toBeNull();
    expect(got?.kind).toBe(c.kind);
    if (c.tz) expect(got && "tz" in got ? got.tz : undefined).toBe(c.tz);
    expect(got && "until" in got ? got.until : undefined).toBe(c.until);
  });
});

describe("tripUntil — день окончания поездки в её поясе", () => {
  const now = "2026-10-07T10:00"; // среда
  it.each([
    ["воскресенья", "2026-10-11"],
    ["пятницы", "2026-10-09"],
    ["15 октября", "2026-10-15"],
    ["конца недели", "2026-10-11"],
    ["Friday", "2026-10-09"],
    ["завтра", "2026-10-08"],
    ["на неделю", "2026-10-14"],
    ["на 3 дня", "2026-10-10"],
    ["for a week", "2026-10-14"],
    ["на месяц", "2026-11-07"],
  ])("%s → %s", (text, day) => expect(tripUntil(text, now, "Asia/Tbilisi")).toBe(day));

  it("не дата — нет", () => expect(tripUntil("ремонта", now, "Asia/Tbilisi")).toBeUndefined());
  it("прошлое — нет", () => expect(tripUntil("5 октября 2026", now, "Asia/Tbilisi")).toBeUndefined());
});
