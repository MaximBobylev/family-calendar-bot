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
// Платная Gemma 4 26B — лучшая в замерах (97,3% полей, 2026-10-05), ≈ $0.0002 за команду; бесплатный Nemotron — запасной
const OPENROUTER_DEFAULT = "google/gemma-4-26b-a4b-it,nvidia/nemotron-3-super-120b-a12b:free";
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
console.log(`\nLLM: ${llmChain.map((c) => `${c.name} (${c.model})`).join(" → ")}`);
console.log(`STT: ${sttChain.map((c) => `${c.name} (${c.model})`).join(" → ")}`);

const secrets: Record<string, string> = {
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
};
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
    allowed_updates: ["message", "callback_query"],
    // Не сбрасываем: после неудачного деплоя там как раз ждут сообщения пользователей
    drop_pending_updates: false,
  }),
});
const tg = (await res.json()) as { ok: boolean; description?: string };
if (!tg.ok) throw new Error(`setWebhook failed: ${tg.description}`);

// 5. Меню команд Telegram (кнопка «/» в чате)
const commands = {
  ru: [
    { command: "settings", description: "Настройки" },
    { command: "connect", description: "Подключить или переподключить Google" },
    { command: "disconnect", description: "Отключить календарь и удалить данные" },
  ],
  en: [
    { command: "settings", description: "Settings" },
    { command: "connect", description: "Connect or reconnect Google" },
    { command: "disconnect", description: "Disconnect calendar and delete data" },
  ],
};
for (const [lang, list] of [
  ["", commands.ru],
  ["ru", commands.ru],
  ["en", commands.en],
] as const) {
  const r = await fetch(`https://api.telegram.org/bot${secrets.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: list, ...(lang ? { language_code: lang } : {}) }),
  });
  const body = (await r.json()) as { ok: boolean; description?: string };
  if (!body.ok) console.warn(`setMyCommands (${lang || "default"}) failed: ${body.description}`);
}

console.log(`\n✅ Deployed: ${url}`);
console.log(`   Telegram webhook: ${url}/telegram/webhook`);
console.log(`   Google OAuth redirect URI: ${url}/oauth/google/callback`);
