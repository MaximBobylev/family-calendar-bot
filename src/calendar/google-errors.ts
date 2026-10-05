// Ошибки Google → ошибки календаря из model.ts (tech-debt #12). Остальное (D1, баги) пропускаем как есть.

import { GoogleApiError, GoogleAuthError } from "../google/errors";
import { AuthRevoked, CalendarError, EventConflict, EventGone, PermissionDenied, ProviderUnavailable } from "./model";

/** 403 у Google — это и «нет прав», и лимиты запросов (rateLimitExceeded, quotaExceeded…). */
const RATE_LIMIT_403 = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded/;

export function toCalendarError(e: unknown): unknown {
  if (e instanceof CalendarError) return e;
  if (e instanceof GoogleAuthError) return e.revoked ? new AuthRevoked(e.message) : new ProviderUnavailable(e.message);
  if (e instanceof GoogleApiError) {
    if (e.status === 404 || e.status === 410) return new EventGone(e.message);
    if (e.status === 412) return new EventConflict(e.message);
    if (e.status === 403 && !RATE_LIMIT_403.test(e.message)) return new PermissionDenied(e.message);
    return new ProviderUnavailable(e.message);
  }
  // Таймаут fetchWithTimeout и обрыв сети
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || (e instanceof TypeError && /fetch|network/i.test(e.message)))) {
    return new ProviderUnavailable(e.message);
  }
  return e;
}
