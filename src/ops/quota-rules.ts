// Чистые функции: ответ API, заголовки лимитов или журнал → строки панели и алерта. Ключей и их меток (label) здесь
// нет и быть не должно.

import { localToUtc, utcToLocal } from "../dates/calendar";

const DAY_MS = 86_400_000;

// estimate — по нашему журналу, не по данным провайдера.
export type QuotaSource = "api" | "headers" | "estimate";
export type QuotaLevel = "ok" | "warn" | "crit" | "unknown";

export interface QuotaRow {
  provider: string;
  metric: string;
  remaining: number | null;
  limit: number | null;
  used?: number | null;
  unit: string;
  resetAt: number | null;
  source: QuotaSource;
  at: number | null;
  level: QuotaLevel;
  alert?: boolean;
  note?: string;
}

export const WARN_SHARE = 0.2;
// Из 50 бесплатных в сутки (без покупки кредитов).
export const OPENROUTER_FREE_ALERT = 10;
export const DEEPSEEK_ALERT_USD = 1;
const CNY_PER_USD = 7;
// На аккаунт, сброс в 00:00 UTC (по документации).
export const WORKERS_AI_FREE_NEURONS = 10_000;
export const WORKERS_AI_ALERT_SHARE = 0.8;
// $0.011 за 1000 neurons; должен совпадать с прайсом COST_ESTIMATES в config.ts.
export const NEURON_MICRO_USD = 11;
// Groq Free, whisper-large-v3-turbo, на 2026-10; на других тарифах больше.
export const GROQ_FREE_AUDIO_SEC_DAY = 28_800;
export const GEMINI_RESET_TZ = "America/Los_Angeles";

export const utcDayStart = (now: number) => now - (now % DAY_MS);
export const nextUtcMidnight = (now: number) => utcDayStart(now) + DAY_MS;

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

// free_model_daily_requests — за сутки UTC: 50 без покупки кредитов, 1000 — после ≥ $10. Нет поля (старый ответ) —
// лимит по is_free_tier, расход — по журналу.
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

// Иной адрес, чем …/client/v4/accounts/<id>/ai (фейк в тестах), — null.
export function cloudflareGraphql(baseUrl: string): { url: string; accountTag: string } | null {
  const m = /^(https:\/\/[^/]+)\/client\/v4\/accounts\/([0-9a-f]{16,64})\/ai(?:\/|$)/.exec(baseUrl);
  return m ? { url: `${m[1]}/client/v4/graphql`, accountTag: m[2]! } : null;
}

export function neuronsQuery(accountTag: string, from: number, to: number): string {
  return JSON.stringify({
    query: `query($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: {accountTag: $a}) {
      aiInferenceAdaptiveGroups(limit: 100, filter: {datetime_geq: $from, datetime_leq: $to}) { dimensions { modelId } sum { totalNeurons } } } } }`,
    variables: { a: accountTag, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
  });
}

// errors (нет права Account Analytics: Read, неизвестное поле) — исключение с текстом: строка панели покажет причину.
export function gqlAccount(json: unknown): Record<string, unknown> {
  const j = json as { data?: { viewer?: { accounts?: Record<string, unknown>[] } } | null; errors?: { message?: string }[] | null } | null;
  if (j?.errors?.length) throw new Error(String(j.errors[0]?.message ?? "graphql error").slice(0, 200));
  const accounts = j?.data?.viewer?.accounts;
  if (!Array.isArray(accounts)) throw new Error("неожиданный ответ GraphQL");
  return accounts[0] ?? {};
}

type Groups = { dimensions?: Record<string, unknown>; sum?: Record<string, unknown>; max?: Record<string, unknown>; quantiles?: Record<string, unknown> }[];
const groups = (acc: Record<string, unknown>, name: string): Groups => (Array.isArray(acc[name]) ? (acc[name] as Groups) : []);
const sumOf = (gs: Groups, part: "sum" | "max", field: string) => gs.reduce((a, g) => a + (num(g[part]?.[field]) ?? 0), 0);

export function parseNeurons(json: unknown): number {
  return sumOf(groups(gqlAccount(json), "aiInferenceAdaptiveGroups"), "sum", "totalNeurons");
}

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

// Через GraphQL тариф не узнать, а REST /subscriptions требует права Billing — поэтому vars.CF_WORKERS_PLAN.
export type CfPlan = "free" | "paid";

// developers.cloudflare.com, 2026-10: Free — в сутки, сброс 00:00 UTC; Paid — включено в месяц (сверх — платно,
// не отказ). cpuMs — на один вызов.
export const CF_LIMITS = {
  free: { requests: 100_000, cpuMs: 10, d1Read: 5_000_000, d1Write: 100_000, d1Bytes: 5e9, queueOps: 10_000 },
  paid: { requests: 10_000_000, cpuMs: 30_000, d1Read: 25_000_000_000, d1Write: 50_000_000, d1Bytes: 5e9, queueOps: 1_000_000 },
} as const satisfies Record<CfPlan, Record<string, number>>;

export const CF_ALERT_SHARE = 0.8;

const MB = 1_000_000;

// Paid — календарный месяц UTC, хотя цикл оплаты может начинаться с другого числа.
export function cfWindow(plan: CfPlan, now: number): { from: number; reset: number; label: string } {
  if (plan === "free") return { from: utcDayStart(now), reset: nextUtcMidnight(now), label: "в сутки" };
  const d = new Date(now);
  return { from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), reset: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), label: "в месяц (включено)" };
}

const isoDate = (t: number) => new Date(t).toISOString().slice(0, 10);

export function workersQuery(accountTag: string, from: number, to: number): string {
  return JSON.stringify({
    query: `query($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: {accountTag: $a}) {
      workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: $from, datetime_leq: $to}) {
        dimensions { scriptName } sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 } } } } }`,
    variables: { a: accountTag, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
  });
}

// Размер баз — за последние сутки: метрика хранилища дневная.
export function d1Query(accountTag: string, from: number, to: number): string {
  return JSON.stringify({
    query: `query($a: String!, $from: Date!, $to: Date!, $sfrom: Date!) { viewer { accounts(filter: {accountTag: $a}) {
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: {date_geq: $from, date_leq: $to}) {
        dimensions { databaseId } sum { rowsRead rowsWritten readQueries writeQueries } }
      d1StorageAdaptiveGroups(limit: 1000, filter: {date_geq: $sfrom, date_leq: $to}) { dimensions { databaseId } max { databaseSizeBytes } } } } }`,
    variables: { a: accountTag, from: isoDate(from), to: isoDate(to), sfrom: isoDate(to - DAY_MS) },
  });
}

export function queuesQuery(accountTag: string, from: number, to: number): string {
  return JSON.stringify({
    query: `query($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: {accountTag: $a}) {
      queueMessageOperationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $from, datetime_leq: $to}) {
        dimensions { actionType } sum { billableOperations } } } } }`,
    variables: { a: accountTag, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
  });
}

export interface WorkersStats {
  requests: number;
  errors: number;
  scripts: number;
  ours: { requests: number; errors: number; subrequests: number; cpuP50Ms: number | null; cpuP99Ms: number | null } | null;
}

export function parseWorkers(json: unknown, scriptName: string): WorkersStats {
  const gs = groups(gqlAccount(json), "workersInvocationsAdaptive");
  const mine = gs.filter((g) => g.dimensions?.scriptName === scriptName);
  const ms = (v: unknown) => {
    const n = num(v);
    return n === null ? null : n / 1000;
  };
  const maxQ = (field: string) =>
    mine.reduce<number | null>((a, g) => {
      const v = ms(g.quantiles?.[field]);
      return v === null ? a : Math.max(a ?? 0, v);
    }, null);
  return {
    requests: sumOf(gs, "sum", "requests"),
    errors: sumOf(gs, "sum", "errors"),
    scripts: new Set(gs.map((g) => String(g.dimensions?.scriptName ?? "?"))).size,
    ours: mine.length
      ? {
          requests: sumOf(mine, "sum", "requests"),
          errors: sumOf(mine, "sum", "errors"),
          subrequests: sumOf(mine, "sum", "subrequests"),
          cpuP50Ms: maxQ("cpuTimeP50"),
          cpuP99Ms: maxQ("cpuTimeP99"),
        }
      : null,
  };
}

export interface D1Stats {
  rowsRead: number;
  rowsWritten: number;
  queries: number;
  databases: number;
  bytes: number | null;
}

export function parseD1(json: unknown): D1Stats {
  const acc = gqlAccount(json);
  const a = groups(acc, "d1AnalyticsAdaptiveGroups");
  const st = groups(acc, "d1StorageAdaptiveGroups");
  const size = new Map<string, number>();
  for (const g of st) {
    const id = String(g.dimensions?.databaseId ?? "?");
    size.set(id, Math.max(size.get(id) ?? 0, num(g.max?.databaseSizeBytes) ?? 0));
  }
  return {
    rowsRead: sumOf(a, "sum", "rowsRead"),
    rowsWritten: sumOf(a, "sum", "rowsWritten"),
    queries: sumOf(a, "sum", "readQueries") + sumOf(a, "sum", "writeQueries"),
    databases: new Set([...a, ...st].map((g) => String(g.dimensions?.databaseId ?? "?"))).size,
    bytes: st.length ? [...size.values()].reduce((x, y) => x + y, 0) : null,
  };
}

export interface QueueStats {
  ops: number;
  byAction: Record<string, number>;
}

export function parseQueues(json: unknown): QueueStats {
  const gs = groups(gqlAccount(json), "queueMessageOperationsAdaptiveGroups");
  const byAction: Record<string, number> = {};
  for (const g of gs) {
    const k = String(g.dimensions?.actionType ?? "?");
    byAction[k] = (byAction[k] ?? 0) + (num(g.sum?.billableOperations) ?? 0);
  }
  return { ops: Object.values(byAction).reduce((a, b) => a + b, 0), byAction };
}

const planNote = (plan: CfPlan) => (plan === "free" ? "тариф Workers Free" : "тариф Workers Paid: сверх включённого — платно");

function usageRow(provider: string, metric: string, used: number, limit: number, unit: string, resetAt: number | null, at: number, note: string): QuotaRow {
  const left = Math.max(0, limit - used);
  return {
    provider,
    metric,
    remaining: left,
    limit,
    used,
    unit,
    resetAt,
    source: "api",
    at,
    level: shareLevel(left, limit),
    alert: used > limit * CF_ALERT_SHARE,
    note,
  };
}

const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0%");

export function workersRows(s: WorkersStats, plan: CfPlan, scriptName: string, at: number): QuotaRow[] {
  const L = CF_LIMITS[plan];
  const w = cfWindow(plan, at);
  const ours = s.ours
    ? `${scriptName}: ${s.ours.requests} (ошибок ${s.ours.errors}, ${pct(s.ours.errors, s.ours.requests)}; подзапросов ${s.ours.subrequests})`
    : `${scriptName}: запросов не было`;
  const rows = [
    usageRow(
      "Workers",
      `Запросов ${w.label} (аккаунт, все Worker'ы)`,
      s.requests,
      L.requests,
      "запр.",
      w.reset,
      at,
      `${planNote(plan)}; Worker'ов: ${s.scripts}, ошибок всего ${s.errors}; ${ours}. Считаются и cron, и очередь`,
    ),
  ];
  const p99 = s.ours?.cpuP99Ms ?? null;
  if (p99 !== null) {
    // Лимит CPU — на один вызов: «осталось» — запас p99 до лимита. Выше лимита — жёлтый, не красный: Cloudflare
    // допускает всплески (2026-10-09 на Free p99 25.8 мс при 0 ошибок); оборванные вызовы видны в ошибках
    const left = Math.max(0, L.cpuMs - p99);
    const level = shareLevel(left, L.cpuMs);
    rows.push({
      provider: "Workers",
      metric: `CPU на вызов, p99 (${scriptName})`,
      remaining: Math.round(left * 10) / 10,
      limit: L.cpuMs,
      used: Math.round(p99 * 10) / 10,
      unit: "мс",
      resetAt: null,
      source: "api",
      at,
      level: level === "crit" ? "warn" : level,
      note: `p50 ${s.ours?.cpuP50Ms === null || s.ours?.cpuP50Ms === undefined ? "?" : s.ours.cpuP50Ms.toFixed(1)} мс; лимит — на один вызов (${plan === "free" ? "Free: 10 мс" : "Paid: 30 с по умолчанию"}), ожидание сети не считается`,
    });
  }
  return rows;
}

export function d1Rows(s: D1Stats, plan: CfPlan, at: number): QuotaRow[] {
  const L = CF_LIMITS[plan];
  const w = cfWindow(plan, at);
  const note = `${planNote(plan)}; баз: ${s.databases}, запросов ${s.queries}; превышение на Free — запросы к D1 отклоняются до 00:00 UTC`;
  const rows = [
    usageRow("D1", `Строк прочитано ${w.label} (аккаунт)`, s.rowsRead, L.d1Read, "строк", w.reset, at, note),
    usageRow("D1", `Строк записано ${w.label} (аккаунт)`, s.rowsWritten, L.d1Write, "строк", w.reset, at, note),
  ];
  if (s.bytes !== null) {
    const usedMb = Math.round((s.bytes / MB) * 10) / 10;
    const limitMb = Math.round(L.d1Bytes / MB);
    rows.push({ ...usageRow("D1", "Хранилище (все базы)", usedMb, limitMb, "МБ", null, at, "размер баз за последние сутки; 5 ГБ на аккаунт"), alert: false });
  }
  return rows;
}

export function queuesRows(s: QueueStats, plan: CfPlan, at: number): QuotaRow[] {
  const L = CF_LIMITS[plan];
  const w = cfWindow(plan, at);
  const parts = Object.entries(s.byAction)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    usageRow(
      "Queues",
      `Операций ${w.label} (аккаунт)`,
      s.ops,
      L.queueOps,
      "опер.",
      w.reset,
      at,
      `${planNote(plan)}; ${parts || "операций не было"}; сообщение = запись + чтение + удаление, повтор — ещё чтение`,
    ),
  ];
}

// Формат Groq: «2m59.56s», «7.66s», «1h2m3s», «250ms».
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

// У Groq x-ratelimit-*-requests — запросы в СУТКИ (RPD), а *-tokens — в минуту. Числа — на момент того вызова.
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

// Оценка: окно Groq может быть скользящим, а мы считаем сутки UTC.
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

export function lowQuotas(rows: QuotaRow[]): string[] {
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
  return rows
    .filter((r) => r.alert)
    .map((r) => `${r.provider}: ${r.remaining === null ? "?" : n(r.remaining)} ${r.unit}${r.limit === null ? "" : ` из ${n(r.limit)}`}`);
}
