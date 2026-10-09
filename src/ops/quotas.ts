// Остатки квот провайдеров и платформы Cloudflare для /admin/quotas и алерта quota_low (docs/admin-console.md, «Квоты»):
// бесплатные эндпоинты остатков (OpenRouter /key, DeepSeek /user/balance, GraphQL Analytics — Workers AI, Workers, D1,
// Queues), заголовки последних настоящих вызовов и оценки по журналу. Квоту моделей не тратит. Ответы API — в кеше ops_state минуту; сбой одного провайдера
// не ломает остальные. Адреса — из цепочек провайдеров конфигурации (ADR-0006), ключи на страницу не попадают.

import type { AppContext } from "../bot/context";
import { getOpsState, loadRateHeaders, type SeenRateHeaders, saveRateHeaders, setOpsState } from "../db/ops-state";
import { usageTodayByProvider } from "../db/usage";
import { fetchWithTimeout } from "../net/fetch";
import type { SeenHeaders } from "../nlu/intents";
import {
  type CfPlan,
  cfWindow,
  d1Query,
  d1Rows,
  GEMINI_RESET_TZ,
  geminiRow,
  groqAudioRow,
  groqRows,
  neuronsFromCost,
  neuronsQuery,
  parseDeepSeekBalance,
  parseD1,
  parseNeurons,
  parseOpenRouterKey,
  parseQueues,
  parseWorkers,
  type QuotaRow,
  queuesQuery,
  queuesRows,
  utcDayStart,
  workersAiRow,
  workersQuery,
  workersRows,
  zoneDay,
} from "./quota-rules";

const CACHE_KEY = "quota_probe";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 3_000;
const ESTIMATE_NOTE =
  "оценка по журналу бота (стоимость вызовов Workers AI ÷ $0.011 за 1000 neurons); вызовы скриптов замеров и других Worker'ов аккаунта не видны. " +
  "Точно — если у токена аналитики (CF_ANALYTICS_TOKEN или LLM_API_KEY) есть право Account Analytics: Read";
const NO_ACCESS_HINT = " — токену CF_ANALYTICS_TOKEN (или LLM_API_KEY) нужно право Account Analytics: Read";

export interface QuotaProbe {
  provider: string;
  rows: QuotaRow[];
  /** Не удалось получить (текст без ключей). */
  error?: string;
  /** Провайдер не подключён — почему. */
  off?: string;
}

export interface QuotaReport {
  now: number;
  /** Когда запрошены API (кеш минуту). */
  fetchedAt: number;
  cached: boolean;
  probes: QuotaProbe[];
  headers: SeenRateHeaders[];
  /** Тариф Workers из конфигурации (vars.CF_WORKERS_PLAN); null — аккаунт Cloudflare неизвестен. */
  cfPlan: CfPlan | null;
}

/** Ответ API или ошибка — то, что лежит в кеше. */
type Got = { ok: true; json: unknown } | { ok: false; error: string };
/** cloudflare — neurons Workers AI; cf_* — платформа (Workers, D1, Queues). */
const SOURCES = ["openrouter", "deepseek", "cloudflare", "cf_workers", "cf_d1", "cf_queues"] as const;
type Fetched = Partial<Record<(typeof SOURCES)[number], Got>>;

interface Endpoint {
  url: string;
  init: RequestInit;
}

function endpoints(ctx: AppContext): Partial<Record<keyof Fetched, Endpoint>> & { keys: string[] } {
  const all = [...ctx.config.llm, ...ctx.config.stt, ...ctx.config.voice];
  const byName = (name: string) => all.find((c) => c.name === name);
  const keys = all.map((c) => c.apiKey).filter((k) => k && k.length >= 4);
  const auth = (key: string): RequestInit => ({ method: "GET", headers: { authorization: `Bearer ${key}` } });
  const out: Partial<Record<keyof Fetched, Endpoint>> & { keys: string[] } = { keys };
  const or = byName("openrouter");
  if (or) out.openrouter = { url: `${or.baseUrl.replace(/\/+$/, "")}/key`, init: auth(or.apiKey) };
  const ds = byName("deepseek");
  if (ds) out.deepseek = { url: `${ds.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/user/balance`, init: auth(ds.apiKey) };
  const cf = ctx.config.cloudflare;
  if (cf) {
    out.keys.push(cf.apiKey);
    const now = ctx.clock.now();
    const from = cfWindow(cf.plan, now).from;
    const gql = (body: string): Endpoint => ({
      url: cf.graphqlUrl,
      init: { method: "POST", headers: { authorization: `Bearer ${cf.apiKey}`, "content-type": "application/json" }, body },
    });
    // neurons — только если Workers AI в цепочках: страница о нём молчит, если его нет
    if (all.some((c) => c.name === "workers-ai")) out.cloudflare = gql(neuronsQuery(cf.accountTag, utcDayStart(now), now));
    out.cf_workers = gql(workersQuery(cf.accountTag, from, now));
    out.cf_d1 = gql(d1Query(cf.accountTag, from, now));
    out.cf_queues = gql(queuesQuery(cf.accountTag, from, now));
  }
  return out;
}

/** Ключ в тексте ошибки (URL, эхо провайдера) — на страницу и в алерт не попадает. */
function scrub(s: string, keys: string[]): string {
  return keys.reduce((t, k) => t.split(k).join("<key>"), s).slice(0, 200);
}

async function getJson(e: Endpoint, keys: string[]): Promise<Got> {
  try {
    const res = await fetchWithTimeout(e.url, e.init, TIMEOUT_MS);
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const j = json as { error?: { message?: string } | string; errors?: { message?: string }[]; message?: string } | null;
      const msg = typeof j?.error === "string" ? j.error : (j?.error?.message ?? j?.errors?.[0]?.message ?? j?.message ?? "");
      return { ok: false, error: scrub(`HTTP ${res.status}${msg ? `: ${msg}` : ""}`, keys) };
    }
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: scrub(String(e instanceof Error ? e.message : e), keys) };
  }
}

async function fetchAll(ctx: AppContext, now: number): Promise<{ fetched: Fetched; fetchedAt: number; cached: boolean }> {
  const cached = await getOpsState(ctx.db, CACHE_KEY);
  if (cached && now >= cached.updated_at && now - cached.updated_at < CACHE_MS) {
    try {
      return { fetched: JSON.parse(cached.value) as Fetched, fetchedAt: cached.updated_at, cached: true };
    } catch {
      // битый кеш — запросим заново
    }
  }
  const ep = endpoints(ctx);
  const names = SOURCES.filter((n) => ep[n]);
  const got = await Promise.all(names.map((n) => getJson(ep[n]!, ep.keys)));
  const fetched: Fetched = Object.fromEntries(names.map((n, i) => [n, got[i]]));
  await setOpsState(ctx.db, CACHE_KEY, JSON.stringify(fetched), now);
  return { fetched, fetchedAt: now, cached: false };
}

/** Разбор ответа: неожиданный формат — ошибка провайдера, а не падение страницы. */
function rowsOf(provider: string, got: Got | undefined, parse: (json: unknown) => QuotaRow[], prefix = ""): QuotaProbe {
  if (!got) return { provider, rows: [] };
  const fail = (msg: string) => ({ provider, rows: [], error: prefix ? gqlError(prefix + msg) : msg });
  if (!got.ok) return fail(got.error);
  try {
    return { provider, rows: parse(got.json) };
  } catch (e) {
    return fail(String(e instanceof Error ? e.message : e).slice(0, 200));
  }
}

/** Ошибка доступа GraphQL — с подсказкой, какое право дать токену. */
const gqlError = (msg: string) => (/not authorized|authorization denied|permission/i.test(msg) ? msg + NO_ACCESS_HINT : msg);

export async function quotaReport(ctx: AppContext): Promise<QuotaReport> {
  const now = ctx.clock.now();
  const utcStart = utcDayStart(now);
  const pt = zoneDay(now, GEMINI_RESET_TZ);
  const [{ fetched, fetchedAt, cached }, today, headers] = await Promise.all([
    fetchAll(ctx, now),
    usageTodayByProvider(ctx.db, utcStart, pt.start),
    loadRateHeaders(ctx.db),
  ]);
  const usage = new Map(today.map((u) => [u.provider, u]));
  const { llm, stt, voice } = ctx.config;
  const has = (list: { name?: string }[], name: string) => list.some((c) => c.name === name);
  const probes: QuotaProbe[] = [];

  probes.push(
    has([...llm, ...voice], "openrouter")
      ? rowsOf("OpenRouter", fetched.openrouter, (j) => parseOpenRouterKey(j, fetchedAt, usage.get("openrouter")?.n_utc ?? 0))
      : { provider: "OpenRouter", rows: [], off: "нет в LLM_CHAIN (OPENROUTER_API_KEY не задан)" },
  );
  probes.push(
    has(llm, "deepseek")
      ? rowsOf("DeepSeek", fetched.deepseek, (j) => parseDeepSeekBalance(j, fetchedAt))
      : { provider: "DeepSeek", rows: [], off: "нет в LLM_CHAIN: включается LLM_PRIMARY=deepseek при деплое" },
  );

  if (has([...llm, ...stt], "workers-ai")) {
    const estimate = neuronsFromCost(usage.get("workers-ai")?.cost_utc ?? 0);
    const ai = fetched.cloudflare;
    let probe: QuotaProbe;
    if (ai?.ok) {
      try {
        probe = { provider: "Workers AI", rows: [workersAiRow(parseNeurons(ai.json), "api", fetchedAt, `по журналу бота ≈ ${Math.round(estimate)}`)] };
      } catch (e) {
        probe = {
          provider: "Workers AI",
          rows: [workersAiRow(estimate, "estimate", now, ESTIMATE_NOTE)],
          error: gqlError(`GraphQL: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`),
        };
      }
    } else {
      probe = {
        provider: "Workers AI",
        rows: [workersAiRow(estimate, "estimate", now, ESTIMATE_NOTE)],
        ...(ai ? { error: gqlError(`GraphQL: ${ai.error}`) } : {}),
      };
    }
    probes.push(probe);
  }

  // Платформа Cloudflare: Workers, D1, Queues — по строке ошибки на продукт
  const cf = ctx.config.cloudflare;
  if (cf) {
    probes.push(rowsOf("Workers", fetched.cf_workers, (j) => workersRows(parseWorkers(j, cf.scriptName), cf.plan, cf.scriptName, fetchedAt), "GraphQL: "));
    probes.push(rowsOf("D1", fetched.cf_d1, (j) => d1Rows(parseD1(j), cf.plan, fetchedAt), "GraphQL: "));
    probes.push(rowsOf("Queues", fetched.cf_queues, (j) => queuesRows(parseQueues(j), cf.plan, fetchedAt), "GraphQL: "));
  } else probes.push({ provider: "Workers, D1, Queues", rows: [], off: "аккаунт Cloudflare неизвестен: нет звена Workers AI с адресом api.cloudflare.com" });

  if (has(stt, "groq")) {
    const seen = headers.find((h) => h.provider === "groq");
    probes.push({ provider: "Groq", rows: [...(seen ? groqRows(seen.headers, seen.at) : []), groqAudioRow(usage.get("groq")?.audio_ms_utc ?? 0, now)] });
  }

  const geminiNames = new Set(voice.filter((c) => c.kind === "gemini").map((c) => c.name ?? c.baseUrl));
  if (geminiNames.size) {
    const calls = [...geminiNames].reduce((a, n) => a + (usage.get(n)?.n_alt ?? 0), 0);
    probes.push({ provider: "Gemini", rows: [geminiRow(calls, now)] });
  } else probes.push({ provider: "Gemini", rows: [], off: "VOICE_CHAIN пуст (GEMINI_API_KEY не задан)" });

  return { now, fetchedAt, cached, probes, headers, cfPlan: cf?.plan ?? null };
}

/** Строки всех провайдеров — для алерта. */
export const quotaRows = (r: QuotaReport) => r.probes.flatMap((p) => p.rows);

/** Сохранить заголовки лимитов, увиденные цепочкой, — по записи на провайдера. Сбой записи не мешает ответу пользователю. */
export async function rememberRateHeaders(ctx: AppContext, seen: SeenHeaders[]): Promise<void> {
  if (seen.length === 0) return;
  try {
    const now = ctx.clock.now();
    await Promise.all(seen.map((s) => saveRateHeaders(ctx.db, s.provider, s.headers, s.status, now)));
  } catch (e) {
    console.warn("rate headers not saved", e instanceof Error ? e.message : e);
  }
}
