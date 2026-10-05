// Access token Google из refresh token. Живёт ~1 час; пока получаем на каждую обработку апдейта.

import { fetchWithTimeout, TIMEOUTS } from "../net/fetch";
import type { Config } from "../config";

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    /** invalid_grant — доступ отозван пользователем, нужно переподключить (US-02). */
    readonly revoked: boolean,
  ) {
    super(message);
  }
}

export async function refreshAccessToken(config: Config, refreshToken: string): Promise<string> {
  const res = await fetchWithTimeout(`${config.googleOAuthBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      grant_type: "refresh_token",
    }),
  }, TIMEOUTS.google);
  if (!res.ok) {
    const body = await res.text();
    throw new GoogleAuthError(`google token refresh failed: ${res.status} ${body}`, body.includes("invalid_grant"));
  }
  return ((await res.json()) as { access_token: string }).access_token;
}
