// Деплой в Cloudflare. Запуск: docker compose run --rm deploy
// Значения берутся из окружения (.env подключается compose). Секреты в вывод не печатаются.
//
// 1. Миграции D1 (remote)
// 2. wrangler deploy → адрес Worker'а
// 3. Секреты Worker'а (wrangler secret bulk); PUBLIC_BASE_URL, LLM_BASE и цепочки LLM_CHAIN/STT_CHAIN вычисляются
// 4. Webhook Telegram на /telegram/webhook с секретом

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = process.env;

function need(name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

function wrangler(args: string[], opts: { capture?: boolean } = {}): string {
  console.log(`\n$ wrangler ${args.join(" ")}`);
  const res = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: opts.capture ? ["inherit", "pipe", "inherit"] : "inherit" });
  if (opts.capture && res.stdout) process.stdout.write(res.stdout);
  if (res.status !== 0) throw new Error(`wrangler ${args[0]} failed (exit ${res.status})`);
  return res.stdout ?? "";
}

const accountId = need("CLOUDFLARE_ACCOUNT_ID");
need("CLOUDFLARE_API_TOKEN");

// 0. Проверки до выкладки
for (const [cmd, args] of [
  ["npm", ["run", "-s", "typecheck"]],
  // Линтер и проверка формата (без правок файлов)
  ["npx", ["biome", "ci"]],
  ["npx", ["vitest", "run"]],
] as const) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, [...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed — deploy aborted`);
}

// 1. Миграции
wrangler(["d1", "migrations", "apply", "DB", "--remote"]);

// 2. Деплой кода
const out = wrangler(["deploy"], { capture: true });
const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0];
if (!url) throw new Error("could not find workers.dev URL in wrangler deploy output");

// 3. Секреты
// Цепочки провайдеров (src/config.ts): основной → запасные; Workers AI — всегда последний запасной.
const workersAi = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`;
const llmChain: Record<string, unknown>[] = [];
const openrouterKey = env.OPENROUTER_API_KEY?.trim();
// Бесплатные модели OpenRouter часто перегружены у провайдера (429 «rate-limited upstream», 2026-10-05) —
// несколько моделей через запятую, каждая — звено цепочки
// Пока не в лайве — только бесплатные (решение 2026-10-05). Платная Gemma 4 26B — лучшая в замерах (97,3% полей,
// ≈ $0.0002 за команду): вернуть первой перед бетой — OPENROUTER_MODEL=google/gemma-4-26b-a4b-it,…
// Nemotron free первым: 91,9% полей, p50 0,8 с / p95 1,6 с, 0 ошибок на 124 фразах; бесплатная Gemma почти всегда 429.
const OPENROUTER_DEFAULT = "nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-26b-a4b-it:free";
if (openrouterKey) {
  for (const model of (env.OPENROUTER_MODEL?.trim() || OPENROUTER_DEFAULT)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)) {
    llmChain.push({
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: openrouterKey,
      model,
      // Gemma 4 с «размышлением» отвечает 5–6 с (docs/research/llm-intents-eval.md)
      extraBody: { reasoning: { enabled: false } },
      ...(model.endsWith(":free") ? { inPerM: 0, outPerM: 0 } : {}),
    });
  }
}
// DeepSeek (docs/research/llm-intents-eval.md, 2026-10-08): deepseek-flash без «размышления» — 98,2% / 99,3% полей,
// p50 1,1 с, ≈ $0,0003 за команду. Платный; серверы в Китае (ADR-0002). Решение владельца 2026-10-08: пока разработка —
// только бесплатные модели, ключ сам по себе DeepSeek не включает; на запуске — LLM_PRIMARY=deepseek (первым в цепочке).
const deepseekKey = env.DEEPSEEK_API_KEY?.trim();
if (deepseekKey && env.LLM_PRIMARY?.trim() === "deepseek") {
  const deepseek = {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: deepseekKey,
    model: env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
    extraBody: { thinking: { type: "disabled" } },
    // Цена промаха кеша в «пиковые» часы; с кешем системного промпта — заметно дешевле
    inPerM: 0.3,
    outPerM: 1.2,
  };
  llmChain.unshift(deepseek);
}
llmChain.push({ name: "workers-ai", baseUrl: `${workersAi}/v1`, apiKey: need("LLM_API_KEY"), model: "@cf/qwen/qwen3-30b-a3b-fp8" });

const sttChain: Record<string, unknown>[] = [];
const groqKey = env.GROQ_API_KEY?.trim();
if (groqKey) {
  // Groq: whisper-large-v3-turbo ≈ $0.04 за час аудио
  sttChain.push({
    name: "groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: groqKey,
    model: env.GROQ_STT_MODEL?.trim() || "whisper-large-v3-turbo",
    perMin: 0.04 / 60,
  });
}
sttChain.push({ name: "workers-ai", kind: "workers-ai", baseUrl: workersAi, apiKey: need("LLM_API_KEY"), model: "@cf/openai/whisper-large-v3-turbo" });
// Мультимодальный разбор голоса — эскалация, когда текстовый путь ошибся (docs/tracks/multimodal-voice.md, вариант D).
// Спайк 2026-10-05: gemini-3.5-flash-lite напрямую — лучший (12/12, 1,4 с); запасной через OpenRouter — по желанию.
const voiceChain: Record<string, unknown>[] = [];
const geminiKey = env.GEMINI_API_KEY?.trim();
if (geminiKey) {
  voiceChain.push({
    name: "gemini",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: geminiKey,
    model: env.GEMINI_VOICE_MODEL?.trim() || "gemini-3.5-flash-lite",
  });
}
const voiceOpenRouterModel = env.VOICE_OPENROUTER_MODEL?.trim();
if (openrouterKey && voiceOpenRouterModel) {
  voiceChain.push({ name: "openrouter", kind: "openai-audio", baseUrl: "https://openrouter.ai/api/v1", apiKey: openrouterKey, model: voiceOpenRouterModel });
}

console.log(`\nLLM: ${llmChain.map((c) => `${c.name} (${c.model})`).join(" → ")}`);
console.log(`STT: ${sttChain.map((c) => `${c.name} (${c.model})`).join(" → ")}`);
console.log(`Переслушивание голоса: ${voiceChain.map((c) => `${c.name} (${c.model})`).join(" → ") || "выключено (нет GEMINI_API_KEY)"}`);

// Имя бота — для ссылок-приглашений в дом и обращений в группе (US-90, US-94): из getMe, не из .env
const me = (await (await fetch(`https://api.telegram.org/bot${need("TELEGRAM_BOT_TOKEN")}/getMe`)).json()) as { ok: boolean; result?: { username?: string } };
if (!me.ok || !me.result?.username) throw new Error("getMe failed: cannot read the bot username");

const secrets: Record<string, string> = {
  TELEGRAM_BOT_USERNAME: me.result.username,
  TELEGRAM_BOT_TOKEN: need("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_WEBHOOK_SECRET: need("TELEGRAM_WEBHOOK_SECRET"),
  ALLOWED_TELEGRAM_IDS: need("ALLOWED_TELEGRAM_IDS"),
  TOKEN_ENCRYPTION_KEY: need("TOKEN_ENCRYPTION_KEY"),
  ADMIN_USER: env.ADMIN_USER?.trim() || "admin",
  ADMIN_PASSWORD: need("ADMIN_PASSWORD"),
  LLM_API_KEY: need("LLM_API_KEY"),
  LLM_BASE: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
  STT_BASE: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`,
  PUBLIC_BASE_URL: url,
  LLM_CHAIN: JSON.stringify(llmChain),
  STT_CHAIN: JSON.stringify(sttChain),
  VOICE_CHAIN: JSON.stringify(voiceChain),
};
// Ротация ключа (tech-debt #8): прежние ключи — только если заданы; пусто — секрет не трогаем
const oldKeys = env.TOKEN_ENCRYPTION_KEYS_OLD?.trim();
if (oldKeys) secrets.TOKEN_ENCRYPTION_KEYS_OLD = oldKeys;
// Алерты (tech-debt #7): свой чат — только если задан; иначе бот шлёт первому из ALLOWED_TELEGRAM_IDS
const opsChat = env.OPS_CHAT_ID?.trim();
if (opsChat) secrets.OPS_CHAT_ID = opsChat;
for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
  const v = env[name]?.trim();
  if (v) secrets[name] = v;
  else console.warn(`\n⚠️  ${name} is empty — Google linking will not work until it is set and deploy is re-run`);
}
const dir = mkdtempSync(join(tmpdir(), "cab-secrets-"));
try {
  const file = join(dir, "secrets.json");
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  wrangler(["secret", "bulk", file, "--env="]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 4. Webhook Telegram
const res = await fetch(`https://api.telegram.org/bot${secrets.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: `${url}/telegram/webhook`,
    secret_token: secrets.TELEGRAM_WEBHOOK_SECRET,
    // edited_message не подписываем: игнорируется, но тратил бы квоты
    // inline_query — inline-карточки (US-95); inline-режим включает владелец в @BotFather: /setinline
    // my_chat_member — бота добавили в группу: приветствие с привязкой к дому (ревью R1 #13)
    allowed_updates: ["message", "callback_query", "inline_query", "my_chat_member"],
    // Не сбрасываем: после неудачного деплоя там как раз ждут сообщения пользователей
    drop_pending_updates: false,
  }),
});
const tg = (await res.json()) as { ok: boolean; description?: string };
if (!tg.ok) throw new Error(`setWebhook failed: ${tg.description}`);

// 5. Меню команд Telegram (кнопка «/» в чате)
// Личка — полное меню; группы — как обращаться и привязка чата (ревью R1 §4.3)
const commands = {
  ru: [
    { command: "help", description: "Что я умею" },
    { command: "home", description: "Дом: семья, общие календари, приглашения" },
    { command: "settings", description: "Настройки: сводки и напоминания" },
    { command: "connect", description: "Подключить или переподключить Google" },
    { command: "disconnect", description: "Отключить календарь и удалить данные" },
  ],
  en: [
    { command: "help", description: "What I can do" },
    { command: "home", description: "Household: family, shared calendars, invites" },
    { command: "settings", description: "Settings: summaries and reminders" },
    { command: "connect", description: "Connect or reconnect Google" },
    { command: "disconnect", description: "Disconnect calendar and delete data" },
  ],
  groupRu: [
    { command: "help", description: "Как ко мне обращаться" },
    { command: "home", description: "Привязать чат к дому: /home link" },
  ],
  groupEn: [
    { command: "help", description: "How to talk to me" },
    { command: "home", description: "Link this chat to a household: /home link" },
  ],
};
for (const [lang, list, scope] of [
  ["", commands.ru, "all_private_chats"],
  ["ru", commands.ru, "all_private_chats"],
  ["en", commands.en, "all_private_chats"],
  ["", commands.groupRu, "all_group_chats"],
  ["ru", commands.groupRu, "all_group_chats"],
  ["en", commands.groupEn, "all_group_chats"],
] as const) {
  const r = await fetch(`https://api.telegram.org/bot${secrets.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: list, scope: { type: scope }, ...(lang ? { language_code: lang } : {}) }),
  });
  const body = (await r.json()) as { ok: boolean; description?: string };
  if (!body.ok) console.warn(`setMyCommands (${scope}, ${lang || "default"}) failed: ${body.description}`);
}

console.log(`\n✅ Deployed: ${url}`);
console.log(`   Telegram webhook: ${url}/telegram/webhook`);
console.log(`   Google OAuth redirect URI: ${url}/oauth/google/callback`);
