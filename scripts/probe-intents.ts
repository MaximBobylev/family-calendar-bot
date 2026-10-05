// Проверка интентов на реальной LLM — ручной запуск, не тест (нужны ключи из .env → сервис deploy):
//   docker compose run --rm --entrypoint npx deploy tsx scripts/probe-intents.ts [--provider openrouter|workers-ai] "фраза" ...
// По умолчанию — OpenRouter, если задан OPENROUTER_API_KEY, иначе Workers AI (как цепочка в scripts/deploy.ts).
import { parseIntent } from "../src/nlu/intents";
import type { LlmConfig } from "../src/nlu/llm";

const args = process.argv.slice(2);
const flag = args.indexOf("--provider");
const provider = flag >= 0 ? args.splice(flag, 2)[1] : process.env.OPENROUTER_API_KEY ? "openrouter" : "workers-ai";

const cfg: LlmConfig =
  provider === "openrouter"
    ? {
        name: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY ?? "",
        model: process.env.OPENROUTER_MODEL || "google/gemma-4-26b-a4b-it:free",
        extraBody: { reasoning: { enabled: false } },
      }
    : {
        name: "workers-ai",
        baseUrl: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
        apiKey: process.env.LLM_API_KEY ?? "",
        model: process.env.LLM_MODEL ?? "@cf/qwen/qwen3-30b-a3b-fp8",
      };
console.log(`provider: ${cfg.name} (${cfg.model})`);
for (const text of args) {
  const t0 = Date.now();
  try {
    const r = await parseIntent(cfg, text, { calendars: ["Иван", "Семья", "Праздники"] });
    console.log(`${Date.now() - t0}ms  ${text}  →  ${JSON.stringify(r.intent)}`);
  } catch (e) {
    console.log(`ERR ${text}: ${String(e).slice(0, 300)}`);
  }
}
