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
  /** Workers AI REST: https://api.cloudflare.com/client/v4/accounts/<id>/ai (ключ — LLM_API_KEY). */
  STT_BASE: string;
  /** Необязательно: JSON-цепочка LLM [{name, baseUrl, apiKey, model, extraBody?, inPerM?, outPerM?}] (scripts/deploy.ts). */
  LLM_CHAIN?: string;
  /** Необязательно: JSON-цепочка STT [{name, kind, baseUrl, apiKey, model, perMin?}] (scripts/deploy.ts). */
  STT_CHAIN?: string;
  /** Необязательно: JSON-цепочка мультимодального разбора голоса [{name, kind: gemini|openai-audio, baseUrl, apiKey, model}]. */
  VOICE_CHAIN?: string;
  /** Вход на /admin (HTTP Basic). Пустой пароль — страница недоступна. */
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
  /** Публичный адрес Worker'а (https://…workers.dev) — для OAuth redirect_uri и ссылок. */
  PUBLIC_BASE_URL: string;
}
