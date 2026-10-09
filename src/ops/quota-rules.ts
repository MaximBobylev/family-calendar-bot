// Остатки квот провайдеров (docs/admin-console.md, «Квоты»): чистые функции — ответ API, заголовки лимитов
// последнего вызова или журнал → строки панели и алерта. Ключей и их меток (label) здесь нет и быть не должно.

import { localToUtc, utcToLocal } from "../dates/calendar";

const DAY_MS = 86_400_000;

/** Откуда число: бесплатный эндпоинт провайдера, заголовки последнего настоящего вызова или наш журнал. */
export type QuotaSource = "api" | "headers" | "estimate";
export type QuotaLevel = "ok" | "warn" | "crit" | "unknown";

export interface QuotaRow {
  provider: string;
  metric: string;
  /** Осталось; null — провайдер не сообщает. */
  remaining: number | null;
  limit: number | null;
  used?: number | null;
  /** «запр.», «$», «neurons», «с аудио», «вызовов». */
  unit: string;
  resetAt: number | null;
  source: QuotaSource;
  /** Когда получены данные (запрос API, вызов с заголовками; для оценки — сейчас). */
  at: number | null;
  level: QuotaLevel;
  /** Ниже порога алерта (src/ops/alert-rules.ts: quota_low). */
  alert?: boolean;
  note?: string;
}

/** Меньше этой доли остатка — жёлтый. */
export const WARN_SHARE = 0.2;
/** OpenRouter: бесплатных запросов на сегодня меньше — алерт (из 50 в сутки без покупки кредитов). */
export const OPENROUTER_FREE_ALERT = 10;
/** DeepSeek: баланс ниже — алерт (USD; для CNY — в 7 раз больше). */
export const DEEPSEEK_ALERT_USD = 1;
const CNY_PER_USD = 7;
/** Workers AI Free: neurons в сутки на аккаунт, сброс в 00:00 UTC (по документации). */
export const WORKERS_AI_FREE_NEURONS = 10_000;
/** Израсходовано больше этой доли — алерт. */
export const WORKERS_AI_ALERT_SHARE = 0.8;
/** Цена neuron у Workers AI: $0.011 за 1000 → 11 микродолларов (COST_ESTIMATES — тот же прайс). */
export const NEURON_MICRO_USD = 11;
/** Groq Free, whisper-large-v3-turbo: секунд аудио в сутки (ASD) — на 2026-10, другие тарифы — больше. */
export const GROQ_FREE_AUDIO_SEC_DAY = 28_800;
/** Бесплатные дневные квоты Gemini сбрасываются в полночь по Тихоокеанскому времени. */
export const GEMINI_RESET_TZ = "America/Los_Angeles";

/** Полночь UTC, начинающая сутки `now`, и следующая. */
export const utcDayStart = (now: number) => now - (now % DAY_MS);
export const nextUtcMidnight = (now: number) => utcDayStart(now) + DAY_MS;

/** Начало суток в поясе и следующая полночь там же. */
export function zoneDay(now: number, tz: string): { start: number; next: number } {
  const day = utcToLocal(now, tz).day;
  return { start: localToUtc({ day, minutes: 0 }, tz), next: localToUtc({ day: day + 1, minutes: 0 }, tz) };
}

export function shareLevel(remaining: number | null, limit: number | null): QuotaLevel {
  if (remaining === null || limit === null || limit <= 0) return "unknown";
  if (remaining <= 0) return "crit";
  return remaining / limit < WARN_SHARE ? "warn" : "ok";
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

// --- OpenRouter: GET {base}/key ------------------------------------------------------------------------

/**
 * GET /api/v1/key (openrouter.ai/docs/api-reference/limits): free_model_daily_requests — бесплатные модели за сутки UTC
 * (50 без покупки кредитов, 1000 — после ≥ $10); limit / limit_remaining — лимит ключа в $, если задан.
 * Нет free_model_daily_requests (старый ответ) — лимит по is_free_tier, израсходовано — по журналу (`journalToday`).
 */
export function parseOpenRouterKey(json: unknown, now: number, journalToday: number): QuotaRow[] {
  const d = (json as { data?: Record<string, unknown> } | null)?.data;
  if (!d || typeof d !== "object") throw new Error("неожиданный ответ /key");
  const rows: QuotaRow[] = [];
  const base = { provider: "OpenRouter", at: now };
  const free = d.free_model_daily_requests as { used?: unknown; limit?: unknown; remaining?: unknown } | undefined;
  const freeLimit = num(free?.limit) ?? (d.is_free_tier === false ? 1000 : 50);
  const freeUsed = num(free?.used) ?? journalToday;
  const freeLeft = num(free?.remaining) ?? Math.max(0, freeLimit - freeUsed);
  rows.push({
    ...base,
    metric: "Бесплатные модели (:free), запросов в сутки",
    remaining: freeLeft,
    limit: freeLimit,
    used: freeUsed,
    unit: "запр.",
    resetAt: nextUtcMidnight(now),
    source: free ? "api" : "estimate",
    level: shareLevel(freeLeft, freeLimit),
    alert: freeLeft < OPENROUTER_FREE_ALERT,
    note: `${d.is_free_tier === false ? "кредиты покупались — 1000 в сутки" : "кредиты не покупались — 50 в сутки"}; плюс 20 в минуту`,
  });
  const limit = num(d.limit);
  const spentToday = num(d.usage_daily);
  const spentTotal = num(d.usage);
  const spent = `потрачено сегодня $${(spentToday ?? 0).toFixed(4)}, всего $${(spentTotal ?? 0).toFixed(4)}`;
  if (limit !== null) {
    const left = num(d.limit_remaining);
    rows.push({
      ...base,
      metric: "Лимит ключа, $",
      remaining: left,
      limit,
      unit: "$",
      resetAt: null,
      source: "api",
      level: shareLevel(left, limit),
      note: `${typeof d.limit_reset === "string" ? `сброс: ${d.limit_reset}; ` : "без сброса; "}${spent}`,
    });
  } else {
    rows.push({
      ...base,
      metric: "Платные модели, $",
      remaining: null,
      limit: null,
      unit: "$",
      resetAt: null,
      source: "api",
      level: "unknown",
      note: `лимита у ключа нет; ${spent}`,
    });
  }
  return rows;
}

// --- DeepSeek: GET {base}/user/balance -------------------------------------------------------------------

/** GET /user/balance (api-docs.deepseek.com): is_available и баланс по валютам; лимита нет — порог алерта. */
export function parseDeepSeekBalance(json: unknown, now: number): QuotaRow[] {
  const j = json as {
    is_available?: unknown;
    balance_infos?: { currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }[];
  } | null;
  if (!j || !Array.isArray(j.balance_infos)) throw new Error("неожиданный ответ /user/balance");
  const available = j.is_available !== false;
  const infos = j.balance_infos.length ? j.balance_infos : [{ currency: "USD", total_balance: "0" }];
  return infos.map((b) => {
    const usdLike = b.currency === "CNY" ? DEEPSEEK_ALERT_USD * CNY_PER_USD : DEEPSEEK_ALERT_USD;
    const total = num(b.total_balance);
    const low = !available || total === null || total < usdLike;
    return {
      provider: "DeepSeek",
      metric: `Баланс, ${b.currency ?? "?"}`,
      remaining: total,
      limit: null,
      unit: b.currency === "CNY" ? "¥" : "$",
      resetAt: null,
      source: "api" as const,
      at: now,
      level: low ? "crit" : total < usdLike * 2 ? "warn" : "ok",
      alert: low,
      note: `${available ? "" : "is_available = false — вызовы не пройдут; "}подарочные ${b.granted_balance ?? "?"}, пополненные ${b.topped_up_balance ?? "?"}`,
    };
  });
}

// --- Workers AI: GraphQL Analytics или оценка по журналу ------------------------------------------------------

/** Аккаунт Cloudflare из адреса Workers AI (…/client/v4/accounts/<id>/ai…) → GraphQL того же API; иначе (фейк) — null. */
export function cloudflareGraphql(baseUrl: string): { url: string; accountTag: string } | null {
  const m = /^(https:\/\/[^/]+)\/client\/v4\/accounts\/([0-9a-f]{16,64})\/ai(?:\/|$)/.exec(baseUrl);
  return m ? { url: `${m[1]}/client/v4/graphql`, accountTag: m[2]! } : null;
}

/** Запрос neurons за интервал: набор aiInferenceAdaptiveGroups, сумма totalNeurons по моделям. */
export function neuronsQuery(accountTag: string, from: number, to: number): string {
  return JSON.stringify({
    query: `query($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: {accountTag: $a}) {
      aiInferenceAdaptiveGroups(limit: 100, filter: {datetime_geq: $from, datetime_leq: $to}) { dimensions { modelId } sum { totalNeurons } } } } }`,
    variables: { a: accountTag, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
  });
}

/** Ответ GraphQL → сумма neurons. Ошибка доступа (у токена нет Account Analytics: Read) — исключение с текстом. */
export function parseNeurons(json: unknown): number {
  const j = json as {
    data?: { viewer?: { accounts?: { aiInferenceAdaptiveGroups?: { sum?: { totalNeurons?: unknown } }[] }[] } };
    errors?: { message?: string }[];
  } | null;
  if (j?.errors?.length) throw new Error(String(j.errors[0]?.message ?? "graphql error").slice(0, 200));
  const accounts = j?.data?.viewer?.accounts;
  if (!Array.isArray(accounts)) throw new Error("неожиданный ответ GraphQL");
  return (accounts[0]?.aiInferenceAdaptiveGroups ?? []).reduce((a, g) => a + (num(g.sum?.totalNeurons) ?? 0), 0);
}

/** Оценка neurons по журналу: стоимость вызовов Workers AI считается по прайсу Workers AI (config.ts COST_ESTIMATES). */
export const neuronsFromCost = (costMicroUsd: number) => costMicroUsd / NEURON_MICRO_USD;

export function workersAiRow(usedNeurons: number, source: QuotaSource, now: number, note?: string): QuotaRow {
  const used = Math.round(usedNeurons);
  const left = Math.max(0, WORKERS_AI_FREE_NEURONS - used);
  return {
    provider: "Workers AI",
    metric: "Бесплатные neurons в сутки (аккаунт)",
    remaining: left,
    limit: WORKERS_AI_FREE_NEURONS,
    used,
    unit: "neurons",
    resetAt: nextUtcMidnight(now),
    source,
    at: now,
    level: shareLevel(left, WORKERS_AI_FREE_NEURONS),
    alert: used > WORKERS_AI_FREE_NEURONS * WORKERS_AI_ALERT_SHARE,
    ...(note ? { note } : {}),
  };
}

// --- Заголовки лимитов (Groq и др.) ---------------------------------------------------------------------------

/** Длительность Groq «2m59.56s», «7.66s», «1h2m3s», «250ms» → мс; не разобрали — null. */
export function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  let ms = 0;
  let pos = 0;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    if (m.index !== pos) return null;
    ms += Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
    pos += m[0].length;
  }
  return pos === t.length && pos > 0 ? Math.round(ms) : null;
}

/**
 * Groq (console.groq.com/docs/rate-limits): x-ratelimit-*-requests — запросы в СУТКИ (RPD), *-tokens — токены в минуту.
 * Числа на момент того вызова — с тех пор могли уменьшиться.
 */
export function groqRows(h: Record<string, string>, seenAt: number): QuotaRow[] {
  const get = (k: string) => h[k] ?? h[k.toLowerCase()];
  const limit = num(get("x-ratelimit-limit-requests"));
  const left = num(get("x-ratelimit-remaining-requests"));
  if (limit === null && left === null) return [];
  const reset = parseDuration(get("x-ratelimit-reset-requests"));
  return [
    {
      provider: "Groq",
      metric: "Запросов в сутки (RPD)",
      remaining: left,
      limit,
      unit: "запр.",
      resetAt: reset === null ? null : seenAt + reset,
      source: "headers",
      at: seenAt,
      level: shareLevel(left, limit),
    },
  ];
}

/** Секунды аудио Groq за сутки UTC по журналу против бесплатного ASD — оценка: окно Groq может быть скользящим. */
export function groqAudioRow(audioMsToday: number, now: number): QuotaRow {
  const used = Math.round(audioMsToday / 1000);
  const left = Math.max(0, GROQ_FREE_AUDIO_SEC_DAY - used);
  return {
    provider: "Groq",
    metric: "Секунд аудио в сутки (ASD, бесплатный тариф)",
    remaining: left,
    limit: GROQ_FREE_AUDIO_SEC_DAY,
    used,
    unit: "с аудио",
    resetAt: null,
    source: "estimate",
    at: now,
    level: shareLevel(left, GROQ_FREE_AUDIO_SEC_DAY),
    note: "по журналу с 00:00 UTC; окно сброса Groq не публикует",
  };
}

/** Gemini: API остатка нет, лимит бесплатного тарифа зависит от модели и виден только в AI Studio — показываем расход. */
export function geminiRow(callsToday: number, now: number): QuotaRow {
  return {
    provider: "Gemini",
    metric: "Вызовов сегодня (с 00:00 по Тихоокеанскому)",
    remaining: null,
    limit: null,
    used: callsToday,
    unit: "вызовов",
    resetAt: zoneDay(now, GEMINI_RESET_TZ).next,
    source: "estimate",
    at: now,
    level: "unknown",
    note: "API остатка нет; дневной лимит модели — в AI Studio → Rate limits",
  };
}

/** Что не так — для алерта quota_low: «OpenRouter: 4 запр. из 50». Пусто — всё в порядке. */
export function lowQuotas(rows: QuotaRow[]): string[] {
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
  return rows
    .filter((r) => r.alert)
    .map((r) => `${r.provider}: ${r.remaining === null ? "?" : n(r.remaining)} ${r.unit}${r.limit === null ? "" : ` из ${n(r.limit)}`}`);
}
