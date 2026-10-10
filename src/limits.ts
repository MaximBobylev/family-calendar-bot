// Лимиты вызовов на пользователя (tech-debt #4) и оценка стоимости — без D1; значения в config.ts, счётчики в db/usage.ts.

export interface RateLimit {
  perHour: number;
  perDay: number;
}

export interface UsageLimits {
  llm: RateLimit;
  stt: RateLimit;
}

/** $, оценка по прайсу — для учёта, не для биллинга. */
export interface CostEstimates {
  llmInPerM: number;
  llmOutPerM: number;
  sttPerMin: number;
}

export interface UsageWindow {
  hourCount: number;
  hourOldest: number | null;
  dayCount: number;
  dayOldest: number | null;
}

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export type LimitVerdict = { ok: true } | { ok: false; window: "hour" | "day"; limit: number; retryInMs: number };

/** Окна скользящие: снова можно, когда самый ранний вызов окна выйдет из него. */
export function checkLimit(limit: RateLimit, usage: UsageWindow, now: number): LimitVerdict {
  if (usage.dayCount >= limit.perDay) {
    return { ok: false, window: "day", limit: limit.perDay, retryInMs: Math.max(0, (usage.dayOldest ?? now) + DAY_MS - now) };
  }
  if (usage.hourCount >= limit.perHour) {
    return { ok: false, window: "hour", limit: limit.perHour, retryInMs: Math.max(0, (usage.hourOldest ?? now) + HOUR_MS - now) };
  }
  return { ok: true };
}

export function llmCostMicroUsd(c: CostEstimates, tokensIn: number, tokensOut: number): number {
  return Math.round(tokensIn * c.llmInPerM + tokensOut * c.llmOutPerM); // $ за 1M токенов = µ$ за токен
}

export function sttCostMicroUsd(c: CostEstimates, audioMs: number): number {
  return Math.round((audioMs / MINUTE_MS) * c.sttPerMin * 1e6);
}
