// Все внешние URL — только отсюда: в тестах они указывают на фейки (ADR-0006).

import { type KeyRing, keyRing } from "./crypto";
import type { CostEstimates, UsageLimits } from "./limits";
import type { LlmConfig } from "./nlu/llm";
import { type CfPlan, cloudflareGraphql } from "./ops/quota-rules";
import type { SttConfig } from "./stt/whisper";
import type { VisionConfig } from "./vision/understand";
import type { VoiceConfig } from "./voice/understand";

export interface Config {
  telegramApiBase: string;
  telegramBotToken: string;
  telegramWebhookSecret: string;
  /** Без @. */
  telegramBotUsername: string;
  publicBaseUrl: string;
  googleApiBase: string;
  /** oauth2.googleapis.com — токен-эндпоинт. */
  googleOAuthBase: string;
  /** accounts.google.com — экран согласия. */
  googleAccountsBase: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Ещё и основа псевдонимов в админке. */
  tokenEncryptionKey: string;
  tokenKeys: KeyRing;
  allowedTelegramIds: Set<string>;
  opsChatId: string | null;
  testMode: boolean;
  /** Выключен — только опрос по расписанию. */
  googlePushEnabled: boolean;
  admin: { user: string; password: string };
  llm: LlmConfig[];
  stt: SttConfig[];
  /** Пусто — переслушивания нет. */
  voice: VoiceConfig[];
  /** Пусто — фото не читаем. */
  vision: VisionConfig[];
  limits: UsageLimits;
  costs: CostEstimates;
  /** null — аккаунт Cloudflare неизвестен. */
  cloudflare: CloudflareAnalytics | null;
}

export interface CloudflareAnalytics {
  graphqlUrl: string;
  accountTag: string;
  /** Нужно право Account Analytics: Read. */
  apiKey: string;
  /** Через API его не узнать — из vars.CF_WORKERS_PLAN. */
  plan: CfPlan;
  scriptName: string;
}

/** Должно совпадать с `name` в wrangler.jsonc — так Worker называется в аналитике. */
export const WORKER_SCRIPT_NAME = "calendar-assist-bot";

/**
 * Щедрые для нас двоих (обычный день — десятки команд): ловят зацикливание, спам и утёкший доступ, а не живого
 * человека (tech-debt #4). Голосовое тратит и STT, и LLM.
 */
export const USAGE_LIMITS: UsageLimits = {
  llm: { perHour: 60, perDay: 300 },
  stt: { perHour: 30, perDay: 120 },
};

/** ОЦЕНКА по прайсу Workers AI на 2026-10, без бесплатных 10k neurons/сутки. Сменили модель — обновить. */
export const COST_ESTIMATES: CostEstimates = {
  llmInPerM: 0.051, // Qwen3-30B-A3B, $ за 1M входных токенов
  llmOutPerM: 0.335, // $ за 1M выходных токенов
  sttPerMin: 0.0005, // Whisper large-v3-turbo, $ за минуту аудио
};

/** Бот её не вызывает, только отдаёт пользователю, — поэтому не в Env и без фейка. */
export const GOOGLE_CALENDAR_TEMPLATE_URL = "https://calendar.google.com/calendar/render";

export function loadConfig(env: Env): Config {
  const allowed = (env.ALLOWED_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const llm = parseChain<LlmConfig>(env.LLM_CHAIN, "LLM_CHAIN") ?? [
    { name: "workers-ai", baseUrl: env.LLM_BASE, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL },
  ];
  // Тот же API-токен Cloudflare, что и у LLM
  const stt = parseChain<SttConfig>(env.STT_CHAIN, "STT_CHAIN") ?? [
    { name: "workers-ai", kind: "workers-ai", baseUrl: env.STT_BASE, apiKey: env.LLM_API_KEY, model: env.STT_MODEL },
  ];
  return {
    telegramApiBase: env.TELEGRAM_API_BASE,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    telegramBotUsername: (env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, ""),
    publicBaseUrl: env.PUBLIC_BASE_URL,
    googleApiBase: env.GOOGLE_API_BASE,
    googleOAuthBase: env.GOOGLE_OAUTH_BASE,
    googleAccountsBase: env.GOOGLE_ACCOUNTS_BASE,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    tokenKeys: keyRing(env.TOKEN_ENCRYPTION_KEY, env.TOKEN_ENCRYPTION_KEYS_OLD),
    allowedTelegramIds: new Set(allowed),
    opsChatId: env.OPS_CHAT_ID?.trim() || allowed[0] || null,
    testMode: env.TEST_MODE === "true",
    googlePushEnabled: env.GOOGLE_PUSH_ENABLED === "true",
    admin: { user: env.ADMIN_USER ?? "", password: env.ADMIN_PASSWORD ?? "" },
    llm,
    stt,
    voice: parseChain<VoiceConfig>(env.VOICE_CHAIN, "VOICE_CHAIN", true) ?? [],
    vision:
      parseChain<VisionConfig>(env.VISION_CHAIN, "VISION_CHAIN", true) ??
      (parseChain<VoiceConfig>(env.VOICE_CHAIN, "VOICE_CHAIN", true) ?? []).flatMap((c) => (c.kind === "gemini" ? [{ ...c, kind: "gemini" as const }] : [])),
    limits: USAGE_LIMITS,
    costs: COST_ESTIMATES,
    cloudflare: cloudflareAnalytics(env, [...llm, ...stt]),
  };
}

function cloudflareAnalytics(env: Env, links: { name?: string; baseUrl: string; apiKey: string }[]): CloudflareAnalytics | null {
  const ai = links.filter((c) => c.name === "workers-ai");
  const derived = ai.map((c) => cloudflareGraphql(c.baseUrl)).find((g) => g !== null) ?? null;
  const graphqlUrl = env.CF_GRAPHQL_URL?.trim() || derived?.url;
  const accountTag = env.CF_ACCOUNT_ID?.trim() || derived?.accountTag;
  const apiKey = env.CF_ANALYTICS_TOKEN?.trim() || ai[0]?.apiKey || env.LLM_API_KEY;
  if (!graphqlUrl || !accountTag || !apiKey) return null;
  return { graphqlUrl, accountTag, apiKey, plan: (env.CF_WORKERS_PLAN as string | undefined) === "paid" ? "paid" : "free", scriptName: WORKER_SCRIPT_NAME };
}

/**
 * Битый JSON — ошибка конфигурации, а не тихий откат. `[]` у необязательных цепочек scripts/deploy.ts пишет, когда
 * ключей нет, — чтобы не остался секрет прежнего деплоя.
 */
function parseChain<T extends { baseUrl: string; apiKey: string; model: string }>(json: string | undefined, name: string, allowEmpty = false): T[] | undefined {
  if (!json?.trim()) return undefined;
  const chain = JSON.parse(json) as T[];
  if (!Array.isArray(chain) || (!allowEmpty && chain.length === 0) || chain.some((c) => !c.baseUrl || !c.model))
    throw new Error(`${name}: expected a non-empty array of {baseUrl, apiKey, model}`);
  return chain;
}
