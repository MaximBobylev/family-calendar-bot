// Когда кешированный access token Google ещё можно брать (tech-debt #13).

/** Запрос с токеном, которому осталось меньше, может не успеть до истечения. */
export const ACCESS_TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** Если Google не прислал expires_in — как обычно у него, час. */
const DEFAULT_EXPIRES_IN_SEC = 3600;

export function accessTokenExpiresAt(now: number, expiresInSec: number | undefined): number {
  const sec = expiresInSec !== undefined && Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : DEFAULT_EXPIRES_IN_SEC;
  return now + sec * 1000;
}

export function accessTokenUsable(expiresAt: number | null | undefined, now: number, marginMs = ACCESS_TOKEN_MARGIN_MS): boolean {
  return typeof expiresAt === "number" && expiresAt - now > marginMs;
}
