// Секреты не попадают в wrangler.jsonc, поэтому `wrangler types` о них не знает — дополняем Env вручную.
// Прод: `wrangler secret put …`; локально: vars окружения `dev` в wrangler.jsonc.

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  /** Приходит в заголовке X-Telegram-Bot-Api-Secret-Token. */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Telegram user id через запятую. */
  ALLOWED_TELEGRAM_IDS: string;
  /** deploy берёт его из getMe. */
  TELEGRAM_BOT_USERNAME: string;
  /** Пусто — алерты первому из ALLOWED_TELEGRAM_IDS. */
  OPS_CHAT_ID?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** base64, 32 байта. */
  TOKEN_ENCRYPTION_KEY: string;
  /** Через запятую; только расшифровка, на время ротации (tech-debt #8). */
  TOKEN_ENCRYPTION_KEYS_OLD?: string;
  /** Для Workers AI — API-токен Cloudflare; им же ходит STT по умолчанию. */
  LLM_API_KEY: string;
  /** OpenAI-совместимый: https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1 */
  LLM_BASE: string;
  /** Workers AI REST, без /v1: https://api.cloudflare.com/client/v4/accounts/<id>/ai */
  STT_BASE: string;
  /** JSON [{name, baseUrl, apiKey, model, extraBody?, inPerM?, outPerM?}], собирает scripts/deploy.ts. */
  LLM_CHAIN?: string;
  /** JSON [{name, kind, baseUrl, apiKey, model, perMin?}], собирает scripts/deploy.ts. */
  STT_CHAIN?: string;
  /** JSON [{name, kind: gemini|openai-audio, baseUrl, apiKey, model}]. */
  VOICE_CHAIN?: string;
  /** JSON [{name, kind: openai|gemini, baseUrl, apiKey, model, extraBody?}]; нет — Gemini-звенья из VOICE_CHAIN. */
  VISION_CHAIN?: string;
  /** Токен только с правом Account Analytics: Read. Пусто — LLM_API_KEY, если у него есть это право. */
  CF_ANALYTICS_TOKEN?: string;
  /** Пустой пароль — /admin недоступна. */
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
  PUBLIC_BASE_URL: string;
}
