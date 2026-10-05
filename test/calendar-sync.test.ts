import { describe, expect, it } from "vitest";
import { pickDefaultCalendar } from "../src/calendar/sync";

describe("pickDefaultCalendar (tech-debt #19)", () => {
  const cals = [
    { id: "me@gmail.com", writable: true, primary: true },
    { id: "family", writable: true },
    { id: "holidays", writable: false },
  ];

  it("keeps the user's choice if the calendar is still there and writable", () => {
    expect(pickDefaultCalendar("family", cals)).toBe("family");
  });
  it("falls back to primary when the chosen calendar disappeared", () => {
    expect(pickDefaultCalendar("work", cals)).toBe("me@gmail.com");
  });
  it("falls back to primary when the chosen calendar became read-only", () => {
    expect(pickDefaultCalendar("holidays", cals)).toBe("me@gmail.com");
  });
  it("no previous choice — primary", () => {
    expect(pickDefaultCalendar(undefined, cals)).toBe("me@gmail.com");
  });
});
