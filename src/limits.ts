// Лимиты расходов на пользователя (tech-debt #4) и оценка стоимости вызовов: чистая логика.
// Значения — в config.ts; счётчики — по usage_events (db/usage.ts).

export interface RateLimit {
  perHour: number;
  perDay: number;
}

export interface UsageLimits {
  llm: RateLimit;
  stt: RateLimit;
}

/** Цены, $: оценка по прайсу провайдера — для учёта, не для биллинга. */
export interface CostEstimates {
  llmInPerM: number;
  llmOutPerM: number;
  sttPerMin: number;
}

/** Вызовы пользователя этого вида: за последний час и за сутки, самые ранние в каждом окне. */
export interface UsageWindow {
  hourCount: number;
  hourOldest: number | null;
  dayCount: number;
  dayOldest: number | null;
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export type LimitVerdict = { ok: true } | { ok: false; window: "hour" | "day"; limit: number; retryInMs: number };

/**
 * Можно ли сделать ещё один вызов. Окна скользящие: час и сутки до `now`.
 * Когда снова можно — когда самый ранний вызов окна выйдет из него (лимит не превышается, значит освободится место).
 */
export function checkLimit(limit: RateLimit, usage: UsageWindow, now: number): LimitVerdict {
  if (usage.dayCount >= limit.perDay) {
    return { ok: false, window: "day", limit: limit.perDay, retryInMs: Math.max(0, (usage.dayOldest ?? now) + DAY_MS - now) };
  }
  if (usage.hourCount >= limit.perHour) {
    return { ok: false, window: "hour", limit: limit.perHour, retryInMs: Math.max(0, (usage.hourOldest ?? now) + HOUR_MS - now) };
  }
  return { ok: true };
}

/** Оценка стоимости вызова LLM, микродоллары. */
export function llmCostMicroUsd(c: CostEstimates, tokensIn: number, tokensOut: number): number {
  return Math.round(tokensIn * c.llmInPerM + tokensOut * c.llmOutPerM); // $ за 1M токенов = µ$ за токен
}

/** Оценка стоимости распознавания, микродоллары. */
export function sttCostMicroUsd(c: CostEstimates, audioMs: number): number {
  return Math.round((audioMs / 60_000) * c.sttPerMin * 1e6);
}
