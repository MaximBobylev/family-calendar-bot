// Access token из refresh token; кеширует его calendar/google-provider.ts (tech-debt #13).

import { fetchWithTimeout, TIMEOUTS } from "../net/fetch";
import type { Config } from "../config";
import { GoogleAuthError } from "./errors";

export interface AccessToken {
  accessToken: string;
  expiresInSec?: number;
}

export async function refreshAccessToken(config: Config, refreshToken: string): Promise<AccessToken> {
  const res = await fetchWithTimeout(
    `${config.googleOAuthBase}/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        grant_type: "refresh_token",
      }),
    },
    TIMEOUTS.google,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new GoogleAuthError(`google token refresh failed: ${res.status} ${body}`, body.includes("invalid_grant"));
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  return { accessToken: json.access_token, ...(typeof json.expires_in === "number" ? { expiresInSec: json.expires_in } : {}) };
}
