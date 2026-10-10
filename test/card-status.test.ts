import { describe, expect, it } from "vitest";
import { CARD_STALE_MS, cardVerdict } from "../src/db/card-status";

const NOW = 1_000_000_000;
const row = (status: string, claimedAgoMs: number | null, expiresInMs = 10 * 60 * 1000) => ({
  status,
  claimedAt: claimedAgoMs === null ? null : NOW - claimedAgoMs,
  expiresAt: NOW + expiresInMs,
});

describe("cardVerdict", () => {
  it("нет карточки — устарела", () => expect(cardVerdict(null, NOW, true)).toBe("stale"));
  it("выполняется только что — подождать, не повторять", () => {
    expect(cardVerdict(row("executing", 5_000), NOW, true)).toBe("inProgress");
    expect(cardVerdict(row("executing", CARD_STALE_MS - 1), NOW, false)).toBe("inProgress");
  });
  it("брошена посреди действия — идемпотентную повторить", () => {
    expect(cardVerdict(row("executing", CARD_STALE_MS), NOW, true)).toBe("retry");
    expect(cardVerdict(row("executing", null), NOW, true)).toBe("retry");
  });
  it("брошена, повтор небезопасен — не завершилось", () => expect(cardVerdict(row("executing", CARD_STALE_MS * 2), NOW, false)).toBe("abandoned"));
  it("брошена и истекла — не доводим", () => expect(cardVerdict(row("executing", CARD_STALE_MS * 2, -1), NOW, true)).toBe("abandoned"));
  it("сбой обработан — не выполнено, а не «Уже сделано»", () => expect(cardVerdict(row("failed", 1_000), NOW, true)).toBe("notCompleted"));
  it("выполнена — уже сделано", () => expect(cardVerdict(row("done", 1_000), NOW, true)).toBe("done"));
  it("отменена новой командой или истекла — устарела", () => {
    expect(cardVerdict(row("cancelled", null), NOW, true)).toBe("stale");
    expect(cardVerdict(row("open", null, -1), NOW, true)).toBe("stale");
  });
});
