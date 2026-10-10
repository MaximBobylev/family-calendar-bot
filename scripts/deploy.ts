// Только по явной просьбе владельца: docker compose run --rm deploy (окружение — из .env через compose).
// Секреты в вывод не печатать.

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

for (const [cmd, args] of [
  ["npm", ["run", "-s", "typecheck"]],
  ["npx", ["biome", "ci"]],
  ["npx", ["vitest", "run"]],
] as const) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, [...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed — deploy aborted`);
}

wrangler(["d1", "migrations", "apply", "DB", "--remote"]);

const out = wrangler(["deploy"], { capture: true });
const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0];
if (!url) throw new Error("could not find workers.dev URL in wrangler deploy output");

const workersAi = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`;
const llmChain: Record<string, unknown>[] = [];
const openrouterKey = env.OPENROUTER_API_KEY?.trim();
// Бесплатные модели OpenRouter часто отвечают 429 upstream — поэтому несколько звеньев. До запуска — только бесплатные
// (решение владельца); Nemotron первым: 91,9% полей, p95 1,6 с, а бесплатная Gemma почти всегда 429.
// Перед бетой вернуть первой платную Gemma 4 26B (97,3% полей): OPENROUTER_MODEL=google/gemma-4-26b-a4b-it,…
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
      // С «размышлением» Gemma 4 отвечает 5–6 с
      extraBody: { reasoning: { enabled: false } },
      ...(model.endsWith(":free") ? { inPerM: 0, outPerM: 0 } : {}),
    });
  }
}
// DeepSeek платный, серверы в Китае: по решению владельца ключ сам его не включает; на запуске — LLM_PRIMARY=deepseek.
const deepseekKey = env.DEEPSEEK_API_KEY?.trim();
if (deepseekKey && env.LLM_PRIMARY?.trim() === "deepseek") {
  const deepseek = {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: deepseekKey,
    model: env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
    extraBody: { thinking: { type: "disabled" } },
    // Цена промаха кеша в пиковые часы — оценка сверху
    inPerM: 0.3,
    outPerM: 1.2,
  };
  llmChain.unshift(deepseek);
}
// Без структуры даты `when`: с ней промпт ≈ 7 тыс. токенов вместо ≈ 2,6 — втрое больше neurons из общих 10 000/сутки
llmChain.push({ name: "workers-ai", baseUrl: `${workersAi}/v1`, apiKey: need("LLM_API_KEY"), model: "@cf/qwen/qwen3-30b-a3b-fp8", dateStructure: false });

const sttChain: Record<string, unknown>[] = [];
const groqKey = env.GROQ_API_KEY?.trim();
if (groqKey) {
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
// gemini-3.5-flash-lite напрямую — лучший в спайке переслушивания (12/12, 1,4 с).
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

// Фото → событие: решение владельца — на запуске DeepSeek (p95 2,4 с против 22,7 с у Gemini), до запуска только Gemini.
// Секрет пишем всегда, даже `[]`.
const visionChain: Record<string, unknown>[] = [];
const llmDeepseek = llmChain.find((c) => c.name === "deepseek");
if (llmDeepseek) visionChain.push({ ...llmDeepseek, kind: "openai" });
visionChain.push(...voiceChain.filter((c) => c.kind === "gemini"));

console.log(`\nLLM: ${llmChain.map((c) => `${c.name} (${c.model})`).join(" → ")}`);
console.log(`STT: ${sttChain.map((c) => `${c.name} (${c.model})`).join(" → ")}`);
console.log(`Переслушивание голоса: ${voiceChain.map((c) => `${c.name} (${c.model})`).join(" → ") || "выключено (нет GEMINI_API_KEY)"}`);
console.log(`Фото → событие: ${visionChain.map((c) => `${c.name} (${c.model})`).join(" → ") || "выключено (нет GEMINI_API_KEY и DeepSeek)"}`);

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
  VISION_CHAIN: JSON.stringify(visionChain),
};
// Пусто — секрет не трогаем
const oldKeys = env.TOKEN_ENCRYPTION_KEYS_OLD?.trim();
if (oldKeys) secrets.TOKEN_ENCRYPTION_KEYS_OLD = oldKeys;
// Без OPS_CHAT_ID алерты уходят первому из ALLOWED_TELEGRAM_IDS
const opsChat = env.OPS_CHAT_ID?.trim();
if (opsChat) secrets.OPS_CHAT_ID = opsChat;
// Без него панель «Квоты» пробует LLM_API_KEY. Токен деплоя Worker'у не передаём: у него права на правку
const analyticsToken = env.CF_ANALYTICS_TOKEN?.trim();
if (analyticsToken) secrets.CF_ANALYTICS_TOKEN = analyticsToken;
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

const res = await fetch(`https://api.telegram.org/bot${secrets.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: `${url}/telegram/webhook`,
    secret_token: secrets.TELEGRAM_WEBHOOK_SECRET,
    // edited_message не подписываем: игнорируется, но тратил бы квоты
    // inline_query приходит, только если владелец включил inline-режим в @BotFather: /setinline
    allowed_updates: ["message", "callback_query", "inline_query", "my_chat_member"],
    // Не сбрасываем: после неудачного деплоя там как раз ждут сообщения пользователей
    drop_pending_updates: false,
  }),
});
const tg = (await res.json()) as { ok: boolean; description?: string };
if (!tg.ok) throw new Error(`setWebhook failed: ${tg.description}`);

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
