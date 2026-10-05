// Админка: маскирование журнала и заготовки «В тест» (src/admin/mask.ts, src/admin/yaml-snippet.ts) — чистые функции.

import { describe, expect, it } from "vitest";
import { intentOf, maskError, maskResult, maskText, pseudonym, pseudonymKey } from "../src/admin/mask";
import { datesSnippet, extractSnippet, flow, localNow, replay } from "../src/admin/yaml-snippet";

const NOW = "2026-10-07T10:00";
const TZ = "Europe/Moscow";

describe("maskText", () => {
  it.each([
    ["Созвон с Петей завтра в 15:30 на полчаса", "▒▒▒▒▒▒ ▒ ▒▒▒▒▒ завтра в 15:30 на полчаса"],
    ["Что у меня завтра?", "▒▒▒ ▒ ▒▒▒▒ завтра?"],
    ["Позвонить Ане", "▒▒▒▒▒▒▒▒▒ ▒▒▒"],
    ["Dentist tomorrow at 9.30pm", "▒▒▒▒▒▒▒ tomorrow at 9.30pm"],
    ["  «Пётр» — в пятницу  ", "  «▒▒▒▒» — в пятницу  "],
  ])("%s", (text, masked) => {
    expect(maskText(text, NOW, TZ)).toBe(masked);
  });

  it("keeps length and spacing", () => {
    const text = "Встреча с Машей\nв пятницу";
    expect(maskText(text, NOW, TZ)).toHaveLength(text.length);
  });
});

describe("maskResult", () => {
  it("keeps intent and enums, masks titles but not dates", () => {
    const json = JSON.stringify({ name: "create_event", start: "завтра в 15:30", title: "Созвон с Петей", allDay: false });
    expect(JSON.parse(maskResult(json, NOW, TZ))).toEqual({ name: "create_event", start: "завтра в 15:30", title: "▒▒▒▒▒▒ ▒ ▒▒▒▒▒", allDay: false });
  });

  it("masks error strings", () => {
    expect(maskResult(JSON.stringify("Error: llm: Петя"), NOW, TZ)).toBe(JSON.stringify("Error: llm: ▒▒▒▒"));
  });

  it("intentOf", () => {
    expect(intentOf('{"name":"list_events","range":"завтра"}')).toBe("list_events");
    expect(intentOf('"Error: x"')).toBeNull();
    expect(intentOf(null)).toBeNull();
  });
});

describe("maskError", () => {
  it("keeps error class and short codes, masks the rest", () => {
    expect(maskError("telegram sendMessage: Bad Request: chat not found")).toBe("telegram sendMessage: Bad Request: ▒▒▒▒ ▒▒▒ ▒▒▒▒▒");
    expect(maskError("google 403 для Пети")).toBe("▒▒▒▒▒▒ 403 ▒▒▒ ▒▒▒▒");
    expect(maskError(null)).toBe("");
  });

  it("truncates long errors", () => {
    expect(maskError("x".repeat(500))).toHaveLength(301);
  });
});

describe("pseudonym", () => {
  it("is stable, short and depends on the key", async () => {
    const k1 = await pseudonymKey("secret-1");
    const k2 = await pseudonymKey("secret-2");
    const a = await pseudonym(k1, "user-a");
    expect(a).toMatch(/^u-[0-9a-f]{6}$/);
    expect(await pseudonym(k1, "user-a")).toBe(a);
    expect(await pseudonym(k1, "user-b")).not.toBe(a);
    expect(await pseudonym(k2, "user-a")).not.toBe(a);
  });
});

describe("«В тест»", () => {
  const now = localNow(Date.parse("2026-10-07T07:00:00Z"), TZ);

  it("localNow: user's wall clock", () => {
    expect(now).toEqual({ now: NOW, tz: TZ });
    expect(localNow(0, "Not/AZone")).toEqual({ now: "1970-01-01T00:00", tz: "UTC" });
  });

  it("flow", () => {
    expect(flow({ datetime: "2026-10-08T15:30" })).toBe('{ datetime: "2026-10-08T15:30" }');
    expect(flow({ error: "in_past" })).toBe("{ error: in_past }");
    expect(flow({ recurrence: { freq: "weekly", by_day: ["MO"] } })).toBe('{ recurrence: { freq: weekly, by_day: ["MO"] } }');
    expect(flow({})).toBe("{}");
  });

  it("dates snippet: one case per fragment, expectation = current parse", () => {
    const r = replay("Созвон с Петей завтра в 15:30 на полчаса", now.now, now.tz, "create_event");
    expect(datesSnippet(r, now.now, now.tz, "adm-1")).toContain(
      ["- id: adm-1-1", '  text: "завтра в 15:30"', "  kind: point", `  now: "${NOW}"`, `  tz: ${TZ}`, '  expect: { datetime: "2026-10-08T15:30" }'].join("\n"),
    );
    expect(datesSnippet(replay("Позвонить Ане", NOW, TZ, null), NOW, TZ, "x")).toContain("заготовки нет");
  });

  it("list_events extracts a range", () => {
    const r = replay("Что у меня завтра?", NOW, TZ, "list_events");
    expect(r.kind).toBe("range");
    expect(extractSnippet(r, "▒▒▒ ▒ ▒▒▒▒ завтра?", NOW, TZ, false)).toContain('- { kind: range, text: "▒▒▒ ▒ ▒▒▒▒ завтра?", expect: { range: "завтра" } }');
  });
});
