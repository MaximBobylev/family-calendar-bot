// Секреты не попадают в wrangler.jsonc, поэтому `wrangler types` о них не знает — дополняем Env вручную.
// Прод: `wrangler secret put …`; локально: vars окружения `dev` в wrangler.jsonc.

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  /** Проверяется в заголовке X-Telegram-Bot-Api-Secret-Token на webhook. */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Telegram user id через запятую — кому разрешена регистрация (ADR-0001). */
  ALLOWED_TELEGRAM_IDS: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** base64, 32 байта — AES-GCM для refresh token (src/crypto.ts). */
  TOKEN_ENCRYPTION_KEY: string;
  /** Ключ OpenAI-совместимого LLM API (Workers AI: API-токен Cloudflare). */
  LLM_API_KEY: string;
  /** Адрес OpenAI-совместимого API: https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1 */
  LLM_BASE: string;
  /** Публичный адрес Worker'а (https://…workers.dev) — для OAuth redirect_uri и ссылок. */
  PUBLIC_BASE_URL: string;
}
