// Повтор идемпотентных GET к внешнему API (tech-debt #13): один раз, коротко, в пределах бюджета времени —
// обработка апдейта живёт в waitUntil (≈30 с), повтор не должен её съесть.

/** Ответы, после которых повтор имеет смысл: перегрузка и временные сбои сервера. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export const RETRY_POLICY = {
  /** Пауза перед повтором, мс. */
  baseDelayMs: 300,
  /** Retry-After длиннее — не ждём, отдаём ошибку (обработку повторит очередь). */
  maxDelayMs: 2_000,
  /** Первая попытка и пауза уже заняли столько — не повторяем. */
  budgetMs: 4_000,
} as const;

/**
 * Пауза перед единственным повтором или null — не повторять.
 * retryAfter — значение заголовка Retry-After (секунды), elapsedMs — сколько уже заняла первая попытка.
 */
export function retryDelayMs(status: number, elapsedMs: number, retryAfter: string | null, policy = RETRY_POLICY): number | null {
  if (!isRetryableStatus(status)) return null;
  const after = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : undefined;
  const delay = after ?? policy.baseDelayMs;
  if (delay > policy.maxDelayMs) return null;
  if (elapsedMs + delay > policy.budgetMs) return null;
  return delay;
}
