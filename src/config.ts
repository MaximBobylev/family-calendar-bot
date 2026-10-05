// Конфигурация из Env. Все внешние URL — отсюда (ADR-0006: в тестах указывают на фейки).

import type { CostEstimates, UsageLimits } from "./limits";
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
  /** Цепочка LLM: основной → запасные (LLM_CHAIN; без него — один Workers AI из LLM_BASE/LLM_MODEL). */
  llm: LlmConfig[];
  /** Цепочка STT: основной → запасные (STT_CHAIN; без него — один Workers AI из STT_BASE/STT_MODEL). */
  stt: SttConfig[];
  limits: UsageLimits;
  costs: CostEstimates;
}

/**
 * Лимиты вызовов на пользователя (tech-debt #4), скользящие час и сутки по usage_events. Превышение — вежливый
 * ответ без внешнего вызова. Щедрые для нас двоих: обычный день — десятки команд; лимит ловит зацикливание,
 * спам и утёкший доступ, а не живого человека. Голосовое тратит и STT, и LLM.
 */
export const USAGE_LIMITS: UsageLimits = {
  llm: { perHour: 60, perDay: 300 },
  stt: { perHour: 30, perDay: 120 },
};

/**
 * ОЦЕНКА стоимости (прайс Workers AI на 2026-10, без бесплатных 10k neurons/сутки) — для cost_micro_usd и /admin.
 * Сменили модель (LLM_MODEL, STT_MODEL) — обновить.
 */
export const COST_ESTIMATES: CostEstimates = {
  llmInPerM: 0.051, // Qwen3-30B-A3B, $ за 1M входных токенов
  llmOutPerM: 0.335, // $ за 1M выходных токенов
  sttPerMin: 0.0005, // Whisper large-v3-turbo, $ за минуту аудио
};

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
      (env.ALLOWED_TELEGRAM_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    testMode: env.TEST_MODE === "true",
    admin: { user: env.ADMIN_USER ?? "", password: env.ADMIN_PASSWORD ?? "" },
    llm: parseChain<LlmConfig>(env.LLM_CHAIN, "LLM_CHAIN") ?? [{ name: "workers-ai", baseUrl: env.LLM_BASE, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL }],
    // Тот же API-токен Cloudflare, что и для LLM
    stt: parseChain<SttConfig>(env.STT_CHAIN, "STT_CHAIN") ?? [
      { name: "workers-ai", kind: "workers-ai", baseUrl: env.STT_BASE, apiKey: env.LLM_API_KEY, model: env.STT_MODEL },
    ],
    limits: USAGE_LIMITS,
    costs: COST_ESTIMATES,
  };
}

/** JSON-массив провайдеров из секрета (собирает scripts/deploy.ts). Битый или пустой — ошибка конфигурации, не тихий откат. */
function parseChain<T extends { baseUrl: string; apiKey: string; model: string }>(json: string | undefined, name: string): T[] | undefined {
  if (!json?.trim()) return undefined;
  const chain = JSON.parse(json) as T[];
  if (!Array.isArray(chain) || chain.length === 0 || chain.some((c) => !c.baseUrl || !c.model))
    throw new Error(`${name}: expected a non-empty array of {baseUrl, apiKey, model}`);
  return chain;
}
