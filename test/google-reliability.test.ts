// tech-debt #13: срок кеша access token Google и политика повтора GET (чистые функции).
import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_MARGIN_MS, accessTokenExpiresAt, accessTokenUsable } from "../src/google/token-cache";
import { isRetryableStatus, RETRY_POLICY, retryDelayMs } from "../src/net/retry";

const NOW = Date.parse("2026-10-07T07:00:00Z");
const MIN = 60_000;

describe("access token cache", () => {
  it("expiry from expires_in, default an hour when missing or bogus", () => {
    expect(accessTokenExpiresAt(NOW, 3599)).toBe(NOW + 3599_000);
    expect(accessTokenExpiresAt(NOW, undefined)).toBe(NOW + 3600_000);
    expect(accessTokenExpiresAt(NOW, 0)).toBe(NOW + 3600_000);
    expect(accessTokenExpiresAt(NOW, Number.NaN)).toBe(NOW + 3600_000);
  });

  it("usable until 5 minutes before expiry", () => {
    const exp = accessTokenExpiresAt(NOW, 3599);
    expect(ACCESS_TOKEN_MARGIN_MS).toBe(5 * MIN);
    expect(accessTokenUsable(exp, NOW)).toBe(true);
    expect(accessTokenUsable(exp, NOW + 50 * MIN)).toBe(true);
    expect(accessTokenUsable(exp, NOW + 55 * MIN)).toBe(false);
    expect(accessTokenUsable(exp, NOW + 61 * MIN)).toBe(false);
  });

  it("no expiry — not usable", () => {
    expect(accessTokenUsable(null, NOW)).toBe(false);
    expect(accessTokenUsable(undefined, NOW)).toBe(false);
  });
});

describe("GET retry policy", () => {
  it("retries only 429 and 5xx", () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [200, 304, 400, 401, 403, 404, 410, 412]) expect(isRetryableStatus(s)).toBe(false);
    expect(retryDelayMs(404, 10, null)).toBeNull();
  });

  it("short default backoff", () => {
    expect(retryDelayMs(503, 100, null)).toBe(RETRY_POLICY.baseDelayMs);
  });

  it("respects a short Retry-After, gives up on a long one", () => {
    expect(retryDelayMs(429, 100, "1")).toBe(1000);
    expect(retryDelayMs(429, 100, "30")).toBeNull();
    // Дата вместо секунд — не разбираем, обычная пауза
    expect(retryDelayMs(503, 100, "Wed, 21 Oct 2026 07:28:00 GMT")).toBe(RETRY_POLICY.baseDelayMs);
  });

  it("no retry once the time budget is spent", () => {
    expect(retryDelayMs(503, RETRY_POLICY.budgetMs - RETRY_POLICY.baseDelayMs, null)).toBe(RETRY_POLICY.baseDelayMs);
    expect(retryDelayMs(503, RETRY_POLICY.budgetMs, null)).toBeNull();
    // Первая попытка упёрлась в таймаут — повтор не влезет
    expect(retryDelayMs(503, 10_000, null)).toBeNull();
  });
});
