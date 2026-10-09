// Конфигурация из Env. Все внешние URL — отсюда (ADR-0006: в тестах указывают на фейки).

import { type KeyRing, keyRing } from "./crypto";
import type { CostEstimates, UsageLimits } from "./limits";
import type { LlmConfig } from "./nlu/llm";
import { type CfPlan, cloudflareGraphql } from "./ops/quota-rules";
import type { SttConfig } from "./stt/whisper";
import type { VoiceConfig } from "./voice/understand";

export interface Config {
  telegramApiBase: string;
  telegramBotToken: string;
  telegramWebhookSecret: string;
  /** Имя бота без @ (TELEGRAM_BOT_USERNAME): ссылки-приглашения в дом (US-90), обращения к боту в группе (US-94). */
  telegramBotUsername: string;
  /** Публичный адрес Worker'а — для redirect_uri и ссылок из бота. */
  publicBaseUrl: string;
  googleApiBase: string;
  /** Токен-эндпоинт: oauth2.googleapis.com. */
  googleOAuthBase: string;
  /** Экран согласия: accounts.google.com. */
  googleAccountsBase: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Текущий ключ AES-GCM (и основа псевдонимов админки). */
  tokenEncryptionKey: string;
  /** Текущий + прежние ключи для расшифровки (ротация, tech-debt #8). */
  tokenKeys: KeyRing;
  allowedTelegramIds: Set<string>;
  /** Куда слать алерты (src/ops/alerts.ts): OPS_CHAT_ID, иначе первый из ALLOWED_TELEGRAM_IDS; null — некуда. */
  opsChatId: string | null;
  testMode: boolean;
  /** Push Google (events.watch → /google/push, ADR-0005 §2); выключен — только опрос по расписанию. */
  googlePushEnabled: boolean;
  admin: { user: string; password: string };
  /** Цепочка LLM: основной → запасные (LLM_CHAIN; без него — один Workers AI из LLM_BASE/LLM_MODEL). */
  llm: LlmConfig[];
  /** Цепочка STT: основной → запасные (STT_CHAIN; без него — один Workers AI из STT_BASE/STT_MODEL). */
  stt: SttConfig[];
  /** Мультимодальный разбор голоса для эскалации (VOICE_CHAIN); пусто — эскалации нет. */
  voice: VoiceConfig[];
  /** Чтение фото/скриншотов (US-66): Gemini-провайдеры из VOICE_CHAIN — тот же ключ и модель; пусто — фото не читаем. */
  vision: VoiceConfig[];
  limits: UsageLimits;
  costs: CostEstimates;
  /** GraphQL Analytics Cloudflare для /admin/quotas (Workers AI, Workers, D1, Queues); null — аккаунт неизвестен. */
  cloudflare: CloudflareAnalytics | null;
}

export interface CloudflareAnalytics {
  graphqlUrl: string;
  accountTag: string;
  /** CF_ANALYTICS_TOKEN, иначе токен звена Workers AI (LLM_API_KEY): нужно право Account Analytics: Read. */
  apiKey: string;
  /** Тариф Workers (vars.CF_WORKERS_PLAN): через API его не узнать — по умолчанию Free. */
  plan: CfPlan;
  /** Имя нашего Worker'а в аналитике — `name` из wrangler.jsonc. */
  scriptName: string;
}

/** `name` из wrangler.jsonc: так Worker называется в аналитике Workers (scriptName). */
export const WORKER_SCRIPT_NAME = "calendar-assist-bot";

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

/** Ссылка-шаблон «добавить в Google Календарь» без OAuth (US-95): бот её не вызывает, только отдаёт пользователю. */
export const GOOGLE_CALENDAR_TEMPLATE_URL = "https://calendar.google.com/calendar/render";

export function loadConfig(env: Env): Config {
  const allowed = (env.ALLOWED_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const llm = parseChain<LlmConfig>(env.LLM_CHAIN, "LLM_CHAIN") ?? [
    { name: "workers-ai", baseUrl: env.LLM_BASE, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL },
  ];
  // Тот же API-токен Cloudflare, что и для LLM
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
    voice: parseChain<VoiceConfig>(env.VOICE_CHAIN, "VOICE_CHAIN") ?? [],
    vision: (parseChain<VoiceConfig>(env.VOICE_CHAIN, "VOICE_CHAIN") ?? []).filter((c) => c.kind === "gemini"),
    limits: USAGE_LIMITS,
    costs: COST_ESTIMATES,
    cloudflare: cloudflareAnalytics(env, [...llm, ...stt]),
  };
}

/**
 * Аккаунт и адрес GraphQL — из адреса звена Workers AI (…/accounts/<id>/ai); CF_GRAPHQL_URL и CF_ACCOUNT_ID их
 * перекрывают (dev: фейк, ADR-0006). Токен — CF_ANALYTICS_TOKEN, иначе токен того же звена.
 */
function cloudflareAnalytics(env: Env, links: { name?: string; baseUrl: string; apiKey: string }[]): CloudflareAnalytics | null {
  const ai = links.filter((c) => c.name === "workers-ai");
  const derived = ai.map((c) => cloudflareGraphql(c.baseUrl)).find((g) => g !== null) ?? null;
  const graphqlUrl = env.CF_GRAPHQL_URL?.trim() || derived?.url;
  const accountTag = env.CF_ACCOUNT_ID?.trim() || derived?.accountTag;
  const apiKey = env.CF_ANALYTICS_TOKEN?.trim() || ai[0]?.apiKey || env.LLM_API_KEY;
  if (!graphqlUrl || !accountTag || !apiKey) return null;
  return { graphqlUrl, accountTag, apiKey, plan: (env.CF_WORKERS_PLAN as string | undefined) === "paid" ? "paid" : "free", scriptName: WORKER_SCRIPT_NAME };
}

/** JSON-массив провайдеров из секрета (собирает scripts/deploy.ts). Битый или пустой — ошибка конфигурации, не тихий откат. */
function parseChain<T extends { baseUrl: string; apiKey: string; model: string }>(json: string | undefined, name: string): T[] | undefined {
  if (!json?.trim()) return undefined;
  const chain = JSON.parse(json) as T[];
  if (!Array.isArray(chain) || chain.length === 0 || chain.some((c) => !c.baseUrl || !c.model))
    throw new Error(`${name}: expected a non-empty array of {baseUrl, apiKey, model}`);
  return chain;
}
