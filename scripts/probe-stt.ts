// Проверка распознавания на реальном провайдере — ручной запуск, не тест (ключи из .env → сервис deploy):
//   docker compose run --rm --entrypoint npx deploy tsx scripts/probe-stt.ts [--provider groq|workers-ai] файл.ogg ...
// Файл — OGG/Opus, как голосовое Telegram (синтетику: say -v Milena -o x.aiff "…" && ffmpeg -i x.aiff -c:a libopus x.ogg).
import { readFileSync } from "node:fs";
import { type SttConfig, transcribe } from "../src/stt/whisper";

const args = process.argv.slice(2);
const flag = args.indexOf("--provider");
const provider = flag >= 0 ? args.splice(flag, 2)[1] : process.env.GROQ_API_KEY ? "groq" : "workers-ai";
const cfg: SttConfig =
  provider === "groq"
    ? {
        name: "groq",
        kind: "openai",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: process.env.GROQ_API_KEY ?? "",
        model: process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo",
      }
    : {
        name: "workers-ai",
        kind: "workers-ai",
        baseUrl: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai`,
        apiKey: process.env.LLM_API_KEY ?? "",
        model: "@cf/openai/whisper-large-v3-turbo",
      };
console.log(`provider: ${cfg.name} (${cfg.model})`);
for (const file of args) {
  const t0 = Date.now();
  try {
    const bytes = readFileSync(file);
    const r = await transcribe(cfg, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    console.log(`${Date.now() - t0}ms  ${file}  →  ${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`ERR ${file}: ${String(e).slice(0, 300)}`);
  }
}
