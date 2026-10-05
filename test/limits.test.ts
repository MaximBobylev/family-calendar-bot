import { describe, expect, it } from "vitest";
import { checkLimit, DAY_MS, HOUR_MS, llmCostMicroUsd, sttCostMicroUsd } from "../src/limits";

const limit = { perHour: 60, perDay: 300 };
const now = Date.parse("2026-10-07T12:00:00Z");

describe("checkLimit (tech-debt #4)", () => {
  it("under both limits", () => {
    expect(checkLimit(limit, { hourCount: 59, hourOldest: now - 1000, dayCount: 299, dayOldest: now - HOUR_MS * 5 }, now)).toEqual({ ok: true });
  });
  it("no usage", () => {
    expect(checkLimit(limit, { hourCount: 0, hourOldest: null, dayCount: 0, dayOldest: null }, now)).toEqual({ ok: true });
  });
  it("hourly limit: retry when the oldest call leaves the hour", () => {
    expect(checkLimit(limit, { hourCount: 60, hourOldest: now - 40 * 60_000, dayCount: 60, dayOldest: now - 40 * 60_000 }, now)).toEqual({
      ok: false,
      window: "hour",
      limit: 60,
      retryInMs: 20 * 60_000,
    });
  });
  it("daily limit wins over hourly", () => {
    expect(checkLimit(limit, { hourCount: 60, hourOldest: now - 1000, dayCount: 300, dayOldest: now - DAY_MS + HOUR_MS * 3 }, now)).toEqual({
      ok: false,
      window: "day",
      limit: 300,
      retryInMs: HOUR_MS * 3,
    });
  });
});

describe("cost estimates", () => {
  const costs = { llmInPerM: 0.051, llmOutPerM: 0.335, sttPerMin: 0.0005 };
  it("LLM: $ per 1M tokens → µ$", () => {
    expect(llmCostMicroUsd(costs, 1000, 20)).toBe(58);
    expect(llmCostMicroUsd(costs, 0, 0)).toBe(0);
  });
  it("STT: per audio minute", () => {
    expect(sttCostMicroUsd(costs, 60_000)).toBe(500);
    expect(sttCostMicroUsd(costs, 3_000)).toBe(25);
  });
});
