import { describe, expect, it } from "vitest";
import { durationToMinutes } from "../src/dates/duration";

describe("durationToMinutes", () => {
  it.each([
    ["PT1H30M", 90],
    ["+PT1H", 60],
    ["-PT30M", -30],
    ["P1D", 1440],
    ["-P2D", -2880],
    ["P7D", 10080],
  ] as const)("%s → %d", (iso, min) => expect(durationToMinutes(iso)).toBe(min));
  it.each(["P1M", "P1Y", "PT", "", "abc"])("%s → null", (iso) => expect(durationToMinutes(iso)).toBeNull());
});
