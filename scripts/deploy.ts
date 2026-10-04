// Деплой в Cloudflare. Запуск: docker compose run --rm test npm run deploy:prod
// Значения берутся из окружения (.env подключается compose). Секреты в вывод не печатаются.
//
// 1. Миграции D1 (remote)
// 2. wrangler deploy → адрес Worker'а
// 3. Секреты Worker'а (wrangler secret bulk); PUBLIC_BASE_URL и LLM_BASE вычисляются
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

// 1. Миграции
wrangler(["d1", "migrations", "apply", "DB", "--remote"]);

// 2. Деплой кода
const out = wrangler(["deploy"], { capture: true });
const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0];
if (!url) throw new Error("could not find workers.dev URL in wrangler deploy output");

// 3. Секреты
const secrets: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: need("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_WEBHOOK_SECRET: need("TELEGRAM_WEBHOOK_SECRET"),
  ALLOWED_TELEGRAM_IDS: need("ALLOWED_TELEGRAM_IDS"),
  TOKEN_ENCRYPTION_KEY: need("TOKEN_ENCRYPTION_KEY"),
  LLM_API_KEY: need("LLM_API_KEY"),
  LLM_BASE: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
  PUBLIC_BASE_URL: url,
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
    allowed_updates: ["message", "edited_message", "callback_query"],
    drop_pending_updates: true,
  }),
});
const tg = (await res.json()) as { ok: boolean; description?: string };
if (!tg.ok) throw new Error(`setWebhook failed: ${tg.description}`);

console.log(`\n✅ Deployed: ${url}`);
console.log(`   Telegram webhook: ${url}/telegram/webhook`);
console.log(`   Google OAuth redirect URI: ${url}/oauth/google/callback`);
