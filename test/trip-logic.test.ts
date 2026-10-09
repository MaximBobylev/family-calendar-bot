import { describe, expect, it } from "vitest";
import { TRIP_RECHECK_MS, tripCheckAt } from "../src/bot/trip-logic";

const at = (iso: string) => Date.parse(iso);

describe("tripCheckAt (US-07)", () => {
  const now = at("2026-10-07T07:00:00Z"); // ср 11:00 в Тбилиси
  it("день окончания — 18:00 по поясу поездки", () => expect(tripCheckAt(now, "Asia/Tbilisi", "2026-10-11")).toBe(at("2026-10-11T14:00:00Z")));
  it("окончание сегодня, 18:00 ещё впереди", () => expect(tripCheckAt(now, "Asia/Tbilisi", "2026-10-07")).toBe(at("2026-10-07T14:00:00Z")));
  it("день окончания прошёл — ближайшие 18:00", () =>
    expect(tripCheckAt(at("2026-10-07T15:00:00Z"), "Asia/Tbilisi", "2026-10-07")).toBe(at("2026-10-08T14:00:00Z")));
  it("без даты — через неделю", () => expect(tripCheckAt(now, "Asia/Tbilisi")).toBe(now + TRIP_RECHECK_MS));
});
