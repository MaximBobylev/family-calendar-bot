// Только идемпотентные GET, один раз и в пределах бюджета: обработка апдейта живёт в waitUntil (≈30 с), повтор
// не должен её съесть.

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export const RETRY_POLICY = {
  baseDelayMs: 300,
  // Retry-After длиннее — не ждём: обработку повторит очередь
  maxDelayMs: 2_000,
  // Вместе с первой попыткой и паузой
  budgetMs: 4_000,
} as const;

export function retryDelayMs(status: number, elapsedMs: number, retryAfter: string | null, policy = RETRY_POLICY): number | null {
  if (!isRetryableStatus(status)) return null;
  const after = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : undefined;
  const delay = after ?? policy.baseDelayMs;
  if (delay > policy.maxDelayMs) return null;
  if (elapsedMs + delay > policy.budgetMs) return null;
  return delay;
}
