// Конфигурация из Env. Все внешние URL — отсюда (ADR-0006: в тестах указывают на фейки).

import type { LlmConfig } from "./nlu/llm";
import type { SttConfig } from "./stt/whisper";

export interface Config {
  telegramApiBase: string;
  telegramBotToken: string;
  telegramWebhookSecret: string;
  /** Публичный адрес Worker'а — для redirect_uri и ссылок из бота. */
  publicBaseUrl: string;
  googleApiBase: string;
  /** Токен-эндпоинт: oauth2.googleapis.com. */
  googleOAuthBase: string;
  /** Экран согласия: accounts.google.com. */
  googleAccountsBase: string;
  googleClientId: string;
  googleClientSecret: string;
  tokenEncryptionKey: string;
  allowedTelegramIds: Set<string>;
  testMode: boolean;
  admin: { user: string; password: string };
  llm: LlmConfig;
  stt: SttConfig;
}

export function loadConfig(env: Env): Config {
  return {
    telegramApiBase: env.TELEGRAM_API_BASE,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    googleApiBase: env.GOOGLE_API_BASE,
    googleOAuthBase: env.GOOGLE_OAUTH_BASE,
    googleAccountsBase: env.GOOGLE_ACCOUNTS_BASE,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    allowedTelegramIds: new Set(
      (env.ALLOWED_TELEGRAM_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ),
    testMode: env.TEST_MODE === "true",
    admin: { user: env.ADMIN_USER ?? "", password: env.ADMIN_PASSWORD ?? "" },
    llm: { baseUrl: env.LLM_BASE, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL },
    // Тот же API-токен Cloudflare, что и для LLM
    stt: { baseUrl: env.STT_BASE, apiKey: env.LLM_API_KEY, model: env.STT_MODEL },
  };
}
