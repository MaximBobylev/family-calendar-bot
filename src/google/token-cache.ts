// Срок жизни кеша access token Google (tech-debt #13) — чистые функции: когда кешированный ещё можно брать.

/** Запас до срока: токен, которому осталось меньше, не берём — запрос может не успеть до истечения. */
export const ACCESS_TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** Google не прислал expires_in — считаем, как обычно у него, час. */
const DEFAULT_EXPIRES_IN_SEC = 3600;

/** Когда токен истечёт (мс UTC) по expires_in из ответа Google. */
export function accessTokenExpiresAt(now: number, expiresInSec: number | undefined): number {
  const sec = expiresInSec !== undefined && Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : DEFAULT_EXPIRES_IN_SEC;
  return now + sec * 1000;
}

/** Кешированный токен ещё годится: до истечения больше запаса. Нет срока — не годится. */
export function accessTokenUsable(expiresAt: number | null | undefined, now: number, marginMs = ACCESS_TOKEN_MARGIN_MS): boolean {
  return typeof expiresAt === "number" && expiresAt - now > marginMs;
}
