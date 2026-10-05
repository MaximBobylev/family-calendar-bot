// fetch с таймаутом: зависший внешний сервис не должен держать обработку до обрыва waitUntil (30 с).

export const TIMEOUTS = {
  telegram: 8_000,
  google: 10_000,
  llm: 15_000,
  stt: 20_000,
} as const;

export function fetchWithTimeout(input: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
