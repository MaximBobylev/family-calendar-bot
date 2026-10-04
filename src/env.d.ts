// Секреты не попадают в wrangler.jsonc, поэтому `wrangler types` о них не знает — дополняем Env вручную.
// Прод: `wrangler secret put …`; локально: vars окружения `dev` в wrangler.jsonc.

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  /** Проверяется в заголовке X-Telegram-Bot-Api-Secret-Token на webhook. */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Telegram user id через запятую — кому разрешена регистрация (ADR-0001). */
  ALLOWED_TELEGRAM_IDS: string;
}
