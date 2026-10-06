// Структурные логи (src/log.ts): одна строка JSON, класс ошибки без хвоста сообщения.

import { afterEach, describe, expect, it, vi } from "vitest";
import { errorClass, log, logged } from "../src/log";

afterEach(() => vi.restoreAllMocks());

describe("errorClass", () => {
  it.each<[unknown, string]>([
    [new Error("google 500: Backend Error"), "Error: google 500:"],
    [new Error("telegram sendMessage: Bad Request: chat not found"), "Error: telegram sendMessage: Bad Request:"],
    [new Error("Созвон с Петей: не найден"), "Error"],
    [new TypeError("x is undefined"), "TypeError"],
    ["string", "unknown"],
  ])("%s", (e, want) => {
    expect(errorClass(e)).toBe(want);
  });
});

describe("log", () => {
  it("one JSON line, undefined fields dropped, errors to stderr", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    log("tick", { jobs: 2, skipped: undefined });
    expect(out).toHaveBeenCalledWith('{"event":"tick","jobs":2}');
    await expect(logged("update", { update_id: 7 }, () => Promise.reject(new Error("llm 503: down")))).rejects.toThrow();
    expect(JSON.parse(err.mock.calls[0]![0] as string)).toMatchObject({ event: "update", update_id: 7, outcome: "error", error: "Error: llm 503:" });
    expect(await logged("update", { update_id: 8 }, async () => "processed")).toBe("processed");
    expect(JSON.parse(out.mock.calls[1]![0] as string)).toMatchObject({ event: "update", update_id: 8, outcome: "processed" });
  });
});
