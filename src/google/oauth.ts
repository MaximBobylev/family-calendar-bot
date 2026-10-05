// Google OAuth (US-02, ADR-0001): ссылка согласия и обмен кода на токены.

import { fetchWithTimeout, TIMEOUTS } from "../net/fetch";
import type { Config } from "../config";
import { decryptSecret } from "../crypto";

/** Минимальные scopes (ADR-0001 п.4). */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

export function redirectUri(config: Config): string {
  return `${config.publicBaseUrl}/oauth/google/callback`;
}

/** codeChallenge — PKCE S256 (RFC 7636): код без нашего code_verifier бесполезен (tracks/telegram-login.md, A5). */
export function consentUrl(config: Config, state: string, codeChallenge: string): string {
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
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${config.googleAccountsBase}/o/oauth2/v2/auth?${params}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

/** client_secret остаётся (web-клиент Google — конфиденциальный); code_verifier — вдобавок к нему (PKCE). */
export async function exchangeCode(config: Config, code: string, codeVerifier: string): Promise<TokenResponse> {
  const res = await fetchWithTimeout(`${config.googleOAuthBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      code_verifier: codeVerifier,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: redirectUri(config),
      grant_type: "authorization_code",
    }),
  }, TIMEOUTS.google);
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

/**
 * Отозвать доступ (US-03): Google снимает всё разрешение приложения для этого аккаунта, не только этот токен.
 * 400 invalid_token — токен уже недействителен (отозван в Google): для пользователя это тоже успех.
 */
export async function revokeToken(config: Config, token: string): Promise<void> {
  const res = await fetchWithTimeout(`${config.googleOAuthBase}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }, TIMEOUTS.google);
  if (res.ok) return;
  const body = await res.text();
  if (res.status === 400 && body.includes("invalid_token")) return;
  throw new Error(`google revoke failed: ${res.status} ${body}`);
}

/** Расшифровать сохранённый refresh token и отозвать. false — не получилось (сеть, Google, сменился ключ). */
export async function revokeStoredToken(config: Config, credentialsEnc: string): Promise<boolean> {
  try {
    await revokeToken(config, await decryptSecret(credentialsEnc, config.tokenEncryptionKey));
    return true;
  } catch (e) {
    console.error("token revoke failed", e instanceof Error ? e.message : e);
    return false;
  }
}
