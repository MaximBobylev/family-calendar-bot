// Google OAuth (US-02, ADR-0001): ссылка согласия и обмен кода на токены.

import type { Config } from "../config";

/** Минимальные scopes (ADR-0001 п.4). */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

export function redirectUri(config: Config): string {
  return `${config.publicBaseUrl}/oauth/google/callback`;
}

export function consentUrl(config: Config, state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(config),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    // offline + consent — иначе при повторной привязке Google не выдаст refresh token (US-02)
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${config.googleAccountsBase}/o/oauth2/v2/auth?${params}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

export async function exchangeCode(config: Config, code: string): Promise<TokenResponse> {
  const res = await fetch(`${config.googleOAuthBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: redirectUri(config),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}
