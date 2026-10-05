import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepTyping, TYPING_REFRESH_MS } from "../src/bot/typing";

describe("keepTyping", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("сразу и каждые ~4 с до stop()", () => {
    const send = vi.fn(() => Promise.resolve());
    const stop = keepTyping(send);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TYPING_REFRESH_MS * 2 + 100);
    expect(send).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(TYPING_REFRESH_MS * 5);
    expect(send).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ошибка отправки не рвёт обработку", async () => {
    const send = vi.fn(() => Promise.reject(new Error("telegram down")));
    const stop = keepTyping(send, 1000);
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    stop();
  });
});
