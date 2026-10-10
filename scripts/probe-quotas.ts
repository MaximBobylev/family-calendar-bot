// Остатки квот провайдеров вживую (панель «Квоты»):
//   docker compose run --rm --entrypoint npx deploy tsx scripts/probe-quotas.ts
// Только бесплатные эндпоинты: OpenRouter /key, DeepSeek /user/balance, GraphQL Cloudflare (Workers AI, Workers, D1,
// Queues) — квоту моделей не тратит. CF_WORKERS_PLAN=paid — лимиты Paid (по умолчанию Free).
// Ключи и метки ключей не печатать.
import {
  type CfPlan,
  cfWindow,
  cloudflareGraphql,
  d1Query,
  d1Rows,
  neuronsQuery,
  parseD1,
  parseDeepSeekBalance,
  parseNeurons,
  parseOpenRouterKey,
  parseQueues,
  parseWorkers,
  type QuotaRow,
  queuesQuery,
  queuesRows,
  utcDayStart,
  workersQuery,
  workersRows,
} from "../src/ops/quota-rules";

const env = process.env;
const TOKENS = ["CF_ANALYTICS_TOKEN", "LLM_API_KEY", "CLOUDFLARE_API_TOKEN"];
const keys = ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", ...TOKENS].map((k) => env[k]?.trim() ?? "").filter((k) => k.length >= 4);
const scrub = (s: string) => keys.reduce((t, k) => t.split(k).join("<key>"), s).slice(0, 300);
const now = Date.now(); // скрипт, не логика бота: внедряемых часов здесь нет

function print(rows: QuotaRow[]) {
  for (const r of rows)
    console.log(
      `  ${r.provider} · ${r.metric}: осталось ${r.remaining ?? "—"}${r.limit === null ? "" : ` из ${r.limit}`}${r.used == null ? "" : `, израсходовано ${r.used}`} [${r.source}, ${r.level}]${r.note ? ` — ${r.note}` : ""}`,
    );
}

async function probe(name: string, url: string, init: RequestInit, parse: (json: unknown) => QuotaRow[]) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    const json = (await res.json().catch(() => null)) as unknown;
    console.log(`${name}: HTTP ${res.status}`);
    if (!res.ok) return console.log(`  ошибка: ${scrub(JSON.stringify(json))}`);
    print(parse(json));
  } catch (e) {
    console.log(`${name}: ${scrub(String(e instanceof Error ? e.message : e))}`);
  }
}

const bearer = (k: string): RequestInit => ({ headers: { authorization: `Bearer ${k}` } });
const or = env.OPENROUTER_API_KEY?.trim();
if (or) await probe("OpenRouter /key", "https://openrouter.ai/api/v1/key", bearer(or), (j) => parseOpenRouterKey(j, now, 0));
else console.log("OpenRouter: OPENROUTER_API_KEY не задан");
const ds = env.DEEPSEEK_API_KEY?.trim();
if (ds) await probe("DeepSeek /user/balance", "https://api.deepseek.com/user/balance", bearer(ds), (j) => parseDeepSeekBalance(j, now));
else console.log("DeepSeek: DEEPSEEK_API_KEY не задан");

// GraphQL — теми токенами, что может получить Worker (CF_ANALYTICS_TOKEN, иначе LLM_API_KEY), и токеном деплоя для
// сравнения: так видно, у какого из них есть право Account Analytics: Read
const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
const gql = account ? cloudflareGraphql(`https://api.cloudflare.com/client/v4/accounts/${account}/ai`) : null;
const plan: CfPlan = env.CF_WORKERS_PLAN === "paid" ? "paid" : "free";
const win = cfWindow(plan, now);
const SCRIPT = "calendar-assist-bot";
for (const tokenName of TOKENS) {
  const token = env[tokenName]?.trim();
  if (!gql || !token) continue;
  const post = (body: string): RequestInit => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
  await probe(`Workers GraphQL (${tokenName})`, gql.url, post(workersQuery(gql.accountTag, win.from, now)), (j) =>
    workersRows(parseWorkers(j, SCRIPT), plan, SCRIPT, now),
  );
  await probe(`D1 GraphQL (${tokenName})`, gql.url, post(d1Query(gql.accountTag, win.from, now)), (j) => d1Rows(parseD1(j), plan, now));
  await probe(`Queues GraphQL (${tokenName})`, gql.url, post(queuesQuery(gql.accountTag, win.from, now)), (j) => queuesRows(parseQueues(j), plan, now));
  await probe(
    `Workers AI GraphQL (${tokenName})`,
    gql.url,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: neuronsQuery(gql.accountTag, utcDayStart(now), now),
    },
    (j) => {
      const n = parseNeurons(j);
      return [
        {
          provider: "Workers AI",
          metric: "neurons с 00:00 UTC",
          remaining: 10_000 - n,
          limit: 10_000,
          used: Math.round(n),
          unit: "neurons",
          resetAt: null,
          source: "api",
          at: now,
          level: "unknown",
        },
      ];
    },
  );
}
