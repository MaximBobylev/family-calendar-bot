// Конфигурация из Env. Все внешние URL — отсюда (ADR-0006: в тестах указывают на фейки).

export interface Config {
  telegramApiBase: string;
  telegramBotToken: string;
  telegramWebhookSecret: string;
  googleApiBase: string;
  googleOAuthBase: string;
  allowedTelegramIds: Set<string>;
  testMode: boolean;
}

export function loadConfig(env: Env): Config {
  return {
    telegramApiBase: env.TELEGRAM_API_BASE,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    googleApiBase: env.GOOGLE_API_BASE,
    googleOAuthBase: env.GOOGLE_OAUTH_BASE,
    allowedTelegramIds: new Set(
      (env.ALLOWED_TELEGRAM_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ),
    testMode: env.TEST_MODE === "true",
  };
}
