// Проверка интентов на реальной LLM (Workers AI) — ручной запуск, не тест:
//   docker compose run --rm test npx tsx scripts/probe-intents.ts "фраза" ...
import { parseIntent } from "../src/nlu/intents";

const cfg = {
  baseUrl: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
  apiKey: process.env.LLM_API_KEY ?? "",
  model: process.env.LLM_MODEL ?? "@cf/qwen/qwen3-30b-a3b-fp8",
};
const phrases = process.argv.slice(2);
for (const text of phrases) {
  const t0 = Date.now();
  try {
    const r = await parseIntent(cfg, text, { calendars: ["Иван", "Семья", "Праздники"] });
    console.log(`${Date.now() - t0}ms  ${text}  →  ${JSON.stringify(r.intent)}`);
  } catch (e) {
    console.log(`ERR ${text}: ${e}`);
  }
}
